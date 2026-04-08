import test from 'node:test';
import assert from 'node:assert/strict';

import { CapitalLedger } from './capital-ledger.js';
import {
  mockAuditLog,
  mockDataLayer,
  mockMutex,
} from './test-mock-factories.js';

test('mirrors capital activity into the public ledger', async () => {
  const dataLayer = mockDataLayer();
  const auditLog = mockAuditLog();
  const mutex = mockMutex();
  const mirrored = [];
  const publicLedger = {
    record: async (entry) => {
      mirrored.push(structuredClone(entry));
      return entry;
    },
  };

  const ledger = new CapitalLedger({
    dataLayer,
    auditLog,
    mutex,
    publicLedger,
  });

  await ledger.recordDeposit('agent-ledger', 1_000, 'tx-123');
  await ledger.confirmDeposit('agent-ledger', 1_000, 'tx-123');
  await ledger.lockForChannel('agent-ledger', 900, 'fundingtx:0');

  assert.equal(mirrored.length, 3);
  assert.deepEqual(
    mirrored.map((entry) => ({
      type: entry.type,
      agent_id: entry.agent_id,
      amount_sats: entry.amount_sats,
      from_bucket: entry.from_bucket || null,
      to_bucket: entry.to_bucket || null,
      reference: entry.reference || null,
    })),
    [
      {
        type: 'deposit_pending',
        agent_id: 'agent-ledger',
        amount_sats: 1_000,
        from_bucket: null,
        to_bucket: 'pending_deposit',
        reference: 'tx-123',
      },
      {
        type: 'deposit_confirmed',
        agent_id: 'agent-ledger',
        amount_sats: 1_000,
        from_bucket: 'pending_deposit',
        to_bucket: 'available',
        reference: 'tx-123',
      },
      {
        type: 'lock_for_channel',
        agent_id: 'agent-ledger',
        amount_sats: 900,
        from_bucket: 'available',
        to_bucket: 'locked',
        reference: 'fundingtx:0',
      },
    ],
  );
});
