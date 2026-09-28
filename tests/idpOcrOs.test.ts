import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { IdpOcrOsEngine, classify, extractFromText, redactIdentifiers, redactFields, fieldsFromDocumentAi, KINDS } = require('../server/integrations/os/idpOcrOsEngine');
const pool = require('../server/integrations/bonds/pgPool');

const saved = { ...process.env };

/** Tiny in-memory idp_documents store driven by the SQL the engine emits. */
function memPool() {
  const docs = new Map<string, any>();
  const events: any[] = [];
  const spy = vi.spyOn(pool, 'query').mockImplementation(async (sql: any, params: any[] = []) => {
    const s = String(sql);
    if (/INSERT INTO idp_events/.test(s)) { events.push({ type: params[2], actor: params[3], detail: JSON.parse(params[4]) }); return { rows: [], rowCount: 1 }; }
    if (/SELECT document_id, status FROM idp_documents WHERE sha256/.test(s)) {
      const hit = [...docs.values()].find((d) => d.sha256 === params[0] && d.status !== 'rejected');
      return { rows: hit ? [hit] : [], rowCount: hit ? 1 : 0 };
    }
    if (/INSERT INTO idp_documents/.test(s)) {
      const [document_id, declared_kind, mime_type, byte_size, sha256, provider, processor, submitted_by] = params;
      docs.set(document_id, { document_id, declared_kind, status: 'received', mime_type, byte_size, sha256, provider, processor, submitted_by, fields: {}, missing_fields: [] });
      return { rows: [], rowCount: 1 };
    }
    if (/^UPDATE idp_documents SET/.test(s.trim())) {
      const doc = docs.get(params[0]);
      const cols = [...s.matchAll(/(\w+) = \$(\d+)/g)];
      for (const [, col, idx] of cols) {
        let v = params[Number(idx) - 1];
        if (col === 'fields' || col === 'missing_fields') v = JSON.parse(v);
        doc[col] = v;
      }
      return { rows: [doc], rowCount: 1 };
    }
    if (/SELECT \* FROM idp_documents WHERE document_id/.test(s)) { const d = docs.get(params[0]); return { rows: d ? [d] : [], rowCount: d ? 1 : 0 }; }
    if (/GROUP BY status/.test(s)) return { rows: [], rowCount: 0 };
    return { rows: [], rowCount: 0 };
  });
  return { docs, events, spy };
}

describe('IDP/OCR OS — pure helpers', () => {
  it('classifies the four trust document kinds from text', () => {
    expect(classify('Vendor invoice #123, amount due, remit to Acme Lawn LLC').kind).toBe('vendor_payout');
    expect(classify('Beneficiary distribution request under the trust for health education maintenance support').kind).toBe('distribution');
    expect(classify('').kind).toBeNull();
    expect(KINDS).toEqual(['distribution', 'disbursement', 'request', 'vendor_payout']);
  });

  it('redacts SSN / EIN / account numbers to last-4 and never returns a full identifier', () => {
    const r = redactIdentifiers('ssn 123-45-6789 ein 12-3456789 acct 123456789012');
    expect(r).toBe('ssn ***-**-6789 ein **-***6789 acct ********9012');
    const f = redactFields({ payee_name: 'Jane', account_number: '000123456789', amount: 12.5 });
    expect(f.account_number).toBe('********6789');
    expect(f.amount).toBe(12.5);
  });

  it('text-only extraction caps confidence at 0.5 so it can never clear the review gate', () => {
    const r = extractFromText('Invoice No: INV-77 Amount due: $1,250.00 Vendor: Acme Lawn LLC');
    expect(r.fields.amount).toBe(1250);
    expect(r.fields.invoice_number).toBe('INV-77');
    expect(r.confidence).toBeLessThanOrEqual(0.5);
  });

  it('maps Document AI entities to fields with the minimum entity confidence', () => {
    const r = fieldsFromDocumentAi({
      text: 'x',
      entities: [
        { type: 'total_amount', mentionText: '$2,000.00', confidence: 0.97 },
        { type: 'supplier_name', mentionText: 'Acme LLC', confidence: 0.91 },
        { type: 'invoice_id', mentionText: 'A-1', confidence: 0.99 },
      ],
    });
    expect(r.fields.amount).toBe(2000);
    expect(r.fields.vendor_name).toBe('Acme LLC');
    expect(r.confidence).toBe(0.91);
  });
});

describe('IDP/OCR OS — lifecycle (no money moves)', () => {
  beforeEach(() => {
    delete process.env.IDP_OCR_PROCESSOR;
    delete process.env.IDP_OCR_BUCKET;
    delete process.env.IDP_OCR_LIVE;
    delete process.env.IDP_OCR_REQUIRE_DISTINCT_APPROVER;
  });
  afterEach(() => { process.env = { ...saved }; vi.restoreAllMocks(); });

  it('text-only ingest lands in needs_review; review → distinct approve → link; same-actor approval refused', async () => {
    const { docs, events } = memPool();
    const doc = await IdpOcrOsEngine.ingest({ text: 'Vendor invoice INV-9 amount due $400.00 remit to Acme LLC', actor: 'trustee.a@family.test' });
    expect(doc.status).toBe('needs_review');
    expect(doc.kind).toBe('vendor_payout');
    expect(doc.provider).toBe('text_only');
    expect(doc.storage_uri).toBeUndefined();
    expect(doc.review_notes).toMatch(/text-only/);

    await expect(IdpOcrOsEngine.approve({ documentId: doc.document_id, actor: 'trustee.b@family.test' })).rejects.toMatchObject({ code: 'IDP_OCR_STATE' });

    const reviewed = await IdpOcrOsEngine.review({ documentId: doc.document_id, fields: { vendor_name: 'Acme LLC', invoice_number: 'INV-9' }, actor: 'Trustee.A@family.test' });
    expect(reviewed.status).toBe('reviewed');
    expect(reviewed.reviewed_by).toBe('trustee.a@family.test');

    await expect(IdpOcrOsEngine.approve({ documentId: doc.document_id, actor: 'trustee.a@family.test' })).rejects.toMatchObject({ code: 'IDP_OCR_SAME_ACTOR' });
    const approved = await IdpOcrOsEngine.approve({ documentId: doc.document_id, actor: 'trustee.b@family.test' });
    expect(approved.status).toBe('approved');

    await expect(IdpOcrOsEngine.link({ documentId: doc.document_id, linkedType: 'stripe_payout', linkedRef: 'x' })).rejects.toMatchObject({ code: 'IDP_OCR_BAD_REQUEST' });
    const linked = await IdpOcrOsEngine.link({ documentId: doc.document_id, linkedType: 'vendor_bill', linkedRef: 'VB-1', actor: 'trustee.b@family.test' });
    expect(linked.status).toBe('linked');
    expect(linked.linked_ref).toBe('VB-1');

    expect(events.map((e) => e.type)).toEqual(['idp.received', 'idp.needs_review', 'idp.reviewed', 'idp.approved', 'idp.linked']);
    expect(JSON.stringify([...docs.values()])).not.toMatch(/remit to Acme/);
  });

  it('review refuses to clear a document whose required fields are still missing', async () => {
    memPool();
    const doc = await IdpOcrOsEngine.ingest({ text: 'distribution to beneficiary', declaredKind: 'distribution', actor: 'a@x' });
    expect(doc.missing_fields).toContain('amount');
    await expect(IdpOcrOsEngine.review({ documentId: doc.document_id, actor: 'a@x' })).rejects.toMatchObject({ code: 'IDP_OCR_INCOMPLETE' });
  });

  it('rejects duplicates by sha256 and unsupported mime types', async () => {
    memPool();
    await IdpOcrOsEngine.ingest({ text: 'same request amount $5', actor: 'a@x' });
    await expect(IdpOcrOsEngine.ingest({ text: 'same request amount $5', actor: 'a@x' })).rejects.toMatchObject({ code: 'IDP_OCR_DUPLICATE' });
    await expect(IdpOcrOsEngine.ingest({ contentBase64: Buffer.from('x').toString('base64'), mimeType: 'application/zip' })).rejects.toMatchObject({ code: 'IDP_OCR_BAD_REQUEST' });
  });

  it('fails closed when a bucket is configured but not writable, and exposes no payout action', async () => {
    memPool();
    process.env.IDP_OCR_BUCKET = 'dlb-idp-private';
    await expect(IdpOcrOsEngine.ingest({ text: 'request amount $5 from Jane', actor: 'a@x' })).rejects.toMatchObject({ code: 'IDP_OCR_STORE' });
    await expect(IdpOcrOsEngine.process({ action: 'payout', documentId: 'x' })).rejects.toMatchObject({ code: 'IDP_OCR_BAD_ACTION' });
  });

  it('readiness is shadow without processor/bucket/live and names each blocker; no processor id is echoed', async () => {
    memPool();
    process.env.IDP_OCR_PROCESSOR = 'projects/1/locations/us/processors/secret-id';
    const r = await IdpOcrOsEngine.readiness();
    expect(r.ready).toBe(false);
    expect(r.mode).toBe('shadow');
    expect(r.blockers.join('\n')).toMatch(/IDP_OCR_BUCKET not set/);
    expect(r.blockers.join('\n')).toMatch(/IDP_OCR_LIVE not true/);
    expect(r.status.processor).not.toMatch(/secret-id/);
    expect(r.status.policy.movesMoney).toBe(false);
  });
});
