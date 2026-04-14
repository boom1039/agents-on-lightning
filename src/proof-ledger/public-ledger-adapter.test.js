import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { ProofLedger } from './proof-ledger.js';
import { ProofBackedPublicLedger, proofRowToPublicEntry } from './public-ledger-adapter.js';

async function withAdapter(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'aol-proof-ledger-public-adapter-'));
  const proofLedger = new ProofLedger({
    dbPath: join(dir, 'proof-ledger.sqlite'),
    keyPath: join(dir, 'proof-ledger-key.pem'),
    allowGenerateKey: true,
  });
  const publicLedger = new ProofBackedPublicLedger({ proofLedger });

  try {
    await proofLedger.ensureGenesisProof();
    await fn({ proofLedger, publicLedger });
  } finally {
    proofLedger.close();
    await rm(dir, { recursive: true, force: true });
  }
}

test('proof-backed public ledger records exact zero-delta channel lifecycle proofs', async () => {
  await withAdapter(async ({ proofLedger, publicLedger }) => {
    const entry = await publicLedger.record({
      type: 'channel_fee_policy_updated',
      agent_id: 'agent-1',
      amount_sats: 0,
      channel_id: '123',
      channel_point: 'fundingtx:0',
      action: 'set_fee_policy',
      source: 'channels_signed',
      executed_at: 1234567890,
      old_policy: { base_fee_msat: 1000 },
      new_policy: { base_fee_msat: 1500 },
    });

    assert.equal(entry.type, 'channel_policy_updated');
    assert.equal(entry.agent_id, 'agent-1');
    assert.equal(entry.amount_sats, 0);
    assert.equal(entry.channel_id, '123');
    assert.equal(entry.channel_point, 'fundingtx:0');
    assert.equal(entry.action, 'set_fee_policy');
    assert.equal(entry.source_of_truth, undefined);
    assert.match(entry.proof_hash, /^[a-f0-9]{64}$/);

    const proof = proofLedger.getProofById(entry.proof_id);
    assert.equal(proof.money_event_type, 'channel_policy_updated');
    assert.equal(proof.proof_record_type, 'money_lifecycle');
    assert.equal(proof.primary_amount_sats, 0);
    assert.equal(proof.wallet_hub_delta_sats, 0);
    assert.equal(proofLedger.verifyProof(proof).valid, true);
  });
});

test('proof-backed public ledger records paid-service fulfillment as zero-delta lifecycle proof', async () => {
  await withAdapter(async ({ proofLedger, publicLedger }) => {
    const entry = await publicLedger.record({
      type: 'analytics_query',
      agent_id: 'agent-2',
      amount_sats: 25,
      query_id: 'market-overview',
      execution_ms: 40,
    });

    assert.equal(entry.type, 'paid_service_fulfilled');
    assert.equal(entry.agent_id, 'agent-2');
    assert.equal(entry.amount_sats, 0);
    assert.equal(entry.service, 'analytics');

    const proof = proofLedger.getProofById(entry.proof_id);
    assert.equal(proof.money_event_type, 'paid_service_fulfilled');
    assert.equal(proof.proof_record_type, 'money_lifecycle');
    assert.equal(proof.wallet_ecash_delta_sats, 0);
    assert.equal(proof.capital_service_spent_delta_sats, 0);
  });
});

test('proof-backed public ledger refuses unsafe legacy money mappings', async () => {
  await withAdapter(async ({ publicLedger }) => {
    await assert.rejects(
      () => publicLedger.record({
        type: 'cashu_melt',
        agent_id: 'agent-1',
        amount_sats: 1000,
        fee_reserve_sats: 10,
      }),
      /cannot safely map legacy public ledger type/,
    );
  });
});

test('proof-backed public ledger derives getAll, agent history, and summary from proof_ledger', async () => {
  await withAdapter(async ({ proofLedger, publicLedger }) => {
    const deposit = await proofLedger.appendProof({
      idempotency_key: 'test-deposit-agent-a',
      proof_record_type: 'money_event',
      money_event_type: 'hub_deposit_settled',
      money_event_status: 'settled',
      agent_id: 'agent-a',
      event_source: 'hub_wallet',
      authorization_method: 'system_settlement',
      primary_amount_sats: 500,
      wallet_hub_delta_sats: 500,
      public_safe_refs: { amount_sats: 500, status: 'settled' },
      created_at_ms: 1000,
    });
    await proofLedger.appendProof({
      idempotency_key: 'test-policy-agent-b',
      proof_record_type: 'money_lifecycle',
      money_event_type: 'channel_policy_updated',
      money_event_status: 'confirmed',
      agent_id: 'agent-b',
      event_source: 'channels_signed',
      authorization_method: 'agent_signed_instruction',
      primary_amount_sats: 0,
      public_safe_refs: { channel_id: '456', status: 'confirmed' },
      created_at_ms: 2000,
    });

    const all = await publicLedger.getAll({ limit: 10 });
    assert.equal(all.source_of_truth, 'proof_ledger');
    assert.equal(all.entries.length, 3);
    assert.deepEqual(
      new Set(all.entries.map((entry) => entry.type)),
      new Set(['proof_ledger_started', 'hub_deposit_settled', 'channel_policy_updated']),
    );

    const filtered = await publicLedger.getAll({ type: 'hub_deposit_settled', limit: 10 });
    assert.equal(filtered.total, 1);
    assert.equal(filtered.entries[0].proof_id, deposit.proof_id);

    const agentHistory = await publicLedger.getAgentTransactions('agent-a');
    assert.equal(agentHistory.length, 1);
    assert.equal(agentHistory[0].type, 'hub_deposit_settled');

    const summary = await publicLedger.getSummary();
    assert.equal(summary.total_transactions, 3);
    assert.equal(summary.total_deposited_sats, 500);
    assert.equal(summary.unique_agents, 2);
    assert.equal(summary.source_of_truth, 'proof_ledger');
    assert.equal(summary.liability_totals.wallet_hub_sats, 500);
  });
});

test('proof public entry shape is public-safe and proof-oriented', async () => {
  await withAdapter(async ({ proofLedger }) => {
    const proof = await proofLedger.appendProof({
      idempotency_key: 'public-entry-shape',
      proof_record_type: 'money_lifecycle',
      money_event_type: 'lightning_capital_invoice_created',
      money_event_status: 'created',
      agent_id: 'agent-a',
      event_source: 'lightning_capital',
      authorization_method: 'agent_api_key',
      public_safe_refs: {
        amount_sats: 1000,
        payment_request: 'lnbc-should-not-survive',
        flow_id: 'flow-should-not-survive',
        status: 'created',
      },
    });
    const entry = proofRowToPublicEntry(proof);
    assert.equal(entry.public_safe_refs.payment_request, undefined);
    assert.equal(entry.public_safe_refs.flow_id, undefined);
    assert.equal(entry.public_safe_refs.status, 'created');
    assert.equal(entry.ledger_id, proof.proof_id);
    assert.equal(entry.proof_hash, proof.proof_hash);
  });
});
