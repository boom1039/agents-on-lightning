import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { ProofLedger } from './proof-ledger.js';
import { buildAgentProofTrace, withAgentProofTrace } from './agent-proof-trace.js';

const LEGACY_SECRET_FIELD = ['api', 'key'].join('_');

function sha256Hex(value) {
  return createHash('sha256').update(String(value), 'utf8').digest('hex');
}

async function withProofLedger(work) {
  const dir = await mkdtemp(join(tmpdir(), 'aol-agent-proof-trace-'));
  const proofLedger = new ProofLedger({
    dbPath: join(dir, 'proof-ledger.sqlite'),
    keyPath: join(dir, 'proof-ledger-key.pem'),
    allowGenerateKey: true,
  });

  try {
    await proofLedger.ensureGenesisProof();
    await work(proofLedger);
  } finally {
    proofLedger.close();
    await rm(dir, { recursive: true, force: true });
  }
}

test('agent proof trace filters signed rows by source, direct refs, and hashed refs', async () => {
  await withProofLedger(async (proofLedger) => {
    await proofLedger.appendProof({
      idempotency_key: 'trace-paid-service',
      proof_record_type: 'money_event',
      money_event_type: 'paid_service_charge_debited',
      money_event_status: 'settled',
      agent_id: 'agent-trace',
      event_source: 'paid_service',
      authorization_method: 'agent_signed_request',
      primary_amount_sats: 10,
      capital_available_delta_sats: -10,
      public_safe_refs: {
        service: 'analytics',
        service_id: 'channel_history',
        amount_sats: 10,
        [LEGACY_SECRET_FIELD]: 'must-not-survive',
      },
    });
    await proofLedger.appendProof({
      idempotency_key: 'trace-swap',
      proof_record_type: 'money_lifecycle',
      money_event_type: 'swap_submitted',
      money_event_status: 'submitted',
      agent_id: 'agent-trace',
      event_source: 'swap',
      authorization_method: 'agent_signed_request',
      primary_amount_sats: 25,
      public_safe_refs: {
        swap_id: 'swap-1',
        amount_sats: 25,
        status: 'submitted',
      },
    });
    await proofLedger.appendProof({
      idempotency_key: 'trace-flow',
      proof_record_type: 'money_lifecycle',
      money_event_type: 'lightning_capital_invoice_created',
      money_event_status: 'created',
      agent_id: 'agent-trace',
      event_source: 'lightning_capital',
      authorization_method: 'agent_signed_request',
      primary_amount_sats: 50,
      public_safe_refs: {
        flow_hash: sha256Hex('flow-1'),
        amount_sats: 50,
        status: 'created',
      },
      allowed_public_ref_keys: ['flow_hash'],
    });
    await proofLedger.appendProof({
      idempotency_key: 'trace-rebalance',
      proof_record_type: 'money_event',
      money_event_type: 'rebalance_succeeded_fee_settled',
      money_event_status: 'settled',
      agent_id: 'agent-trace',
      event_source: 'rebalance',
      authorization_method: 'agent_signed_instruction',
      primary_amount_sats: 7,
      fee_sats: 2,
      public_safe_refs: {
        reference_hash: sha256Hex('rebalance:payment-1'),
        amount_sats: 7,
        status: 'settled',
      },
      allowed_public_ref_keys: ['reference_hash'],
    });

    const swapTrace = buildAgentProofTrace(proofLedger, 'agent-trace', {
      scope: 'swap',
      eventSources: ['swap'],
      match: { swap_id: 'swap-1' },
    });
    assert.equal(swapTrace.available, true);
    assert.equal(swapTrace.count, 1);
    assert.equal(swapTrace.proofs[0].money_event_type, 'swap_submitted');
    assert.equal(swapTrace.proofs[0].signature_valid, true);

    const flowTrace = buildAgentProofTrace(proofLedger, 'agent-trace', {
      scope: 'lightning_capital',
      eventSources: ['lightning_capital'],
      match: { flow_id: 'flow-1' },
    });
    assert.equal(flowTrace.count, 1);
    assert.equal(flowTrace.proofs[0].money_event_type, 'lightning_capital_invoice_created');

    const rebalanceTrace = buildAgentProofTrace(proofLedger, 'agent-trace', {
      scope: 'rebalance',
      eventSources: ['rebalance'],
      match: { referenceValues: ['rebalance:payment-1'] },
    });
    assert.equal(rebalanceTrace.count, 1);
    assert.equal(rebalanceTrace.proofs[0].money_event_type, 'rebalance_succeeded_fee_settled');

    const analyticsTrace = buildAgentProofTrace(proofLedger, 'agent-trace', {
      scope: 'paid_service_analytics',
      eventSources: ['paid_service'],
      match: { service: 'analytics', service_id: 'channel_history' },
    });
    assert.equal(analyticsTrace.count, 1);
    assert.equal(analyticsTrace.proofs[0].public_safe_refs[LEGACY_SECRET_FIELD], undefined);

    const noMatchTrace = buildAgentProofTrace(proofLedger, 'agent-trace', {
      scope: 'swap',
      eventSources: ['swap'],
      requireMatch: true,
    });
    assert.equal(noMatchTrace.count, 0);
  });
});

test('withAgentProofTrace adds an unavailable proof chain when no ledger is present', () => {
  const body = withAgentProofTrace({ success: true }, null, 'agent-trace', { scope: 'swap' });
  assert.equal(body.success, true);
  assert.equal(body.proof_context.source_of_truth, 'proof_ledger');
  assert.equal(body.proof_chain.available, false);
  assert.deepEqual(body.proof_chain.proofs, []);
});
