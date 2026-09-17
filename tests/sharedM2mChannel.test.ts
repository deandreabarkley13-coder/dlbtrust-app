import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'module';
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';

const require = createRequire(import.meta.url);
const { M2mOsEngine, MANIFEST_SUFFIX } = require('../server/integrations/os/m2mOsEngine');
const { MftOsEngine } = require('../server/integrations/os/mftOsEngine');
const { ACHEngine } = require('../server/integrations/ach/achEngine');
const { SystemSettings } = require('../server/integrations/ach/systemSettings');
const { PayerOsEngine } = require('../server/integrations/os/payerOsEngine');
const { WireHostToHostEngine } = require('../server/integrations/inhouseBank/wire/wireHostToHostEngine');
const { getWireChannelConfig } = require('../server/integrations/inhouseBank/wire/wireHostToHostConfig');

import { type Row, store, fakeBank } from './helpers/m2mFixtures';

/**
 * One M2M partner, one bound MFT channel, both money rails on it: the Payer
 * OS ACH files (direct deposits, vendor bill pay) and the host-to-host
 * settlement-funding wire. MFT_REQUIRE_APPROVAL stays on, so every file
 * still needs a release by someone other than its builder before the
 * machine identity carries it.
 */

const bank = { name: 'Origin Bank', bankName: 'Origin Bank N.A.', host: 'sftp.originbank.test', username: 'dlbtrust-svc', hostKeyFingerprint: 'SHA256:bankbankbankbankbankbankbankbankbankbankbank', createdBy: 'admin@dlb.trust' };
const payee = (over: Row = {}) => ({ routingNumber: '021000021', accountNumber: '123456789', amountCents: 125_000, name: 'Jane Beneficiary', identifier: 'BEN-1', ...over });

const PACS008 = `<?xml version="1.0" encoding="UTF-8"?>
<Document xmlns="urn:iso:std:iso:20022:tech:xsd:pacs.008.001.08">
  <FIToFICstmrCdtTrf>
    <GrpHdr><MsgId>PTCWIRE-IHB-1</MsgId><CreDtTm>2026-02-01T12:00:00Z</CreDtTm><NbOfTxs>1</NbOfTxs><TtlIntrBkSttlmAmt Ccy="USD">2500.00</TtlIntrBkSttlmAmt></GrpHdr>
    <CdtTrfTxInf>
      <PmtId><InstrId>IHB-1</InstrId><EndToEndId>E2E-1</EndToEndId></PmtId>
      <IntrBkSttlmAmt Ccy="USD">2500.00</IntrBkSttlmAmt>
      <CdtrAgt><FinInstnId><ClrSysMmbId><MmbId>121145307</MmbId></ClrSysMmbId></FinInstnId></CdtrAgt>
      <Cdtr><Nm>Melio settlement DDA</Nm></Cdtr>
      <CdtrAcct><Id><Othr><Id>692101092959</Id></Othr></Id></CdtrAcct>
    </CdtTrfTxInf>
  </FIToFICstmrCdtTrf>
</Document>`;

let tmp: string;
const saved = { ...process.env };

async function verifiedPartner() {
  const { partner } = await M2mOsEngine.registerPartner(bank);
  const { partner: after } = await M2mOsEngine.handshake(partner.partnerId, { actor: 'ops@dlb.trust' });
  expect(after.status).toBe('verified');
  process.env.ACH_MFT_CHANNEL = partner.channelId;
  process.env.WIRE_H2H_MFT_CHANNEL = partner.channelId;
  return after;
}

const outboundOf = () => path.join(tmp, bank.host, 'payments', 'outbound');

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'm2m-shared-'));
  process.env.MFT_SPOOL_DIR = path.join(tmp, 'spool');
  process.env.MFT_ARCHIVE_DIR = path.join(tmp, 'archive');
  process.env.PAYMENT_DATA_ENCRYPTION_KEY = crypto.randomBytes(32).toString('hex');
  process.env.M2M_KEY_BITS = '2048';
  process.env.MFT_REQUIRE_APPROVAL = 'true';
  process.env.NODE_ENV = 'production';
  delete process.env.MFT_SFTP_HOST;
  delete process.env.MFT_ALLOW_SPOOL_IN_PRODUCTION;
  delete process.env.M2M_CYCLE_INTERVAL_MS;
  delete process.env.ACH_MFT_CHANNEL;
  delete process.env.ACH_SFTP_URL;
  delete process.env.WIRE_H2H_MFT_CHANNEL;
  delete process.env.WIRE_H2H_SFTP_HOST;
  delete process.env.WIRE_H2H_RAILS;
  vi.spyOn(SystemSettings, 'getMode').mockResolvedValue('production' as any);
});

afterEach(() => {
  M2mOsEngine.stopScheduler();
  vi.restoreAllMocks();
  fs.rmSync(tmp, { recursive: true, force: true });
  process.env = { ...saved };
});

describe('Shared M2M channel — ACH rails and the host-to-host wire on one machine identity', () => {
  it('binds both rails to the verified partner channel and reports both readinesses green over MFT', async () => {
    store();
    fakeBank(tmp);
    const partner = await verifiedPartner();
    expect(partner.channelId).toBe(`m2m-${partner.partnerId}`.toLowerCase());

    expect(ACHEngine.mftChannelId()).toBe(partner.channelId);
    expect(ACHEngine.mftPartnerConfig()).toMatchObject({ protocol: 'mft', mftChannelId: partner.channelId });

    const ach = await PayerOsEngine.achChannel();
    expect(ach).toMatchObject({ via: 'mft', ready: true, transport: 'sftp', mftChannelId: partner.channelId, mode: 'production', reason: null });
    expect(ach.provider).toBe('MFT Origin Bank (M2M) (Origin Bank N.A.)');

    expect(getWireChannelConfig()).toMatchObject({ transport: 'mft', mftChannelId: partner.channelId, rails: ['fedwire'] });
    const wire = WireHostToHostEngine.readiness();
    expect(wire).toMatchObject({ ready: true, transport: 'mft', blockers: [] });
    expect(wire.warnings).toEqual([`Wire files are delivered through MFT channel ${partner.channelId}; its readiness is checked at transmission.`]);

    // The wire engine's live channel is the partner's: host, machine key, layout.
    const live = await WireHostToHostEngine._channel();
    expect(live).toMatchObject({ via: 'mft', transport: 'sftp', host: bank.host, username: bank.username, hostKeyFingerprint: bank.hostKeyFingerprint, outboundPath: '/payments/outbound', ackPath: '/payments/ack', returnPath: '/payments/returns' });
    expect(live.privateKey).toMatch(/BEGIN RSA PRIVATE KEY/);
    expect(live.password).toBe('');
    expect(live.readiness).toEqual({ ready: true, transport: 'sftp', blockers: [] });
    // The engine's own conventions survive the hand-over.
    expect(live).toMatchObject({ filePrefix: 'PTCWIRE', rails: ['fedwire'], ackSlaMinutes: 120 });

    const status = await M2mOsEngine.status();
    expect(status.partners[0]).toMatchObject({ partnerId: partner.partnerId, status: 'verified', channelId: partner.channelId });
    const register = await MftOsEngine.status();
    expect(register.channels.find((c: Row) => c.channelId === partner.channelId).readiness).toEqual({ ready: true, transport: 'sftp', blockers: [] });
    expect(register.policy.requireApproval).toBe(true);
  });

  it('the wire rail is refused by the channel unless WIRE_H2H_RAILS carries it', async () => {
    store();
    fakeBank(tmp);
    await verifiedPartner();
    process.env.WIRE_H2H_RAILS = 'rtp';
    expect(WireHostToHostEngine.readiness().rails).toEqual(['rtp']);
    process.env.WIRE_H2H_RAILS = 'fedwire,rtp';
    expect(WireHostToHostEngine.readiness().rails).toEqual(['fedwire', 'rtp']);
  });

  it('carries the settlement-funding pacs.008 only with a distinct approver, under the machine actor, beside a signed manifest', async () => {
    store();
    fakeBank(tmp);
    const partner = await verifiedPartner();
    const channelId = process.env.WIRE_H2H_MFT_CHANNEL!;
    const wireFile = (approvedBy: string | null, sourceRef = 'wire:IHB-1') => ({
      channelId, fileType: 'wire_payment', format: 'pacs.008', content: PACS008, filename: 'PTCWIRE_20260201T120000_IHB-1.xml',
      sourceRef, builtBy: 'maker@dlb.trust', approvedBy, actor: `machine:${partner.identityId}`,
    });

    // Maker only: the file registers as built but the release gate holds it: nothing reaches the bank.
    await expect(MftOsEngine.deliver(wireFile(null))).rejects.toMatchObject({ code: 'MFT_WRONG_STATE' });
    expect(fs.existsSync(outboundOf()) ? fs.readdirSync(outboundOf()) : []).toEqual([]);
    const [held] = await MftOsEngine.list({ channelId, status: 'built' });
    expect(held).toMatchObject({ fileType: 'wire_payment', sourceRef: 'wire:IHB-1', builtBy: 'maker@dlb.trust', approvedBy: null });

    // Maker approving their own wire is refused outright, on both paths.
    await expect(MftOsEngine.approve(held.fileId, 'maker@dlb.trust')).rejects.toMatchObject({ code: 'MFT_FOUR_EYES' });
    await expect(MftOsEngine.deliver(wireFile('maker@dlb.trust', 'wire:IHB-2'))).rejects.toMatchObject({ code: 'MFT_FOUR_EYES' });

    // A distinct checker releases it and the machine carries it.
    await MftOsEngine.approve(held.fileId, 'checker@dlb.trust');
    const sent = await MftOsEngine.deliver(wireFile('checker@dlb.trust'));
    expect(sent).toMatchObject({ transmitted: true, replay: false, reused: true });
    expect(sent.file.fileId).toBe(held.fileId);
    expect(sent.file).toMatchObject({ status: 'transmitted', fileType: 'wire_payment', approvedBy: 'checker@dlb.trust', builtBy: 'maker@dlb.trust', creditCents: 250_000, transport: 'sftp' });
    expect(sent.file.remotePath).toBe('/payments/outbound/PTCWIRE_20260201T120000_IHB-1.xml');
    expect(fs.readdirSync(outboundOf()).sort()).toEqual(['PTCWIRE_20260201T120000_IHB-1.xml', `PTCWIRE_20260201T120000_IHB-1.xml${MANIFEST_SUFFIX}`]);
    const manifest = JSON.parse(fs.readFileSync(path.join(outboundOf(), `PTCWIRE_20260201T120000_IHB-1.xml${MANIFEST_SUFFIX}`), 'utf8'));
    expect(manifest.manifest).toMatchObject({ identityId: partner.identityId, sha256: sent.file.contentHash, creditCents: 250_000 });
    expect(await M2mOsEngine.verifyManifest(manifest)).toMatchObject({ valid: true, identityId: partner.identityId });

    const transmitted = (await MftOsEngine.events(sent.file.fileId)).find((e: Row) => e.eventType === 'transmitted');
    expect(transmitted.actor).toBe(`machine:${partner.identityId}`);
    expect(transmitted.detail.identityId).toBe(partner.identityId);

    // Re-delivering the same wire is a replay, not a second file.
    expect(await MftOsEngine.deliver(wireFile('checker@dlb.trust'))).toMatchObject({ transmitted: false, replay: true, reused: true });

    // The bank's acknowledgement is collected by the unattended cycle.
    fs.mkdirSync(path.join(tmp, bank.host, 'payments', 'ack'), { recursive: true });
    fs.writeFileSync(path.join(tmp, bank.host, 'payments', 'ack', `${sent.file.filename}.ack`), 'FEDREF-2026-0001\n');
    const cycle = await M2mOsEngine.runCycle({ partnerId: partner.partnerId });
    expect(cycle.partners[0].collected.acknowledged).toEqual([sent.file.fileId]);
    expect((await MftOsEngine.get(sent.file.fileId)).bankReference).toBe('FEDREF-2026-0001');
  });

  it('a direct deposit, a vendor payment and a wire all leave through the same outbound directory, each after its own release', async () => {
    store();
    fakeBank(tmp);
    const partner = await verifiedPartner();
    const channelId = process.env.ACH_MFT_CHANNEL!;

    const { file: dd } = await MftOsEngine.build({ channelId, fileType: 'direct_deposit', builtBy: 'maker@dlb.trust', entries: [payee()] });
    const { file: vendor } = await MftOsEngine.build({ channelId, fileType: 'vendor_payment', builtBy: 'maker@dlb.trust', entries: [payee({ amountCents: 99_00, name: 'Acme Vendor', identifier: 'VEN-1' })] });
    expect(dd.status).toBe('built');
    expect(vendor.status).toBe('built');

    // Nothing built leaves on a cycle while approval is required.
    const held = await M2mOsEngine.runCycle({ partnerId: partner.partnerId });
    expect(held.partners[0].transmitted).toEqual([]);
    expect(fs.existsSync(outboundOf()) ? fs.readdirSync(outboundOf()) : []).toEqual([]);

    await expect(MftOsEngine.approve(dd.fileId, 'maker@dlb.trust')).rejects.toMatchObject({ code: 'MFT_FOUR_EYES' });
    await MftOsEngine.approve(dd.fileId, 'checker@dlb.trust');
    await MftOsEngine.approve(vendor.fileId, 'checker@dlb.trust');

    const wire = await MftOsEngine.deliver({
      channelId, fileType: 'wire_payment', format: 'pacs.008', content: PACS008, filename: 'PTCWIRE_20260201T120000_IHB-1.xml',
      sourceRef: 'wire:IHB-1', builtBy: 'trustee-one', approvedBy: 'trustee-two', actor: 'operator-a',
    });
    expect(wire.transmitted).toBe(true);

    const cycle = await M2mOsEngine.runCycle({ partnerId: partner.partnerId });
    expect(cycle.partners[0].transmitted.map((t: Row) => t.fileId).sort()).toEqual([dd.fileId, vendor.fileId].sort());
    expect(cycle.partners[0].errors).toEqual([]);

    const sentDd = await MftOsEngine.get(dd.fileId);
    const sentVendor = await MftOsEngine.get(vendor.fileId);
    expect(sentDd).toMatchObject({ status: 'transmitted', format: 'nacha', transport: 'sftp' });
    expect(sentVendor).toMatchObject({ status: 'transmitted', format: 'nacha', transport: 'sftp' });
    for (const f of [sentDd, sentVendor]) {
      const actor = (await MftOsEngine.events(f.fileId)).find((e: Row) => e.eventType === 'transmitted').actor;
      expect(actor).toBe(`machine:${partner.identityId}`);
    }

    const files = fs.readdirSync(outboundOf()).sort();
    expect(files).toEqual([sentDd.filename, `${sentDd.filename}${MANIFEST_SUFFIX}`, sentVendor.filename, `${sentVendor.filename}${MANIFEST_SUFFIX}`,
      wire.file.filename, `${wire.file.filename}${MANIFEST_SUFFIX}`].sort());
    for (const f of [sentDd, sentVendor, wire.file]) {
      const doc = JSON.parse(fs.readFileSync(path.join(outboundOf(), `${f.filename}${MANIFEST_SUFFIX}`), 'utf8'));
      expect(doc.manifest.identityId).toBe(partner.identityId);
      expect(doc.manifest.sha256).toBe(f.contentHash);
    }
    // One channel, one identity: every session opened against the bank presented the same machine key.
    expect((await M2mOsEngine.status()).partners).toHaveLength(1);
    expect((await MftOsEngine.status()).channels.filter((c: Row) => c.channelId === channelId)).toHaveLength(1);
  });
});
