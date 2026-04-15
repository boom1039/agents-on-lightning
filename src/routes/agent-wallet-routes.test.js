import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { configureRateLimiterPolicy } from '../identity/rate-limiter.js';
import {
  INTERNAL_AUTH_AUDIENCE_HEADER,
  INTERNAL_AUTH_PAYLOAD_HASH_HEADER,
  INTERNAL_VERIFIED_AGENT_ID_HEADER,
} from '../identity/signed-auth.js';
import { ProofLedger } from '../proof-ledger/proof-ledger.js';
import { agentWalletRoutes } from './agent-wallet-routes.js';

const TEST_INTERNAL_MCP_SECRET = 'test-wallet-route-internal-mcp';

function authHeaders(agentId) {
  return {
    'x-aol-internal-mcp': TEST_INTERNAL_MCP_SECRET,
    [INTERNAL_VERIFIED_AGENT_ID_HEADER]: agentId,
    [INTERNAL_AUTH_PAYLOAD_HASH_HEADER]: 'a'.repeat(64),
    [INTERNAL_AUTH_AUDIENCE_HEADER]: 'http://127.0.0.1/mcp',
  };
}

async function startWalletRouteApp(daemon) {
  configureRateLimiterPolicy({
    categories: {
      wallet_read: { limit: 100, windowMs: 60_000 },
      wallet_write: { limit: 100, windowMs: 60_000 },
      discovery: { limit: 100, windowMs: 60_000 },
    },
    globalCap: { limit: 1_000, windowMs: 60_000 },
    progressive: {
      resetWindowMs: 60_000,
      thresholds: [
        { violations: 10, multiplier: 4 },
        { violations: 5, multiplier: 2 },
      ],
    },
  });

  const app = express();
  app.use(express.json());
  process.env.AOL_INTERNAL_MCP_SECRET = TEST_INTERNAL_MCP_SECRET;
  app.use(agentWalletRoutes(daemon));
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  return {
    server,
    baseUrl: `http://127.0.0.1:${address.port}`,
  };
}

test('wallet mint quote rejects before invoice when single-channel inbound capacity is too low', async () => {
  let mintQuoteCalled = false;
  const daemon = {
    config: {},
    agentRegistry: {
      getById: (agentId) => agentId === 'aaaaaaaa' ? { id: 'aaaaaaaa', name: 'aaaaaaaa' } : null,
    },
    nodeManager: {
      getScopedDefaultNodeOrNull: () => ({
        listChannels: async () => ({
          channels: [{
            active: true,
            remote_balance: '25000',
            unsettled_balance: '0',
            remote_constraints: { chan_reserve_sat: '1000' },
          }],
        }),
      }),
    },
    agentCashuWallet: {
      mintQuote: async () => {
        mintQuoteCalled = true;
        return { quote: 'quote', request: 'lnbc_should_not_exist', state: 'UNPAID' };
      },
    },
  };
  const { server, baseUrl } = await startWalletRouteApp(daemon);

  try {
    const response = await fetch(new URL('/api/v1/wallet/mint-quote', baseUrl), {
      method: 'POST',
      headers: {
        ...authHeaders('aaaaaaaa'),
        'content-type': 'application/json',
      },
      body: JSON.stringify({ amount_sats: 100_000 }),
    });
    const body = await response.json();

    assert.equal(response.status, 409);
    assert.equal(body.error, 'wallet_mint_receive_preflight_failed');
    assert.equal(body.receive_preflight.can_receive, false);
    assert.equal(body.receive_preflight.suggested_max_sats, 23_000);
    assert.equal(mintQuoteCalled, false);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('ledger route prefers proof-backed public ledger when available', async () => {
  const daemon = {
    agentRegistry: { getById: () => null },
    publicLedger: {
      getAll: async () => ({
        entries: [{ ledger_id: 'legacy-row', payment_request: 'lnbc_should_not_leak' }],
        total: 1,
      }),
    },
    proofBackedPublicLedger: {
      getAll: async () => ({
        entries: [{
          ledger_id: 'proof-row',
          proof_id: 'proof-row',
          type: 'proof_ledger_started',
          payment_request: 'lnbc_should_not_leak',
        }],
        total: 1,
        source_of_truth: 'proof_ledger',
      }),
    },
  };
  const { server, baseUrl } = await startWalletRouteApp(daemon);

  try {
    const response = await fetch(new URL('/api/v1/ledger', baseUrl));
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(body.source_of_truth, 'proof_ledger');
    assert.equal(body.entries[0].ledger_id, 'proof-row');
    assert.equal(body.entries[0].payment_request, undefined);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('proof routes expose agent-owned signed proofs and public liability status', async () => {
  const tempDir = await mkdtemp(join(tmpdir(), 'aol-proof-routes-'));
  const proofLedger = new ProofLedger({
    dbPath: join(tempDir, 'proof-ledger.sqlite'),
    keyPath: join(tempDir, 'proof-ledger.key.pem'),
    allowGenerateKey: true,
  });
  await proofLedger.ensureGenesisProof();
  const proof = await proofLedger.appendProof({
    idempotency_key: 'test-aaaaaaaa-proof-route',
    proof_record_type: 'money_event',
    money_event_type: 'wallet_mint_issued',
    money_event_status: 'settled',
    agent_id: 'bbbbbbbb',
    event_source: 'wallet',
    authorization_method: 'system_settlement',
    primary_amount_sats: 1234,
    wallet_ecash_delta_sats: 1234,
    public_safe_refs: { quote_id: 'quote-123', amount_sats: 1234 },
    allowed_public_ref_keys: ['quote_id'],
  });
  const liabilityCheckpoint = await proofLedger.createLiabilityCheckpoint({ createdAtMs: 1713021600000 });
  const reserveSnapshot = await proofLedger.createReserveSnapshot({
    reserveTotalsBySource: { lnd_onchain: { reserve_source_type: 'lnd_onchain_wallet', amount_sats: 2000 } },
    reserveEvidenceRefs: [{ evidence_type: 'operator_attested', txid: 'reserve-txid' }],
    reserveSufficient: true,
    createdAtMs: 1713021601000,
  });
  const daemon = {
    proofLedger,
    agentRegistry: {
      getById: (agentId) => agentId === 'bbbbbbbb' ? { id: 'bbbbbbbb', name: 'bbbbbbbb' } : null,
    },
    publicLedger: {
      getAll: async () => ({ entries: [], total: 0 }),
    },
  };
  const { server, baseUrl } = await startWalletRouteApp(daemon);

  try {
    const signedAuthHeaders = authHeaders('bbbbbbbb');
    const balanceResponse = await fetch(new URL('/api/v1/proofs/me/balance', baseUrl), {
      headers: signedAuthHeaders,
    });
    const balanceBody = await balanceResponse.json();
    assert.equal(balanceResponse.status, 200);
    assert.equal(balanceBody.source_of_truth, 'proof_ledger');
    assert.equal(balanceBody.balance.wallet_ecash_sats, 1234);
    assert.equal(balanceBody.latest_agent_proof.proof_id, proof.proof_id);
    assert.equal(balanceBody.agent_chain.valid, true);

    const listResponse = await fetch(new URL('/api/v1/proofs/me?limit=10', baseUrl), {
      headers: signedAuthHeaders,
    });
    const listBody = await listResponse.json();
    assert.equal(listResponse.status, 200);
    assert.equal(listBody.total, 1);
    assert.equal(listBody.proofs[0].proof_id, proof.proof_id);
    assert.match(listBody.proofs[0].canonical_proof_json, /wallet_mint_issued/);

    const proofResponse = await fetch(new URL(`/api/v1/proofs/proof/${proof.proof_id}`, baseUrl), {
      headers: signedAuthHeaders,
    });
    const proofBody = await proofResponse.json();
    assert.equal(proofResponse.status, 200);
    assert.equal(proofBody.proof.proof_id, proof.proof_id);
    assert.equal(proofBody.verification.valid, true);

    const verifyResponse = await fetch(new URL(`/api/v1/proofs/proof/${proof.proof_id}/verify`, baseUrl), {
      headers: signedAuthHeaders,
    });
    const verifyBody = await verifyResponse.json();
    assert.equal(verifyResponse.status, 200);
    assert.equal(verifyBody.verification.valid, true);
    assert.equal(verifyBody.agent_chain.valid, true);

    const bundleResponse = await fetch(new URL(`/api/v1/proofs/proof/${proof.proof_id}/bundle`, baseUrl), {
      headers: signedAuthHeaders,
    });
    const bundleBody = await bundleResponse.json();
    assert.equal(bundleResponse.status, 200);
    assert.equal(bundleBody.bundle_version, 'aol-proof-bundle-v1');
    assert.equal(bundleBody.proof.proof_id, proof.proof_id);
    assert.equal(bundleBody.previous_agent_proof, null);
    assert.equal(bundleBody.latest_liability_checkpoint.proof_id, liabilityCheckpoint.proof_id);
    assert.equal(bundleBody.latest_reserve_snapshot.proof_id, reserveSnapshot.proof_id);
    assert.equal(bundleBody.public_key.signing_key_id, proofLedger.getPublicKeyInfo().signing_key_id);

    const liabilitiesResponse = await fetch(new URL('/api/v1/proofs/liabilities', baseUrl));
    const liabilitiesBody = await liabilitiesResponse.json();
    assert.equal(liabilitiesResponse.status, 200);
    assert.equal(liabilitiesBody.proof_of_liabilities.live_derived_liability_totals.wallet_ecash_sats, 1234);
    assert.equal(
      liabilitiesBody.proof_of_liabilities.latest_signed_liability_checkpoint.proof_id,
      liabilityCheckpoint.proof_id,
    );
    assert.equal(liabilitiesBody.proof_of_liabilities.global_chain.valid, true);

    const reservesResponse = await fetch(new URL('/api/v1/proofs/reserves', baseUrl));
    const reservesBody = await reservesResponse.json();
    assert.equal(reservesResponse.status, 200);
    assert.equal(reservesBody.proof_of_reserves.status, 'operator_attested_snapshot_available');
    assert.equal(reservesBody.proof_of_reserves.latest_reserve_snapshot.proof_id, reserveSnapshot.proof_id);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    proofLedger.close();
    await rm(tempDir, { recursive: true, force: true });
  }
});
