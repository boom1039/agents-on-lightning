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

test('deposit address creation writes a public-safe proof lifecycle event when proof ledger is enabled', async () => {
  const proofRows = [];
  const walletClient = {
    async newAddress() {
      return { address: 'bc1p_address_should_not_be_public' };
    },
  };
  const tracker = new DepositTracker({
    capitalLedger: {
      async recordDeposit() {},
      async confirmDeposit() {},
    },
    nodeManager: {
      getScopedDefaultNodeOrNull(role) {
        return role === 'wallet' ? walletClient : null;
      },
    },
    dataLayer: mockDataLayer(),
    auditLog: mockAuditLog(),
    mutex: mockMutex(),
    proofLedger: {
      appendProof: async (row) => {
        proofRows.push(row);
        return row;
      },
    },
  });

  await tracker.load();
  const generated = await tracker.generateAddress('agent-proof-address', {
    source: 'lightning_capital_bridge',
    flow_id: 'flow-should-not-be-public',
  });

  assert.equal(proofRows.length, 1);
  assert.equal(generated.proof_id, null);
  assert.equal(generated.proof_hash, null);
  assert.equal(generated.source_of_truth, 'proof_ledger');
  assert.equal(proofRows[0].money_event_type, 'capital_deposit_address_created');
  assert.equal(proofRows[0].event_source, 'lightning_capital');
  const refsJson = JSON.stringify(proofRows[0].public_safe_refs);
  assert(!refsJson.includes('bc1p_address_should_not_be_public'));
  assert(!refsJson.includes('flow-should-not-be-public'));
  assert(refsJson.includes('address_hash'));
  assert(refsJson.includes('flow_hash'));
});

test('on-chain capital deposit reuses one active unfunded address per agent', async () => {
  let addressIndex = 0;
  const walletClient = {
    async newAddress() {
      addressIndex += 1;
      return { address: `bc1p_agent_address_${addressIndex}` };
    },
  };
  const tracker = new DepositTracker({
    capitalLedger: {
      async recordDeposit() {},
      async confirmDeposit() {},
    },
    nodeManager: {
      getScopedDefaultNodeOrNull(role) {
        return role === 'wallet' ? walletClient : null;
      },
    },
    dataLayer: mockDataLayer(),
    auditLog: mockAuditLog(),
    mutex: mockMutex(),
  });

  await tracker.load();
  const first = await tracker.generateAddress('agent-reuse');
  const second = await tracker.generateAddress('agent-reuse');

  assert.equal(first.address, 'bc1p_agent_address_1');
  assert.equal(first.reused, false);
  assert.equal(second.address, first.address);
  assert.equal(second.reused, true);
  assert.equal(addressIndex, 1);
  assert.match(first.expires_at, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(first.valid_for_seconds, 7 * 24 * 60 * 60);
});

test('expired unfunded on-chain address is not reused and is marked expired after polling', async () => {
  let addressIndex = 0;
  const walletClient = {
    async newAddress() {
      addressIndex += 1;
      return { address: `bc1p_expiring_address_${addressIndex}` };
    },
    async getTransactions() {
      return { transactions: [] };
    },
    async getBestBlock() {
      return { block_height: 200 };
    },
  };
  const tracker = new DepositTracker({
    capitalLedger: {
      async recordDeposit() {},
      async confirmDeposit() {},
    },
    nodeManager: {
      getScopedDefaultNodeOrNull(role) {
        return role === 'wallet' ? walletClient : null;
      },
    },
    dataLayer: mockDataLayer(),
    auditLog: mockAuditLog(),
    mutex: mockMutex(),
  });

  await tracker.load();
  const first = await tracker.generateAddress('agent-expire');
  tracker._state[first.address].expires_at = new Date(Date.now() - 1000).toISOString();

  const second = await tracker.generateAddress('agent-expire');
  assert.notEqual(second.address, first.address);
  assert.equal(addressIndex, 2);

  await tracker.pollForDeposits();
  const deposits = tracker.getDepositStatus('agent-expire').deposits;
  const expired = deposits.find((deposit) => deposit.address === first.address);
  assert.equal(expired.status, 'expired');
  assert.match(expired.expired_at, /^\d{4}-\d{2}-\d{2}T/);
});
