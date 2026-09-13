import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import http from 'http';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);

const glAccounts = [
  { id: 73, glCode: '1100', name: 'Bond Investments', type: { value: 'ASSET' }, usage: { id: 1 }, disabled: false, manualEntriesAllowed: true },
  { id: 81, glCode: '3000', name: 'Trust Corpus', type: { value: 'EQUITY' }, usage: { id: 1 }, disabled: false, manualEntriesAllowed: true },
];

function line(id: number, txn: string, glAccountId: number, type: 'ASSET' | 'EQUITY', entry: 'DEBIT' | 'CREDIT', amount: number, reversed: boolean, comments: string) {
  return { id, transactionId: txn, glAccountId, glAccountType: { value: type }, entryType: { value: entry }, amount, reversed, comments };
}

// Original $100M posting, later reversed by Fineract (original flagged, counter-entry posted),
// plus one live $60M posting. Correct net: 1100 = 60M debit, 3000 = 60M credit.
const journal = [
  line(1, 'ORIG', 73, 'ASSET', 'DEBIT', 100_000_000, true, 'Opening balance'),
  line(2, 'ORIG', 81, 'EQUITY', 'CREDIT', 100_000_000, true, 'Opening balance'),
  line(3, 'CTR', 73, 'ASSET', 'CREDIT', 100_000_000, false, 'Reversal entry for Journal Entry with Entry Id  :1 and transaction Id ORIG'),
  line(4, 'CTR', 81, 'EQUITY', 'DEBIT', 100_000_000, false, 'Reversal entry for Journal Entry with Entry Id  :2 and transaction Id ORIG'),
  line(5, 'LIVE', 73, 'ASSET', 'DEBIT', 60_000_000, false, 'Trust JE JRN-1: Bond'),
  line(6, 'LIVE', 81, 'EQUITY', 'CREDIT', 60_000_000, false, 'Trust JE JRN-1: Bond'),
];

let server: http.Server;
let FineractClient: any;

beforeAll(async () => {
  server = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    if (req.url!.startsWith('/api/v1/glaccounts')) return res.end(JSON.stringify(glAccounts));
    if (req.url!.startsWith('/api/v1/journalentries')) return res.end(JSON.stringify({ totalFilteredRecords: journal.length, pageItems: journal }));
    res.statusCode = 404;
    res.end('{}');
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const port = (server.address() as any).port;
  process.env.FINERACT_URL = `http://127.0.0.1:${port}/api/v1`;
  ({ FineractClient } = require('../server/integrations/fineract/fineractClient'));
});

afterAll(() => new Promise<void>((r) => server.close(() => r())));

describe('FineractClient.getGLSummary', () => {
  it('nets reversed originals against their counter-entries instead of counting the counter-entry alone', async () => {
    FineractClient.clearCache();
    const summary = await FineractClient.getGLSummary();
    const bond = summary.accounts.assets.find((a: any) => a.glCode === '1100');
    const corpus = summary.accounts.equity.find((a: any) => a.glCode === '3000');
    expect(bond.balance).toBe(60_000_000);
    expect(corpus.balance).toBe(60_000_000);
    expect(summary.total_assets).toBe(60_000_000);
    expect(summary.total_equity).toBe(60_000_000);
  });
});
