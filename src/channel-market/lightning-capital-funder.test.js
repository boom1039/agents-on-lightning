import test from 'node:test';
import assert from 'node:assert/strict';

import { LightningCapitalFunder } from './lightning-capital-funder.js';
import { mockDataLayer, mockAuditLog, mockMutex, mockNodeManager, mockCapitalLedger } from './test-mock-factories.js';

function createDepositTracker() {
  const entries = new Map();
  let nextId = 1;
  return {
    _confirmationsRequired: 3,
    async generateAddress(agentId, metadata = {}) {
      const address = `bc1p_mock_${nextId++}`;
      entries.set(address, {
        agent_id: agentId,
        address,
        status: 'watching',
        amount_sats: null,
        txid: null,
        confirmations: 0,
        confirmations_required: 3,
        source: metadata.source || 'onchain',
        flow_id: metadata.flow_id || null,
      });
      return { address };
    },
    getDepositStatus(agentId) {
      return {
        deposits: [...entries.values()].filter((entry) => entry.agent_id === agentId),
      };
    },
    _entries: entries,
  };
}

test('createFlow creates invoice, tracked address, and lightning funding event', async () => {
  const dataLayer = mockDataLayer();
  const depositTracker = createDepositTracker();
  const capitalLedger = mockCapitalLedger();
  const loopClient = {
    quoteCalls: [],
    async quoteOut(amountSats) {
      this.quoteCalls.push(amountSats);
      return { stdout: 'quote ok', stderr: '' };
    },
    async startLoopOut() {
      return { swapId: '55', stdout: 'swap started', stderr: '' };
    },
  };
  const funder = new LightningCapitalFunder({
    nodeManager: mockNodeManager({
      addInvoice: async (value) => ({
        payment_request: `lnbc${value}mock`,
        r_hash: 'hash-1',
        add_index: '42',
      }),
    }),
    depositTracker,
    capitalLedger,
    dataLayer,
    auditLog: mockAuditLog(),
    mutex: mockMutex(),
    loopClient,
  });

  await funder.load();
  const flow = await funder.createFlow('agent-lightning', 250_000);

  assert.equal(flow.status, 'invoice_created');
  assert.equal(flow.amount_sats, 250_000);
  assert.match(flow.payment_request, /^lnbc250000mock$/);
  assert.ok(flow.flow_id);
  assert.equal(loopClient.quoteCalls.length, 1);
  assert.equal(capitalLedger.fundingEvents[0].type, 'lightning_invoice_created');
});

test('polling advances invoice -> loop out -> onchain pending -> confirmed', async () => {
  const dataLayer = mockDataLayer();
  const depositTracker = createDepositTracker();
  const capitalLedger = mockCapitalLedger();
  let invoiceSettled = false;
  const loopClient = {
    async quoteOut() {
      return { stdout: 'quote ok', stderr: '' };
    },
    async startLoopOut() {
      return { swapId: '77', stdout: 'swap id: 77', stderr: '' };
    },
  };
  const funder = new LightningCapitalFunder({
    nodeManager: mockNodeManager({
      addInvoice: async (value) => ({
        payment_request: `lnbc${value}mock`,
        r_hash: 'hash-2',
        add_index: '50',
      }),
      listInvoices: async () => ({
        invoices: [{
          add_index: '50',
          settled: invoiceSettled,
          state: invoiceSettled ? 'SETTLED' : 'OPEN',
          value: '250000',
        }],
      }),
    }),
    depositTracker,
    capitalLedger,
    dataLayer,
    auditLog: mockAuditLog(),
    mutex: mockMutex(),
    loopClient,
    config: {
      pollIntervalMs: 1_000,
    },
  });

  await funder.load();
  const created = await funder.createFlow('agent-lightning', 250_000);

  invoiceSettled = true;
  await funder._pollCycle();
  let flow = await funder.getFlow('agent-lightning', created.flow_id);
  assert.equal(flow.status, 'invoice_paid');

  await funder._pollCycle();
  flow = await funder.getFlow('agent-lightning', created.flow_id);
  assert.equal(flow.status, 'loop_out_pending');
  assert.equal(flow.loop_out_swap_id, '77');

  const depositEntry = depositTracker._entries.get(flow.deposit_address);
  depositEntry.status = 'pending_deposit';
  depositEntry.amount_sats = 250_000;
  depositEntry.txid = 'tx-1';
  depositEntry.confirmations = 1;

  await funder._pollCycle();
  flow = await funder.getFlow('agent-lightning', created.flow_id);
  assert.equal(flow.status, 'onchain_pending');
  assert.equal(flow.onchain_txid, 'tx-1');

  depositEntry.status = 'confirmed';
  depositEntry.confirmations = 3;

  await funder._pollCycle();
  flow = await funder.getFlow('agent-lightning', created.flow_id);
  assert.equal(flow.status, 'confirmed');
  assert.equal(flow.confirmations, 3);

  const eventTypes = capitalLedger.fundingEvents.map((entry) => entry.type);
  assert.deepEqual(eventTypes, [
    'lightning_invoice_created',
    'lightning_paid',
    'loop_out_started',
    'loop_out_broadcast',
    'lightning_deposit_confirmed',
  ]);
});
