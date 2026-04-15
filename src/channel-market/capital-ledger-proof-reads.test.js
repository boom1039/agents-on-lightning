import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { CapitalLedger } from './capital-ledger.js';
import { ProofLedger } from '../proof-ledger/proof-ledger.js';
import {
  mockAuditLog,
  mockDataLayer,
  mockMutex,
} from './test-mock-factories.js';

async function withProofCapitalLedger(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'aol-capital-proof-reads-'));
  const proofLedger = new ProofLedger({
    dbPath: join(dir, 'proof-ledger.sqlite'),
    keyPath: join(dir, 'proof-ledger-key.pem'),
    allowGenerateKey: true,
  });
  const capitalLedger = new CapitalLedger({
    dataLayer: {
      readJSON: async () => {
        const err = new Error('not found');
        err.code = 'ENOENT';
        throw err;
      },
      writeJSON: async () => {},
      appendLog: async () => {},
      readLog: async () => [],
      listDir: async () => [],
    },
    auditLog: { append: async () => {} },
    mutex: { acquire: async () => () => {} },
    proofLedger,
  });

  try {
    await proofLedger.ensureGenesisProof();
    await fn({ proofLedger, capitalLedger });
  } finally {
    proofLedger.close();
    await rm(dir, { recursive: true, force: true });
  }
}

async function seedCapitalProofs(proofLedger) {
  await proofLedger.appendProof({
    idempotency_key: 'capital-test-deposit-pending',
    proof_record_type: 'money_event',
    money_event_type: 'capital_deposit_pending',
    money_event_status: 'pending',
    agent_id: 'agent-capital',
    event_source: 'capital',
    authorization_method: 'system_settlement',
    primary_amount_sats: 1000,
    capital_pending_deposit_delta_sats: 1000,
    public_safe_refs: { amount_sats: 1000, status: 'pending' },
  });
  await proofLedger.appendProof({
    idempotency_key: 'capital-test-deposit-confirmed',
    proof_record_type: 'money_event',
    money_event_type: 'capital_deposit_confirmed',
    money_event_status: 'confirmed',
    agent_id: 'agent-capital',
    event_source: 'capital',
    authorization_method: 'system_settlement',
    primary_amount_sats: 1000,
    capital_pending_deposit_delta_sats: -1000,
    capital_available_delta_sats: 1000,
    public_safe_refs: { amount_sats: 1000, status: 'confirmed' },
  });
  await proofLedger.appendProof({
    idempotency_key: 'capital-test-open-lock',
    proof_record_type: 'money_event',
    money_event_type: 'channel_open_capital_locked',
    money_event_status: 'confirmed',
    agent_id: 'agent-capital',
    event_source: 'channel_open',
    authorization_method: 'agent_signed_instruction',
    primary_amount_sats: 700,
    capital_available_delta_sats: -700,
    capital_locked_delta_sats: 700,
    public_safe_refs: { amount_sats: 700, channel_point: 'fundingtx:0', status: 'confirmed' },
  });
  await proofLedger.appendProof({
    idempotency_key: 'capital-test-service-spend',
    proof_record_type: 'money_event',
    money_event_type: 'paid_service_charge_debited',
    money_event_status: 'settled',
    agent_id: 'agent-capital',
    event_source: 'paid_services',
    authorization_method: 'agent_signed_request',
    primary_amount_sats: 100,
    capital_available_delta_sats: -100,
    capital_service_spent_delta_sats: 100,
    public_safe_refs: { amount_sats: 100, service: 'analytics', status: 'settled' },
  });
  await proofLedger.appendProof({
    idempotency_key: 'capital-test-routing-revenue',
    proof_record_type: 'money_event',
    money_event_type: 'routing_revenue_credited',
    money_event_status: 'settled',
    agent_id: 'agent-capital',
    event_source: 'revenue',
    authorization_method: 'routing_revenue',
    primary_amount_sats: 50,
    capital_available_delta_sats: 50,
    public_safe_refs: { amount_sats: 50, status: 'settled' },
  });
}

test('proof ledger derives capital balance projections from proof deltas', async () => {
  await withProofCapitalLedger(async ({ proofLedger }) => {
    await seedCapitalProofs(proofLedger);
    const balance = proofLedger.getCapitalBalance('agent-capital');

    assert.equal(balance.source_of_truth, 'proof_ledger');
    assert.equal(balance.available, 250);
    assert.equal(balance.locked, 700);
    assert.equal(balance.pending_deposit, 0);
    assert.equal(balance.pending_close, 0);
    assert.equal(balance.total_deposited, 1000);
    assert.equal(balance.total_revenue_credited, 50);
    assert.equal(balance.total_service_spent, 100);
  });
});

test('capital ledger reads proof-derived balance and activity when proof ledger is present', async () => {
  await withProofCapitalLedger(async ({ proofLedger, capitalLedger }) => {
    await seedCapitalProofs(proofLedger);

    const balance = await capitalLedger.getBalance('agent-capital');
    assert.equal(balance.source_of_truth, 'proof_ledger');
    assert.equal(balance.available, 250);
    assert.equal(balance.locked, 700);

    const allBalances = await capitalLedger.getAllBalances();
    assert.equal(allBalances['agent-capital'].available, 250);

    const activity = await capitalLedger.readActivity({ agentId: 'agent-capital', limit: 10 });
    assert.equal(activity.total, 5);
    assert.equal(activity.entries[0].source_of_truth, 'proof_ledger');
    assert(activity.entries.some((entry) => entry.type === 'capital_deposit_confirmed'));
    assert(activity.entries.some((entry) => entry.type === 'channel_open_capital_locked'));
  });
});

test('capital ledger write methods append signed proof rows for money transitions', async () => {
  await withProofCapitalLedger(async ({ proofLedger }) => {
    const capitalLedger = new CapitalLedger({
      dataLayer: mockDataLayer(),
      auditLog: mockAuditLog(),
      mutex: mockMutex(),
      proofLedger,
    });

    await capitalLedger.recordDeposit('agent-write', 1_000, 'tx-write-1');
    await capitalLedger.confirmDeposit('agent-write', 1_000, 'tx-write-1');
    await capitalLedger.lockForChannel('agent-write', 700, 'a'.repeat(64) + ':0');
    await capitalLedger.initiateClose('agent-write', 650, 700, 'a'.repeat(64) + ':0');
    await capitalLedger.settleClose('agent-write', 650, 'tx-close-1');
    await capitalLedger.spendOnService('agent-write', 100, 'svc-ref-1', 'analytics');
    await capitalLedger.refundServiceSpend('agent-write', 40, 'svc-ref-2', 'analytics', 'partial_refund');
    await capitalLedger.creditRevenue('agent-write', 25, 'forward:1713021600000:12345');
    await capitalLedger.creditEcashFunding('agent-write', 30, 'ecash-fund:flow-1');
    const lifecycleProof = await capitalLedger.recordLifecycleProof('agent-write', {
      moneyEventType: 'capital_withdrawal_broadcast',
      moneyEventStatus: 'submitted',
      eventSource: 'capital_withdrawal',
      primaryAmountSats: 10,
      reference: 'withdraw-broadcast-ref',
      publicSafeRefs: { txid: 'tx-broadcast-1', amount_sats: 10 },
    });
    const fundingActivity = await capitalLedger.recordFundingEvent('agent-write', 'lightning_invoice_created', {
      amount_sats: 500,
      source: 'lightning_boltz_reverse',
      status: 'invoice_created',
      flow_id: 'flow-write-proof',
      reference: 'flow-write-proof',
    });

    assert.match(lifecycleProof.proof_id, /^proof-/);
    assert.equal(fundingActivity.source_of_truth, 'proof_ledger');
    assert.match(fundingActivity.proof_id, /^proof-/);

    const proofs = proofLedger.listProofs({ agentId: 'agent-write', limit: 20 }).reverse();
    assert.deepEqual(
      proofs.map((proof) => proof.money_event_type),
      [
        'capital_deposit_pending',
        'capital_deposit_confirmed',
        'channel_open_capital_locked',
        'channel_close_pending',
        'channel_close_settled',
        'paid_service_charge_debited',
        'paid_service_refunded',
        'routing_revenue_credited',
        'capital_ecash_funding_credited',
        'capital_withdrawal_broadcast',
        'lightning_capital_invoice_created',
      ],
    );
    const revenueProof = proofs.find((proof) => proof.money_event_type === 'routing_revenue_credited');
    assert.equal(revenueProof.public_safe_refs.chan_id, '12345');
    assert(proofs.every((proof) => proofLedger.verifyProof(proof).valid));
    assert.equal(proofLedger.verifyChain({ agentId: 'agent-write' }).valid, true);

    const balance = proofLedger.getCapitalBalance('agent-write');
    assert.equal(balance.available, 945);
    assert.equal(balance.locked, 0);
    assert.equal(balance.pending_deposit, 0);
    assert.equal(balance.pending_close, 0);
    assert.equal(balance.total_deposited, 1_000);
    assert.equal(balance.total_revenue_credited, 25);
    assert.equal(balance.total_ecash_funded, 30);
    assert.equal(balance.total_service_spent, 60);
    assert.equal(balance.total_routing_pnl, 50);
  });
});

test('rebalance fee locks are recorded as rebalance proofs, not channel-open proofs', async () => {
  await withProofCapitalLedger(async ({ proofLedger }) => {
    const capitalLedger = new CapitalLedger({
      dataLayer: mockDataLayer(),
      auditLog: mockAuditLog(),
      mutex: mockMutex(),
      proofLedger,
    });

    await capitalLedger.recordDeposit('agent-rebalance-lock', 100, 'tx-rebalance-lock');
    await capitalLedger.confirmDeposit('agent-rebalance-lock', 100, 'tx-rebalance-lock');
    await capitalLedger.lockForChannel('agent-rebalance-lock', 12, 'rebalance-lock:instr-hash');

    const proof = proofLedger
      .listProofs({ agentId: 'agent-rebalance-lock', limit: 10 })
      .find((entry) => entry.money_event_type === 'rebalance_fee_locked');

    assert.equal(proof.event_source, 'rebalance');
    assert.equal(proof.money_event_status, 'pending');
    assert.equal(proof.capital_available_delta_sats, -12);
    assert.equal(proof.capital_locked_delta_sats, 12);
  });
});

test('capital withdraw, refund, rebalance, and funding lifecycle proofs stay public safe', async () => {
  await withProofCapitalLedger(async ({ proofLedger }) => {
    const capitalLedger = new CapitalLedger({
      dataLayer: mockDataLayer(),
      auditLog: mockAuditLog(),
      mutex: mockMutex(),
      proofLedger,
    });

    await capitalLedger.recordDeposit('agent-sensitive', 1_000, 'tx-sensitive-1');
    await capitalLedger.confirmDeposit('agent-sensitive', 1_000, 'tx-sensitive-1');
    await capitalLedger.withdraw('agent-sensitive', 120, 'bc1q_real_destination_should_not_be_public', {
      reference: 'withdraw-ref-1',
    });
    await capitalLedger.refundWithdrawal(
      'agent-sensitive',
      120,
      'bc1q_real_destination_should_not_be_public',
      'withdraw_send_failed',
      { reference: 'withdraw-ref-1' },
    );
    await capitalLedger.lockForChannel('agent-sensitive', 75, 'rebalance:payment-hash-secret');
    await capitalLedger.recordLifecycleProof('agent-sensitive', {
      moneyEventType: 'rebalance_submitted',
      moneyEventStatus: 'submitted',
      eventSource: 'rebalance',
      authorizationMethod: 'agent_signed_instruction',
      primaryAmountSats: 75,
      reference: 'rebalance-submit-secret',
      publicSafeRefs: { chan_id: '12345', instruction_hash: 'abc123' },
    });
    await capitalLedger.settleRebalance('agent-sensitive', 75, 15, 'rebalance-result-secret');
    await capitalLedger.recordFundingEvent('agent-sensitive', 'lightning_invoice_created', {
      amount_sats: 250,
      flow_id: 'flow-should-not-be-public',
      invoice: 'lnbc_should_not_be_public',
      reference: 'funding-ref-1',
      source: 'lightning_boltz',
    });
    await capitalLedger.recordLifecycleProof('agent-sensitive', {
      moneyEventType: 'swap_quote_created',
      moneyEventStatus: 'created',
      eventSource: 'swap',
      primaryAmountSats: 250,
      reference: 'swap-quote-secret',
      publicSafeRefs: { swap_id: 'swap-public-id', amount_sats: 250, provider: 'boltz' },
    });
    await capitalLedger.recordLifecycleProof('agent-sensitive', {
      moneyEventType: 'swap_payout_broadcast',
      moneyEventStatus: 'submitted',
      eventSource: 'swap',
      primaryAmountSats: 250,
      reference: 'swap-payout-secret',
      publicSafeRefs: { swap_id: 'swap-public-id', txid: 'tx-public-id', amount_sats: 250 },
    });

    const proofs = proofLedger.listProofs({ agentId: 'agent-sensitive', limit: 20 });
    assert(proofs.some((proof) => proof.money_event_type === 'capital_withdrawal_debited'));
    assert(proofs.some((proof) => proof.money_event_type === 'capital_withdrawal_refunded'));
    assert(proofs.some((proof) => proof.money_event_type === 'rebalance_fee_locked'));
    assert(proofs.some((proof) => proof.money_event_type === 'rebalance_submitted'));
    assert(proofs.some((proof) => proof.money_event_type === 'rebalance_succeeded_fee_settled'));
    assert(proofs.some((proof) => proof.money_event_type === 'lightning_capital_invoice_created'));
    assert(proofs.some((proof) => proof.money_event_type === 'swap_quote_created'));
    assert(proofs.some((proof) => proof.money_event_type === 'swap_payout_broadcast'));

    const publicRefsJson = JSON.stringify(proofs.map((proof) => proof.public_safe_refs));
    assert(!publicRefsJson.includes('bc1q_real_destination_should_not_be_public'));
    assert(!publicRefsJson.includes('payment-hash-secret'));
    assert(!publicRefsJson.includes('rebalance-submit-secret'));
    assert(!publicRefsJson.includes('rebalance-result-secret'));
    assert(!publicRefsJson.includes('flow-should-not-be-public'));
    assert(!publicRefsJson.includes('lnbc_should_not_be_public'));
    assert(!publicRefsJson.includes('swap-quote-secret'));
    assert(!publicRefsJson.includes('swap-payout-secret'));

    const balance = proofLedger.getCapitalBalance('agent-sensitive');
    assert.equal(balance.available, 985);
    assert.equal(balance.locked, 0);
    assert.equal(balance.total_withdrawn, 0);
    assert.equal(balance.total_routing_pnl, 15);
  });
});
