import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';

import { ECPairFactory } from 'ecpair';
import * as ecc from 'tiny-secp256k1';
import { address as btcAddress, networks as btcNetworks, payments } from 'bitcoinjs-lib';
import { Musig, SwapTreeSerializer, TaprootUtils, reverseSwapTree } from 'boltz-core';
import { SigHash, Transaction as RawTransaction } from '@scure/btc-signer';
import { LightningCapitalFunder } from './lightning-capital-funder.js';
import { mockDataLayer, mockAuditLog, mockMutex, mockNodeManager, mockCapitalLedger } from './test-mock-factories.js';

const TEST_BOLTZ_API_BASE = 'http://127.0.0.1:9';
const ECPair = ECPairFactory(ecc);

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
    config: { boltzApiBase: TEST_BOLTZ_API_BASE },
  });

  await funder.load();
  const flow = await funder.createFlow('agent-lightning', 250_000);

  assert.equal(flow.status, 'invoice_created');
  assert.equal(flow.amount_sats, 250_000);
  assert.match(flow.payment_request, /^lnbc250000mock$/);
  assert.ok(flow.flow_id);
  assert.equal(flow.bridge_preflight.any_available, true);
  assert.equal(flow.bridge_preflight.preferred_provider, 'loop_out');
  assert.equal(loopClient.quoteCalls.length, 1);
  assert.equal(capitalLedger.fundingEvents[0].type, 'lightning_bridge_preflight');
  assert.equal(capitalLedger.fundingEvents[1].type, 'lightning_invoice_created');
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
      return { swapId: '77deadbeef', stdout: 'swap id: 77deadbeef', stderr: '' };
    },
    async getSwapInfo() {
      return null;
    },
    async listSwaps() {
      return { swaps: [] };
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
      boltzApiBase: TEST_BOLTZ_API_BASE,
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
  assert.equal(flow.loop_out_swap_id, '77deadbeef');

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
    'lightning_bridge_preflight',
    'lightning_invoice_created',
    'lightning_paid',
    'loop_out_started',
    'loop_out_broadcast',
    'lightning_deposit_confirmed',
  ]);
});

test('polling retries offchain loop swap failures before giving up', async () => {
  const dataLayer = mockDataLayer();
  const depositTracker = createDepositTracker();
  const capitalLedger = mockCapitalLedger();
  let invoiceSettled = false;
  let swapChecks = 0;
  let starts = 0;
  const loopClient = {
    async quoteOut() {
      return { stdout: 'quote ok', stderr: '' };
    },
    async startLoopOut() {
      starts += 1;
      return { swapId: '69aba73d84ab72d39c483413907394419b88e1cd4dad7f60300c23da1e9c3c7f', stdout: 'swap started', stderr: '' };
    },
    async getSwapInfo() {
      swapChecks += 1;
      if (swapChecks === 1) {
        return {
          id: '69aba73d84ab72d39c483413907394419b88e1cd4dad7f60300c23da1e9c3c7f',
          state: 'FAILED',
          failure_reason: 'FAILURE_REASON_OFFCHAIN',
        };
      }
      return null;
    },
    async listSwaps() {
      return { swaps: [] };
    },
  };
  const funder = new LightningCapitalFunder({
    nodeManager: mockNodeManager({
      addInvoice: async (value) => ({
        payment_request: `lnbc${value}mock`,
        r_hash: 'hash-3',
        add_index: '51',
      }),
      listInvoices: async () => ({
        invoices: [{
          add_index: '51',
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
      retryBackoffMs: 0,
      boltzApiBase: TEST_BOLTZ_API_BASE,
    },
  });

  await funder.load();
  const created = await funder.createFlow('agent-lightning', 250_000);

  invoiceSettled = true;
  await funder._pollCycle();
  await funder._pollCycle();
  await funder._pollCycle();

  let flow = await funder.getFlow('agent-lightning', created.flow_id);
  assert.equal(flow.status, 'invoice_paid');
  assert.equal(flow.last_error, 'Loop could not route the off-chain swap payment (FAILURE_REASON_OFFCHAIN).');
  assert.equal(starts, 1);

  await funder._pollCycle();
  flow = await funder.getFlow('agent-lightning', created.flow_id);
  assert.equal(flow.status, 'loop_out_pending');
  assert.equal(starts, 2);

  const eventTypes = capitalLedger.fundingEvents.map((entry) => entry.type);
  assert.deepEqual(eventTypes, [
    'lightning_bridge_preflight',
    'lightning_invoice_created',
    'lightning_paid',
    'loop_out_started',
    'lightning_deposit_retrying',
    'loop_out_started',
  ]);
});

test('polling marks failed loop swaps as loop_out_failed after retry limit', async () => {
  const dataLayer = mockDataLayer();
  const depositTracker = createDepositTracker();
  const capitalLedger = mockCapitalLedger();
  let invoiceSettled = false;
  const loopClient = {
    async quoteOut() {
      return { stdout: 'quote ok', stderr: '' };
    },
    async startLoopOut() {
      return { swapId: '69aba73d84ab72d39c483413907394419b88e1cd4dad7f60300c23da1e9c3c7f', stdout: 'swap started', stderr: '' };
    },
    async getSwapInfo() {
      return {
        id: '69aba73d84ab72d39c483413907394419b88e1cd4dad7f60300c23da1e9c3c7f',
        state: 'FAILED',
        failure_reason: 'FAILURE_REASON_OFFCHAIN',
      };
    },
    async listSwaps() {
      return { swaps: [] };
    },
  };
  const funder = new LightningCapitalFunder({
    nodeManager: mockNodeManager({
      addInvoice: async (value) => ({
        payment_request: `lnbc${value}mock`,
        r_hash: 'hash-4',
        add_index: '52',
      }),
      listInvoices: async () => ({
        invoices: [{
          add_index: '52',
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
      maxStartAttempts: 1,
      retryBackoffMs: 0,
      boltzApiBase: TEST_BOLTZ_API_BASE,
    },
  });

  await funder.load();
  const created = await funder.createFlow('agent-lightning', 250_000);

  invoiceSettled = true;
  await funder._pollCycle();
  await funder._pollCycle();
  await funder._pollCycle();

  const flow = await funder.getFlow('agent-lightning', created.flow_id);
  assert.equal(flow.status, 'loop_out_failed');
  assert.equal(flow.last_error, 'Loop could not route the off-chain swap payment (FAILURE_REASON_OFFCHAIN).');
});

test('load revives retryable offchain failures back into invoice_paid', async () => {
  const dataLayer = mockDataLayer();
  dataLayer._store['data/channel-market/lightning-capital-flows.json'] = {
    flow1: {
      flow_id: 'flow1',
      agent_id: 'agent-lightning',
      amount_sats: 250000,
      deposit_address: 'bc1p_mock_saved',
      status: 'loop_out_failed',
      created_at: new Date(Date.now() - 60_000).toISOString(),
      invoice_paid_at: new Date(Date.now() - 30_000).toISOString(),
      expires_at: new Date(Date.now() + 3_600_000).toISOString(),
      invoice_payment_request: 'lnbcmock',
      invoice_add_index: '9',
      invoice_r_hash: 'hash-saved',
      loop_out_label: 'lightning-capital:flow1',
      loop_out_swap_id: 'savedswap',
      loop_out_attempts: 1,
      loop_out_started_at: new Date(Date.now() - 20_000).toISOString(),
      next_retry_at: null,
      last_error: 'Loop could not route the off-chain swap payment (FAILURE_REASON_OFFCHAIN).',
      last_progress_at: new Date().toISOString(),
    },
  };
  const funder = new LightningCapitalFunder({
    nodeManager: mockNodeManager(),
    depositTracker: createDepositTracker(),
    capitalLedger: mockCapitalLedger(),
    dataLayer,
    auditLog: mockAuditLog(),
    mutex: mockMutex(),
    loopClient: {
      async quoteOut() { return { stdout: '', stderr: '' }; },
      async startLoopOut() { return { swapId: 'x', stdout: '', stderr: '' }; },
      async getSwapInfo() { return null; },
      async listSwaps() { return { swaps: [] }; },
    },
    config: {
      retryBackoffMs: 0,
      boltzApiBase: TEST_BOLTZ_API_BASE,
    },
  });

  await funder.load();
  const flow = await funder.getFlow('agent-lightning', 'flow1');
  assert.equal(flow.status, 'invoice_paid');
});

test('createFlow rejects when no bridge provider is ready', async () => {
  const dataLayer = mockDataLayer();
  const depositTracker = createDepositTracker();
  const capitalLedger = mockCapitalLedger();
  const loopClient = {
    async quoteOut() {
      throw new Error('loop unavailable');
    },
    async startLoopOut() {
      throw new Error('should not run');
    },
    async getSwapInfo() {
      return null;
    },
    async listSwaps() {
      return { swaps: [] };
    },
  };
  const funder = new LightningCapitalFunder({
    nodeManager: mockNodeManager({
      walletBalance: async () => ({ confirmed_balance: '0' }),
    }),
    depositTracker,
    capitalLedger,
    dataLayer,
    auditLog: mockAuditLog(),
    mutex: mockMutex(),
    loopClient,
    config: {
      enableWalletFallback: true,
      boltzApiBase: 'http://127.0.0.1:9',
    },
  });

  await funder.load();
  await assert.rejects(
    () => funder.createFlow('agent-lightning', 250_000),
    /No Lightning-to-capital bridge is ready right now for this amount/,
  );
  assert.equal(capitalLedger.fundingEvents[0].type, 'lightning_bridge_preflight_rejected');
});

test('createFlow can prefer wallet fallback when Loop is not configured', async () => {
  const dataLayer = mockDataLayer();
  const depositTracker = createDepositTracker();
  const capitalLedger = mockCapitalLedger();
  const funder = new LightningCapitalFunder({
    nodeManager: mockNodeManager({
      walletBalance: async () => ({ confirmed_balance: '300000' }),
    }),
    depositTracker,
    capitalLedger,
    dataLayer,
    auditLog: mockAuditLog(),
    mutex: mockMutex(),
    loopClient: null,
    config: {
      boltzApiBase: TEST_BOLTZ_API_BASE,
    },
  });

  await funder.load();
  const flow = await funder.createFlow('agent-lightning', 250_000);
  assert.equal(flow.bridge_preflight.preferred_provider, 'wallet_fallback');
  assert.equal(flow.bridge_preflight.providers[0].provider, 'loop_out');
  assert.equal(flow.bridge_preflight.providers[0].available, false);
  assert.equal(flow.bridge_preflight.providers[2].provider, 'wallet_fallback');
  assert.equal(flow.bridge_preflight.providers[2].available, true);
});

test('falls back to wallet bridge after route failure and then confirms', async () => {
  const dataLayer = mockDataLayer();
  const depositTracker = createDepositTracker();
  const capitalLedger = mockCapitalLedger();
  let invoiceSettled = false;
  let swapChecks = 0;
  const loopClient = {
    async quoteOut() {
      return { stdout: 'quote ok', stderr: '' };
    },
    async startLoopOut() {
      return { swapId: 'swap-1', stdout: 'swap started', stderr: '' };
    },
    async getSwapInfo() {
      swapChecks += 1;
      if (swapChecks === 1) {
        return {
          id: 'swap-1',
          state: 'FAILED',
          failure_reason: 'FAILURE_REASON_NO_ROUTE',
        };
      }
      return null;
    },
    async listSwaps() {
      return { swaps: [] };
    },
  };
  const funder = new LightningCapitalFunder({
    nodeManager: mockNodeManager({
      addInvoice: async (value) => ({
        payment_request: `lnbc${value}mock`,
        r_hash: 'hash-5',
        add_index: '53',
      }),
      listInvoices: async () => ({
        invoices: [{
          add_index: '53',
          settled: invoiceSettled,
          state: invoiceSettled ? 'SETTLED' : 'OPEN',
          value: '250000',
        }],
      }),
      sendCoins: async () => ({ txid: 'wallet-bridge-tx-1' }),
      getTransactions: async () => ({
        transactions: [{
          tx_hash: 'wallet-bridge-tx-1',
          label: 'lightning-capital-wallet:flow-lookup',
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
      boltzApiBase: TEST_BOLTZ_API_BASE,
    },
  });

  await funder.load();
  const created = await funder.createFlow('agent-lightning', 250_000);

  invoiceSettled = true;
  await funder._pollCycle();
  await funder._pollCycle();
  await funder._pollCycle();

  let flow = await funder.getFlow('agent-lightning', created.flow_id);
  assert.equal(flow.status, 'onchain_pending');
  assert.equal(flow.source, 'lightning_wallet_bridge');
  assert.equal(flow.onchain_txid, 'wallet-bridge-tx-1');

  const depositEntry = depositTracker._entries.get(flow.deposit_address);
  depositEntry.status = 'pending_deposit';
  depositEntry.amount_sats = 250_000;
  depositEntry.txid = 'wallet-bridge-tx-1';
  depositEntry.confirmations = 1;

  await funder._pollCycle();
  flow = await funder.getFlow('agent-lightning', created.flow_id);
  assert.equal(flow.status, 'onchain_pending');

  depositEntry.status = 'confirmed';
  depositEntry.confirmations = 3;

  await funder._pollCycle();
  flow = await funder.getFlow('agent-lightning', created.flow_id);
  assert.equal(flow.status, 'confirmed');
  assert.equal(flow.source, 'lightning_wallet_bridge');

  const eventTypes = capitalLedger.fundingEvents.map((entry) => entry.type);
  assert.deepEqual(eventTypes, [
    'lightning_bridge_preflight',
    'lightning_invoice_created',
    'lightning_paid',
    'loop_out_started',
    'lightning_wallet_bridge_broadcast',
    'lightning_deposit_confirmed',
  ]);
});

test('falls back to Boltz after a Loop route failure and publishes a claim tx', async () => {
  const restoreFetch = globalThis.fetch;
  const dataLayer = mockDataLayer();
  const depositTracker = createDepositTracker();
  const capitalLedger = mockCapitalLedger();
  let invoiceSettled = false;
  let swapChecks = 0;

  const boltzKeys = ECPair.makeRandom();
  const lockupAddress = payments.p2wpkh({ pubkey: Buffer.from(boltzKeys.publicKey), network: btcNetworks.bitcoin }).address;
  const lockupScript = btcAddress.toOutputScript(lockupAddress, btcNetworks.bitcoin);
  const lockupTx = new RawTransaction();
  lockupTx.addInput({ txid: '11'.repeat(32), index: 0 });
  lockupTx.addOutput({ amount: 248442n, script: lockupScript });
  const lockupHex = lockupTx.hex;
  const boltzId = 'boltz-swap-1';

  const loopClient = {
    async quoteOut() {
      return { stdout: 'quote ok', stderr: '' };
    },
    async startLoopOut() {
      return { swapId: 'loop-1', stdout: 'swap started', stderr: '' };
    },
    async getSwapInfo() {
      swapChecks += 1;
      if (swapChecks === 1) {
        return {
          id: 'loop-1',
          state: 'FAILED',
          failure_reason: 'FAILURE_REASON_NO_ROUTE',
        };
      }
      return null;
    },
    async listSwaps() {
      return { swaps: [] };
    },
  };

  const funder = new LightningCapitalFunder({
    nodeManager: mockNodeManager({
      addInvoice: async (value) => ({
        payment_request: `lnbc${value}mock`,
        r_hash: 'hash-boltz',
        add_index: '54',
      }),
      listInvoices: async () => ({
        invoices: [{
          add_index: '54',
          settled: invoiceSettled,
          state: invoiceSettled ? 'SETTLED' : 'OPEN',
          value: '250000',
        }],
      }),
      sendPayment: async (invoice) => {
        if (invoice === 'lnbc250000boltzmock') {
          return { payment_preimage: 'boltz_preimage', payment_hash: 'boltz_hash', payment_error: '' };
        }
        return { payment_preimage: 'loop_preimage', payment_hash: 'loop_hash', payment_error: '' };
      },
      publishTransaction: async () => ({}),
    }),
    depositTracker,
    capitalLedger,
    dataLayer,
    auditLog: mockAuditLog(),
    mutex: mockMutex(),
    loopClient,
    config: {
      boltzApiBase: TEST_BOLTZ_API_BASE,
      providerProbePubkeys: {},
    },
  });

  globalThis.fetch = async (url, options = {}) => {
    const method = String(options.method || 'GET').toUpperCase();
    if (url === `${TEST_BOLTZ_API_BASE}/swap/reverse` && method === 'GET') {
      return Response.json({
        BTC: {
          BTC: {
            limits: { minimal: 100000, maximal: 10000000 },
            fees: { percentage: 0.5, minerFees: { claim: 300, lockup: 200 } },
          },
        },
      });
    }
    if (url === `${TEST_BOLTZ_API_BASE}/swap/reverse` && method === 'POST') {
      const body = JSON.parse(options.body);
      const swapTree = reverseSwapTree(
        false,
        Buffer.from(body.preimageHash, 'hex'),
        Buffer.from(body.claimPublicKey, 'hex'),
        Buffer.from(boltzKeys.publicKey),
        999999,
      );
      return Response.json({
        id: boltzId,
        invoice: 'lnbc250000boltzmock',
        swapTree: SwapTreeSerializer.serializeSwapTree(swapTree),
        refundPublicKey: Buffer.from(boltzKeys.publicKey).toString('hex'),
        lockupAddress,
        timeoutBlockHeight: 999999,
        onchainAmount: 248442,
      }, { status: 201 });
    }
    if (url === `${TEST_BOLTZ_API_BASE}/swap/${boltzId}` && method === 'GET') {
      return Response.json({
        status: 'transaction.mempool',
        transaction: {
          id: lockupTx.id,
          hex: lockupHex,
        },
      });
    }
    if (url === `${TEST_BOLTZ_API_BASE}/swap/reverse/${boltzId}/claim` && method === 'POST') {
      const body = JSON.parse(options.body);
      const flow = funder._flows[created.flow_id];
      const claimPrivateKey = Buffer.from(flow.boltz_claim_private_key, 'hex');
      const claimPublicKey = Buffer.from(flow.boltz_claim_public_key, 'hex');
      const boltzPublicKey = Buffer.from(flow.boltz_refund_public_key, 'hex');
      const swapTree = SwapTreeSerializer.deserializeSwapTree(flow.boltz_swap_tree);
      const tx = RawTransaction.fromRaw(Buffer.from(body.transaction, 'hex'));
      const txHash = tx.preimageWitnessV1(0, [lockupScript], SigHash.DEFAULT, [248442n]);
      const boltzMusig = TaprootUtils.tweakMusig(
        Musig.create(Buffer.from(boltzKeys.privateKey), [boltzPublicKey, claimPublicKey]),
        swapTree.tree,
      );
      const nonceStage = boltzMusig.message(txHash).generateNonce();
      const partial = nonceStage
        .aggregateNonces([[claimPublicKey, Buffer.from(body.pubNonce, 'hex')]])
        .initializeSession()
        .signPartial();
      return Response.json({
        transactionHash: Buffer.from(txHash).toString('hex'),
        pubNonce: Buffer.from(nonceStage.publicNonce).toString('hex'),
        partialSignature: Buffer.from(partial.ourPartialSignature).toString('hex'),
      });
    }
    throw new Error(`unexpected fetch ${method} ${url}`);
  };

  await funder.load();
  const created = await funder.createFlow('agent-lightning', 250_000);

  invoiceSettled = true;
  await funder._pollCycle();
  await funder._pollCycle();
  await funder._pollCycle();

  let flow = await funder.getFlow('agent-lightning', created.flow_id);
  assert.equal(flow.source, 'lightning_boltz_reverse');
  assert.equal(flow.boltz_swap_id, boltzId);
  assert.equal(flow.onchain_txid, funder._flows[created.flow_id].boltz_claim_txid);

  const depositEntry = depositTracker._entries.get(flow.deposit_address);
  depositEntry.status = 'pending_deposit';
  depositEntry.amount_sats = 248_442;
  depositEntry.txid = funder._flows[created.flow_id].boltz_claim_txid;
  depositEntry.confirmations = 1;

  await funder._pollCycle();
  flow = await funder.getFlow('agent-lightning', created.flow_id);
  assert.equal(flow.status, 'onchain_pending');
  assert.equal(flow.source, 'lightning_boltz_reverse');

  globalThis.fetch = restoreFetch;
});
