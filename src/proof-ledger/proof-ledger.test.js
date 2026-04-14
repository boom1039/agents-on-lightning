import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  ProofLedger,
  canonicalProofJson,
  isKnownMoneyEventType,
} from './proof-ledger.js';

async function withLedger(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'aol-proof-ledger-'));
  const ledger = new ProofLedger({
    dbPath: join(dir, 'proof-ledger.sqlite'),
    keyPath: join(dir, 'proof-ledger-key.pem'),
    allowGenerateKey: true,
  });

  try {
    await fn(ledger, dir);
  } finally {
    ledger.close();
    await rm(dir, { recursive: true, force: true });
  }
}

test('proof ledger initializes sqlite WAL schema, indexes, strict checks, and known event catalog', async () => {
  await withLedger(async (ledger) => {
    assert.equal(ledger.db.pragma('journal_mode', { simple: true }), 'wal');

    const table = ledger.db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'proof_ledger'")
      .get();
    assert.equal(table.name, 'proof_ledger');

    const indexes = ledger.db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'proof_ledger'")
      .all()
      .map((row) => row.name);
    assert(indexes.includes('idx_proof_ledger_agent_sequence'));
    assert(indexes.includes('idx_proof_ledger_created_at'));
    assert(indexes.includes('idx_proof_ledger_record_type_event'));
    assert(indexes.includes('idx_proof_ledger_group'));
    assert(indexes.includes('idx_proof_ledger_agent_created'));

    const tableList = ledger.db.pragma("table_list('proof_ledger')");
    if (Object.hasOwn(tableList[0] || {}, 'strict')) {
      assert.equal(tableList[0].strict, 1);
    }

    assert.equal(isKnownMoneyEventType('capital_deposit_confirmed'), true);
    assert.equal(isKnownMoneyEventType('not_real'), false);
    assert.throws(
      () => ledger.db.prepare(`
        INSERT INTO proof_ledger (
          global_sequence,
          proof_id,
          idempotency_key,
          proof_record_type,
          money_event_type,
          money_event_status,
          event_source,
          authorization_method,
          balance_snapshot_before_json,
          balance_snapshot_after_json,
          public_safe_refs_json,
          issuer_domains_json,
          signing_key_id,
          proof_hash,
          canonical_proof_json,
          platform_signature,
          created_at_ms
        ) VALUES (
          1,
          'bad-proof',
          'bad-idempotency',
          'not_valid',
          'proof_ledger_started',
          'confirmed',
          'test',
          'operator_adjustment',
          '{}',
          '{}',
          '{}',
          '[]',
          'key',
          'hash',
          '{}',
          'sig',
          1
        )
      `).run(),
      /CHECK constraint failed/,
    );
  });
});

test('genesis proof is signed, hash-linked, idempotent, and verifiable', async () => {
  await withLedger(async (ledger) => {
    const genesis = await ledger.ensureGenesisProof();
    assert.equal(genesis.global_sequence, 1);
    assert.equal(genesis.proof_record_type, 'genesis');
    assert.equal(genesis.money_event_type, 'proof_ledger_started');
    assert.equal(genesis.previous_global_proof_hash, null);
    assert.equal(genesis.previous_agent_proof_hash, null);
    assert.equal(genesis.agent_proof_sequence, null);
    assert.match(genesis.public_safe_refs.note, /Proof Ledger starts here/);

    assert.deepEqual(await ledger.ensureGenesisProof(), null);
    const duplicate = await ledger.createGenesisProof();
    assert.equal(duplicate.proof_id, genesis.proof_id);
    assert.equal(ledger.listProofs().length, 1);

    assert.deepEqual(ledger.verifyProof(genesis.proof_id), {
      valid: true,
      proof_id: genesis.proof_id,
      proof_hash: genesis.proof_hash,
      errors: [],
    });
    assert.equal(ledger.verifyChain().valid, true);
  });
});

test('canonical proof JSON is stable and rejects unsafe values', () => {
  assert.equal(
    canonicalProofJson({ b: 2, a: { d: 4, c: [3, 'x'] } }),
    '{"a":{"c":[3,"x"],"d":4},"b":2}',
  );

  for (const value of [
    { bad: undefined },
    { bad: Number.NaN },
    { bad: Infinity },
    { bad: 0.25 },
    { bad: Number.MAX_SAFE_INTEGER + 1 },
    { bad: () => {} },
    { bad: new Date(0) },
    { bad: Buffer.from('secret') },
    Object.assign(Object.create({ inherited: true }), { ok: true }),
  ]) {
    assert.throws(() => canonicalProofJson(value), /Canonical JSON rejects/);
  }
});

test('appendProof computes snapshots, links global and agent chains, and prevents duplicate idempotency', async () => {
  await withLedger(async (ledger) => {
    await ledger.createGenesisProof();
    const proof = await ledger.appendProof({
      idempotency_key: 'hub-deposit-settled:agent-a:payment-hash-1',
      proof_record_type: 'money_event',
      money_event_type: 'hub_deposit_settled',
      money_event_status: 'settled',
      agent_id: 'agent-a',
      event_source: 'hub_wallet',
      authorization_method: 'system_settlement',
      primary_amount_sats: 1000,
      wallet_hub_delta_sats: 1000,
      public_safe_refs: {
        amount_sats: 1000,
        status: 'settled',
      },
    });

    assert.equal(proof.global_sequence, 2);
    assert.equal(proof.agent_proof_sequence, 1);
    assert.equal(proof.balance_snapshot_before.wallet_hub_sats, 0);
    assert.equal(proof.balance_snapshot_after.wallet_hub_sats, 1000);
    assert.equal(ledger.getAgentBalance('agent-a').wallet_hub_sats, 1000);
    assert.equal(ledger.getLiabilityTotals().wallet_hub_sats, 1000);
    assert.equal(ledger.verifyProof(proof).valid, true);
    assert.equal(ledger.verifyChain().valid, true);
    assert.equal(ledger.verifyChain({ agentId: 'agent-a' }).valid, true);

    const duplicate = await ledger.appendProof({
      idempotency_key: 'hub-deposit-settled:agent-a:payment-hash-1',
      proof_record_type: 'money_event',
      money_event_type: 'hub_deposit_settled',
      money_event_status: 'settled',
      agent_id: 'agent-a',
      event_source: 'hub_wallet',
      authorization_method: 'system_settlement',
      primary_amount_sats: 1000,
      wallet_hub_delta_sats: 1000,
    });
    assert.equal(duplicate.proof_id, proof.proof_id);
    assert.equal(ledger.listProofs().length, 2);
  });
});

test('liability checkpoints, reserve snapshots, and reconciliations are signed public proof rows', async () => {
  await withLedger(async (ledger) => {
    await ledger.createGenesisProof();
    await ledger.appendProof({
      idempotency_key: 'liability-source:agent-a',
      proof_record_type: 'money_event',
      money_event_type: 'hub_deposit_settled',
      money_event_status: 'settled',
      agent_id: 'agent-a',
      event_source: 'hub_wallet',
      authorization_method: 'system_settlement',
      primary_amount_sats: 1500,
      wallet_hub_delta_sats: 1500,
      public_safe_refs: { amount_sats: 1500, status: 'settled' },
    });

    const checkpoint = await ledger.createLiabilityCheckpoint({ createdAtMs: 1713021600000 });
    assert.equal(checkpoint.proof_record_type, 'liability_checkpoint');
    assert.equal(checkpoint.money_event_type, 'liability_checkpoint_created');
    assert.equal(checkpoint.primary_amount_sats, 1500);
    assert.equal(checkpoint.public_safe_refs.total_liability_sats, 1500);
    assert.equal(checkpoint.public_safe_refs.liability_totals_by_bucket.wallet_hub_sats, 1500);
    assert.equal(checkpoint.public_safe_refs.checkpointed_through_global_sequence, 2);
    assert.equal(ledger.verifyProof(checkpoint).valid, true);

    const duplicateCheckpoint = await ledger.createLiabilityCheckpoint({ createdAtMs: 1713021601000 });
    assert.equal(duplicateCheckpoint.proof_id, checkpoint.proof_id);

    const reserve = await ledger.createReserveSnapshot({
      reserveTotalsBySource: {
        lnd_onchain: { reserve_source_type: 'lnd_onchain_wallet', amount_sats: 2000 },
        cashu_mint: 500,
      },
      reserveEvidenceRefs: [
        { evidence_type: 'operator_attested', txid: 'reserve-evidence-txid' },
      ],
      reserveSufficient: true,
      createdAtMs: 1713021602000,
    });
    assert.equal(reserve.proof_record_type, 'reserve_snapshot');
    assert.equal(reserve.money_event_type, 'reserve_snapshot_created');
    assert.equal(reserve.primary_amount_sats, 2500);
    assert.deepEqual(reserve.public_safe_refs.reserve_totals_by_source, [
      {
        amount_sats: 2000,
        reserve_source_name: 'lnd_onchain',
        reserve_source_type: 'lnd_onchain_wallet',
      },
      {
        amount_sats: 500,
        reserve_source_name: 'cashu_mint',
      },
    ]);
    assert.equal(reserve.public_safe_refs.reserve_evidence_refs[0].txid, 'reserve-evidence-txid');
    assert.equal(ledger.verifyProof(reserve).valid, true);

    const duplicateReserve = await ledger.createReserveSnapshot({
      reserveTotalsBySource: {
        lnd_onchain: { reserve_source_type: 'lnd_onchain_wallet', amount_sats: 2000 },
        cashu_mint: 500,
      },
      reserveEvidenceRefs: [
        { evidence_type: 'operator_attested', txid: 'reserve-evidence-txid' },
      ],
      reserveSufficient: true,
    });
    assert.equal(duplicateReserve.proof_id, reserve.proof_id);

    const reconciliation = await ledger.createReconciliationProof({
      reconciliationStatus: 'reserves_cover_liabilities',
      reserveSufficient: true,
      createdAtMs: 1713021603000,
    });
    assert.equal(reconciliation.proof_record_type, 'reconciliation');
    assert.equal(reconciliation.money_event_type, 'reconciliation_completed');
    assert.equal(reconciliation.public_safe_refs.reconciliation_status, 'reserves_cover_liabilities');
    assert.equal(reconciliation.public_safe_refs.total_liability_sats, 1500);
    assert.equal(reconciliation.public_safe_refs.total_reserve_sats, 2500);
    assert.equal(ledger.verifyChain().valid, true);
  });
});

test('appendProofGroup commits multi-row events atomically and detects partial duplicate groups', async () => {
  await withLedger(async (ledger) => {
    await ledger.createGenesisProof();
    const group = await ledger.appendProofGroup([
      {
        idempotency_key: 'transfer:1:debit',
        proof_group_id: 'transfer:1',
        proof_record_type: 'money_event',
        money_event_type: 'hub_transfer_debited',
        money_event_status: 'settled',
        agent_id: 'agent-a',
        event_source: 'hub_wallet',
        authorization_method: 'agent_api_key',
        primary_amount_sats: 300,
        wallet_hub_delta_sats: -300,
      },
      {
        idempotency_key: 'transfer:1:credit',
        proof_group_id: 'transfer:1',
        proof_record_type: 'money_event',
        money_event_type: 'hub_transfer_credited',
        money_event_status: 'settled',
        agent_id: 'agent-b',
        event_source: 'hub_wallet',
        authorization_method: 'agent_api_key',
        primary_amount_sats: 300,
        wallet_hub_delta_sats: 300,
      },
    ]);

    assert.equal(group.length, 2);
    assert.equal(group[0].proof_group_id, 'transfer:1');
    assert.equal(group[1].global_sequence, group[0].global_sequence + 1);
    assert.equal(ledger.getAgentBalance('agent-a').wallet_hub_sats, -300);
    assert.equal(ledger.getAgentBalance('agent-b').wallet_hub_sats, 300);
    assert.equal(ledger.verifyChain().valid, true);

    const duplicate = await ledger.appendProofGroup([
      {
        idempotency_key: 'transfer:1:debit',
        proof_group_id: 'transfer:1',
        proof_record_type: 'money_event',
        money_event_type: 'hub_transfer_debited',
        money_event_status: 'settled',
        agent_id: 'agent-a',
        event_source: 'hub_wallet',
        authorization_method: 'agent_api_key',
      },
      {
        idempotency_key: 'transfer:1:credit',
        proof_group_id: 'transfer:1',
        proof_record_type: 'money_event',
        money_event_type: 'hub_transfer_credited',
        money_event_status: 'settled',
        agent_id: 'agent-b',
        event_source: 'hub_wallet',
        authorization_method: 'agent_api_key',
      },
    ]);
    assert.deepEqual(duplicate.map((row) => row.proof_id), group.map((row) => row.proof_id));

    await assert.rejects(
      () => ledger.appendProofGroup([
        {
          idempotency_key: 'transfer:1:debit',
          proof_group_id: 'transfer:2',
          proof_record_type: 'money_event',
          money_event_type: 'hub_transfer_debited',
          money_event_status: 'settled',
          agent_id: 'agent-a',
          event_source: 'hub_wallet',
          authorization_method: 'agent_api_key',
        },
        {
          idempotency_key: 'transfer:2:credit',
          proof_group_id: 'transfer:2',
          proof_record_type: 'money_event',
          money_event_type: 'hub_transfer_credited',
          money_event_status: 'settled',
          agent_id: 'agent-b',
          event_source: 'hub_wallet',
          authorization_method: 'agent_api_key',
        },
      ]),
      /PROOF_GROUP_IDEMPOTENCY_CONFLICT/,
    );

    await assert.rejects(
      () => ledger.appendProofGroup([
        {
          idempotency_key: 'bad-group:valid',
          proof_group_id: 'bad-group',
          proof_record_type: 'money_event',
          money_event_type: 'hub_transfer_debited',
          money_event_status: 'settled',
          agent_id: 'agent-a',
          event_source: 'hub_wallet',
          authorization_method: 'agent_api_key',
        },
        {
          idempotency_key: 'bad-group:invalid',
          proof_group_id: 'bad-group',
          proof_record_type: 'money_event',
          money_event_type: 'not_a_real_event',
          money_event_status: 'settled',
          agent_id: 'agent-b',
          event_source: 'hub_wallet',
          authorization_method: 'agent_api_key',
        },
      ]),
      /money_event_type has unsupported value/,
    );
    assert.equal(ledger.listProofs().length, 3);
  });
});

test('callers cannot forge computed fields and public refs are allow-list sanitized', async () => {
  await withLedger(async (ledger) => {
    await assert.rejects(
      () => ledger.appendProof({
        idempotency_key: 'forged-balance',
        proof_record_type: 'money_event',
        money_event_type: 'hub_internal_credit',
        money_event_status: 'confirmed',
        agent_id: 'agent-a',
        event_source: 'test',
        authorization_method: 'operator_adjustment',
        wallet_hub_delta_sats: 100,
        balance_snapshot_after_json: '{"wallet_hub_sats":999999}',
      }),
      /balance_snapshot_after_json is computed by ProofLedger/,
    );

    const sanitized = await ledger.appendProof({
      idempotency_key: 'sanitize:1',
      proof_record_type: 'money_event',
      money_event_type: 'capital_deposit_pending',
      money_event_status: 'pending',
      agent_id: 'agent-a',
      event_source: 'capital',
      authorization_method: 'system_settlement',
      capital_pending_deposit_delta_sats: 1000,
      public_safe_refs: {
        amount_sats: 1000,
        status: 'pending',
        api_key: 'secret',
        bearer_token: 'secret',
        cashu_token: 'cashuA...',
        proofs: [{ secret: 'secret' }],
        payment_request: 'lnbc...',
        payment_hash: 'raw-payment-hash',
        preimage: 'secret-preimage',
        boltz_claim_private_key: 'secret',
        bridge_provider_blob: { secret: true },
        address: 'bc1qfulladdress',
        flow_id: 'flow-secret',
        signature: 'raw-signature',
        nested: {
          api_key: 'secret',
          amount_sats: 1000,
        },
      },
    });
    assert.deepEqual(sanitized.public_safe_refs, {
      amount_sats: 1000,
      status: 'pending',
    });

    const explicitlyAllowed = await ledger.appendProof({
      idempotency_key: 'sanitize:2',
      proof_record_type: 'money_lifecycle',
      money_event_type: 'lightning_capital_bridge_started',
      money_event_status: 'pending',
      agent_id: 'agent-a',
      event_source: 'lightning_capital',
      authorization_method: 'system_settlement',
      public_safe_refs: {
        flow_id: 'flow-public-enough-for-agent-view',
        status: 'pending',
      },
      allowed_public_ref_keys: ['flow_id'],
    });
    assert.equal(explicitlyAllowed.public_safe_refs.flow_id, 'flow-public-enough-for-agent-view');
  });
});

test('public key metadata is stable enough for agent proof verification', async () => {
  await withLedger(async (ledger, dir) => {
    const keyInfo = ledger.getPublicKeyInfo();
    assert.match(keyInfo.signing_key_id, /^ed25519:/);
    assert.match(keyInfo.public_key_pem, /BEGIN PUBLIC KEY/);
    assert.match(keyInfo.public_key_raw_base64url, /^[A-Za-z0-9_-]+$/);
    assert.deepEqual(keyInfo.issuer_domains, [
      'agentsonlightning.com',
      'agentsonbitcoin.com',
      'lightningobservatory.com',
    ]);
    assert.equal(keyInfo.canonicalization_version, 'aol-proof-v1');

    const keyStat = await stat(join(dir, 'proof-ledger-key.pem'));
    assert.equal(keyStat.mode & 0o777, 0o600);
  });
});

test('production-style construction refuses to generate a missing signing key', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'aol-proof-ledger-missing-key-'));
  try {
    assert.throws(
      () => new ProofLedger({
        dbPath: join(dir, 'proof-ledger.sqlite'),
        keyPath: join(dir, 'missing-key.pem'),
        allowGenerateKey: false,
      }),
      /Proof Ledger signing key is required/,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('free-text note refs require explicit allow-listing', async () => {
  await withLedger(async (ledger) => {
    const proof = await ledger.appendProof({
      idempotency_key: 'note-not-public-by-default',
      proof_record_type: 'money_lifecycle',
      money_event_type: 'paid_service_fulfilled',
      money_event_status: 'confirmed',
      agent_id: 'agent-a',
      event_source: 'paid_services',
      authorization_method: 'agent_api_key',
      public_safe_refs: {
        note: 'free text is risky unless the event explicitly allows it',
        service: 'test',
      },
    });
    assert.deepEqual(proof.public_safe_refs, { service: 'test' });
  });
});
