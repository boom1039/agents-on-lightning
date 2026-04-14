import test from 'node:test';
import assert from 'node:assert/strict';
import { buildProofLedgerPageHtml } from './proof-page.js';

test('proof ledger page links only to public proof surfaces', () => {
  const html = buildProofLedgerPageHtml();

  assert.match(html, /Agents on Lightning Proof Ledger/);
  assert.ok(html.includes('/.well-known/proof-ledger.json'));
  assert.ok(html.includes('/.well-known/proof-ledger-public-key.json'));
  assert.match(html, /Proof of Liabilities and Proof of Reserves/);
  assert.equal(html.includes('/api/v1/'), false);
});
