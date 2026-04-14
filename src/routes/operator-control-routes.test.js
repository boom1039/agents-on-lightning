import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { operatorControlRoutes } from './operator-control-routes.js';
import { ProofLedger } from '../proof-ledger/proof-ledger.js';

async function startOperatorRouteApp(daemon) {
  const app = express();
  app.use(express.json());
  app.use(operatorControlRoutes(daemon));
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const { port } = server.address();
  return { server, baseUrl: `http://127.0.0.1:${port}` };
}

async function withOperatorProofLedger(work) {
  const prevSecret = process.env.OPERATOR_API_SECRET;
  const prevEnabled = process.env.ENABLE_OPERATOR_ROUTES;
  process.env.OPERATOR_API_SECRET = 'proof-operator-secret';
  process.env.ENABLE_OPERATOR_ROUTES = '1';

  const tempDir = await mkdtemp(join(tmpdir(), 'aol-operator-proof-routes-'));
  const proofLedger = new ProofLedger({
    dbPath: join(tempDir, 'proof-ledger.sqlite'),
    keyPath: join(tempDir, 'proof-ledger.key.pem'),
    allowGenerateKey: true,
  });

  try {
    await proofLedger.ensureGenesisProof();
    await work({ proofLedger });
  } finally {
    proofLedger.close();
    await rm(tempDir, { recursive: true, force: true });
    if (prevSecret === undefined) delete process.env.OPERATOR_API_SECRET;
    else process.env.OPERATOR_API_SECRET = prevSecret;
    if (prevEnabled === undefined) delete process.env.ENABLE_OPERATOR_ROUTES;
    else process.env.ENABLE_OPERATOR_ROUTES = prevEnabled;
  }
}

async function postJson(baseUrl, path, body, secret = 'proof-operator-secret') {
  const headers = { 'content-type': 'application/json' };
  if (secret) headers['x-operator-secret'] = secret;
  const response = await fetch(new URL(path, baseUrl), {
    method: 'POST',
    headers,
    body: JSON.stringify(body || {}),
  });
  return { response, body: await response.json() };
}

test('operator proof routes create signed liability, reserve, and reconciliation proofs', async () => {
  await withOperatorProofLedger(async ({ proofLedger }) => {
    await proofLedger.appendProof({
      idempotency_key: 'operator-proof-routes:seed-liability',
      proof_record_type: 'money_event',
      money_event_type: 'hub_deposit_settled',
      money_event_status: 'settled',
      agent_id: 'agent-proof-operator',
      event_source: 'hub_wallet',
      authorization_method: 'system_settlement',
      primary_amount_sats: 4000,
      wallet_hub_delta_sats: 4000,
      public_safe_refs: { amount_sats: 4000, status: 'settled' },
    });

    const { server, baseUrl } = await startOperatorRouteApp({ proofLedger });
    try {
      const unauthorized = await postJson(baseUrl, '/api/operator/proof-ledger/liability-checkpoint', {}, null);
      assert.equal(unauthorized.response.status, 403);

      const checkpoint = await postJson(baseUrl, '/api/operator/proof-ledger/liability-checkpoint', {
        created_at_ms: 1713021600000,
      });
      assert.equal(checkpoint.response.status, 200);
      assert.equal(checkpoint.body.source_of_truth, 'proof_ledger');
      assert.equal(checkpoint.body.proof.proof_record_type, 'liability_checkpoint');
      assert.equal(checkpoint.body.proof.money_event_type, 'liability_checkpoint_created');
      assert.equal(checkpoint.body.proof.public_safe_refs.total_liability_sats, 4000);
      assert.equal(checkpoint.body.verification.valid, true);

      const reserve = await postJson(baseUrl, '/api/operator/proof-ledger/reserve-snapshot', {
        reserve_totals_by_source: {
          lnd_onchain: { reserve_source_type: 'lnd_onchain_wallet', amount_sats: 6000 },
        },
        reserve_evidence_refs: [
          { evidence_type: 'operator_attested', txid: 'reserve-proof-txid' },
        ],
        reserve_sufficient: true,
        created_at_ms: 1713021601000,
      });
      assert.equal(reserve.response.status, 200);
      assert.equal(reserve.body.proof.proof_record_type, 'reserve_snapshot');
      assert.equal(reserve.body.proof.public_safe_refs.total_reserve_sats, 6000);
      assert.equal(reserve.body.proof.public_safe_refs.reserve_sufficient, true);
      assert.equal(reserve.body.verification.valid, true);

      const reconciliation = await postJson(baseUrl, '/api/operator/proof-ledger/reconciliation', {
        reconciliation_status: 'reserves_cover_liabilities',
        reserve_sufficient: true,
        created_at_ms: 1713021602000,
      });
      assert.equal(reconciliation.response.status, 200);
      assert.equal(reconciliation.body.proof.proof_record_type, 'reconciliation');
      assert.equal(reconciliation.body.proof.public_safe_refs.reconciliation_status, 'reserves_cover_liabilities');
      assert.equal(reconciliation.body.proof.public_safe_refs.total_liability_sats, 4000);
      assert.equal(reconciliation.body.proof.public_safe_refs.total_reserve_sats, 6000);
      assert.equal(reconciliation.body.global_chain.valid, true);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });
});

test('operator reserve snapshot route rejects empty reserve evidence totals', async () => {
  await withOperatorProofLedger(async ({ proofLedger }) => {
    const { server, baseUrl } = await startOperatorRouteApp({ proofLedger });
    try {
      const result = await postJson(baseUrl, '/api/operator/proof-ledger/reserve-snapshot', {
        reserve_totals_by_source: {},
      });
      assert.equal(result.response.status, 400);
      assert.equal(result.body.error, 'reserve_totals_by_source required');
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });
});
