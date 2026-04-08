import test from 'node:test';
import assert from 'node:assert/strict';

import { DepositTracker } from './deposit-tracker.js';
import { mockDataLayer, mockAuditLog, mockMutex } from './test-mock-factories.js';

test('wallet bridge deposits credit the net amount after miner fee', async () => {
  const capitalCalls = {
    pending: [],
    confirmed: [],
  };
  const capitalLedger = {
    async recordDeposit(agentId, amount, txid, details = {}) {
      capitalCalls.pending.push({ agentId, amount, txid, details });
    },
    async confirmDeposit(agentId, amount, txid, details = {}) {
      capitalCalls.confirmed.push({ agentId, amount, txid, details });
    },
  };

  let currentTxs = [{
    tx_hash: 'bridge-tx-1',
    label: 'lightning-capital-wallet:flow-1',
    total_fees: '141',
    num_confirmations: 1,
    block_height: 100,
    output_details: [
      { address: 'bc1p_reserved_1', amount: '250000' },
    ],
  }];

  const walletClient = {
    async newAddress() {
      return { address: 'bc1p_reserved_1' };
    },
    async getTransactions() {
      return { transactions: currentTxs };
    },
    async getBestBlock() {
      return { block_height: 100 };
    },
  };

  const nodeManager = {
    getScopedDefaultNodeOrNull(role) {
      return role === 'wallet' ? walletClient : null;
    },
  };

  const tracker = new DepositTracker({
    capitalLedger,
    nodeManager,
    dataLayer: mockDataLayer(),
    auditLog: mockAuditLog(),
    mutex: mockMutex(),
  });

  await tracker.load();
  await tracker.generateAddress('agent-1', {
    source: 'lightning_capital_bridge',
    flow_id: 'flow-1',
  });

  await tracker.pollForDeposits();

  const pending = tracker.getDepositStatus('agent-1').deposits[0];
  assert.equal(pending.amount_sats, 249859);
  assert.equal(pending.gross_amount_sats, 250000);
  assert.equal(pending.actual_fee_sats, 141);
  assert.equal(capitalCalls.pending[0].amount, 249859);
  assert.equal(capitalCalls.pending[0].details.actual_fee_sats, 141);
  assert.equal(capitalCalls.pending[0].details.gross_amount_sats, 250000);

  currentTxs = [{
    ...currentTxs[0],
    num_confirmations: 3,
  }];

  await tracker.pollForDeposits();

  const confirmed = tracker.getDepositStatus('agent-1').deposits[0];
  assert.equal(confirmed.status, 'confirmed');
  assert.equal(capitalCalls.confirmed[0].amount, 249859);
  assert.equal(capitalCalls.confirmed[0].details.actual_fee_sats, 141);
  assert.equal(capitalCalls.confirmed[0].details.gross_amount_sats, 250000);
});
