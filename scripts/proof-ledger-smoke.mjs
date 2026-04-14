import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

import { ProofLedger } from '../src/proof-ledger/proof-ledger.js';

const baseUrl = process.env.AOL_PROOF_LEDGER_SMOKE_BASE_URL || process.env.AOL_MCP_BASE_URL || 'http://127.0.0.1:3302';
const hostedEnabled = process.env.AOL_PROOF_LEDGER_SMOKE_HOSTED !== '0';
const expectHostedProofLedger = process.env.AOL_PROOF_LEDGER_SMOKE_EXPECT_ENABLED !== '0';
const operatorWriteEnabled = process.env.AOL_PROOF_LEDGER_SMOKE_OPERATOR_WRITE === '1';
const operatorSecret = process.env.AOL_PROOF_LEDGER_SMOKE_OPERATOR_SECRET || process.env.OPERATOR_API_SECRET || '';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function logOk(message) {
  console.log(`ok   ${message}`);
}

function parseJsonEnv(name, fallback) {
  const raw = process.env[name];
  if (!raw) return fallback;
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new Error(`${name} must be valid JSON: ${err.message}`);
  }
}

async function fetchJson(pathname, options = {}) {
  const response = await fetch(new URL(pathname, baseUrl), {
    headers: {
      'user-agent': 'aol-proof-ledger-smoke',
      ...(options.headers || {}),
    },
    method: options.method || 'GET',
    body: options.body,
  });
  const text = await response.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = { raw: text };
  }
  return { response, body };
}

async function postOperatorJson(pathname, payload) {
  assert(operatorSecret, 'operator write smoke requires AOL_PROOF_LEDGER_SMOKE_OPERATOR_SECRET or OPERATOR_API_SECRET');
  return fetchJson(pathname, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-operator-secret': operatorSecret,
    },
    body: JSON.stringify(payload || {}),
  });
}

async function runCoreSmoke() {
  const tempDir = await mkdtemp(join(tmpdir(), 'aol-proof-ledger-smoke-'));
  const proofLedger = new ProofLedger({
    dbPath: join(tempDir, 'proof-ledger.sqlite'),
    keyPath: join(tempDir, 'proof-ledger.key.pem'),
    allowGenerateKey: true,
  });

  try {
    const genesis = await proofLedger.ensureGenesisProof();
    assert(genesis?.proof_record_type === 'genesis', 'core smoke did not create genesis proof');

    const moneyProof = await proofLedger.appendProof({
      idempotency_key: 'proof-ledger-smoke:hub-deposit:settled',
      proof_record_type: 'money_event',
      money_event_type: 'hub_deposit_settled',
      money_event_status: 'settled',
      agent_id: 'agent-proof-smoke',
      event_source: 'proof_ledger_smoke',
      authorization_method: 'system_settlement',
      primary_amount_sats: 1234,
      wallet_hub_delta_sats: 1234,
      public_safe_refs: { amount_sats: 1234, status: 'settled' },
    });
    assert(proofLedger.verifyProof(moneyProof).valid, 'core money proof signature failed');
    assert(proofLedger.getAgentBalance('agent-proof-smoke').wallet_hub_sats === 1234, 'core balance projection failed');

    const checkpoint = await proofLedger.createLiabilityCheckpoint();
    assert(checkpoint.proof_record_type === 'liability_checkpoint', 'core liability checkpoint missing');

    const reserve = await proofLedger.createReserveSnapshot({
      reserveTotalsBySource: {
        smoke_reserve: { reserve_source_type: 'test_attestation', amount_sats: 2000 },
      },
      reserveEvidenceRefs: [{ evidence_type: 'test_only', txid: 'proof-ledger-smoke' }],
      reserveSufficient: true,
    });
    assert(reserve.proof_record_type === 'reserve_snapshot', 'core reserve snapshot missing');

    const reconciliation = await proofLedger.createReconciliationProof({
      reconciliationStatus: 'smoke_reserves_cover_liabilities',
      reserveSufficient: true,
    });
    assert(reconciliation.proof_record_type === 'reconciliation', 'core reconciliation proof missing');
    assert(proofLedger.verifyChain().valid, 'core global chain verification failed');
    assert(proofLedger.verifyChain({ agentId: 'agent-proof-smoke' }).valid, 'core agent chain verification failed');

    logOk('core sqlite/signing/hash-chain/projection/checkpoint smoke');
  } finally {
    proofLedger.close();
    await rm(tempDir, { recursive: true, force: true });
  }
}

async function runHostedWellKnownSmoke() {
  const key = await fetchJson('/.well-known/proof-ledger-public-key.json');
  if (!key.response.ok) {
    if (!expectHostedProofLedger && key.response.status === 503) {
      logOk('hosted proof public key unavailable as expected');
      return false;
    }
    throw new Error(`GET /.well-known/proof-ledger-public-key.json failed with ${key.response.status}`);
  }
  assert(/^ed25519:/.test(key.body?.signing_key_id || ''), 'hosted proof public key missing signing_key_id');
  assert(Array.isArray(key.body?.issuer_domains), 'hosted proof public key missing issuer_domains');
  logOk('hosted proof public key');

  const ledger = await fetchJson('/.well-known/proof-ledger.json');
  assert(ledger.response.ok, `GET /.well-known/proof-ledger.json failed with ${ledger.response.status}`);
  assert(ledger.body?.source_of_truth === 'proof_ledger', 'hosted proof ledger source_of_truth mismatch');
  assert(Number.isSafeInteger(ledger.body?.latest_global_sequence), 'hosted proof ledger missing latest_global_sequence');
  assert(ledger.body?.global_chain?.valid === true, 'hosted proof ledger global chain is not valid');
  assert(ledger.body?.proof_of_liabilities?.live_derived_liability_totals, 'hosted proof ledger missing liabilities');
  logOk('hosted well-known proof ledger');
  return true;
}

async function runHostedMcpSmoke() {
  const client = new Client({
    name: 'aol-proof-ledger-smoke',
    version: '1.0.0',
  });
  const transport = new StreamableHTTPClientTransport(new URL('/mcp', baseUrl));

  try {
    await client.connect(transport);
    const tools = await client.listTools();
    const names = new Set((tools.tools || []).map((tool) => tool.name));
    for (const name of [
      'aol_get_my_balance_proof',
      'aol_list_my_proofs',
      'aol_get_proof',
      'aol_verify_proof',
      'aol_get_proof_bundle',
      'aol_get_proof_of_liabilities',
      'aol_get_proof_of_reserves',
    ]) {
      assert(names.has(name), `hosted MCP missing ${name}`);
    }

    const liabilities = await client.callTool({
      name: 'aol_get_proof_of_liabilities',
      arguments: {},
    });
    assert(!liabilities?.isError, 'aol_get_proof_of_liabilities returned isError');
    const liabilitiesStatus = liabilities?.structuredContent?.status;
    assert(liabilitiesStatus === 200, `aol_get_proof_of_liabilities returned status ${liabilitiesStatus}`);

    const reserves = await client.callTool({
      name: 'aol_get_proof_of_reserves',
      arguments: {},
    });
    assert(!reserves?.isError, 'aol_get_proof_of_reserves returned isError');
    const reservesStatus = reserves?.structuredContent?.status;
    assert(reservesStatus === 200, `aol_get_proof_of_reserves returned status ${reservesStatus}`);
    logOk('hosted MCP proof tools');
  } finally {
    await client.close?.();
  }
}

async function runOperatorWriteSmoke() {
  if (!operatorWriteEnabled) {
    logOk('operator write smoke skipped');
    return;
  }

  const checkpoint = await postOperatorJson('/api/operator/proof-ledger/liability-checkpoint', {});
  assert(checkpoint.response.ok, `operator liability checkpoint failed with ${checkpoint.response.status}`);
  assert(checkpoint.body?.proof?.proof_record_type === 'liability_checkpoint', 'operator checkpoint proof shape invalid');
  assert(checkpoint.body?.verification?.valid === true, 'operator checkpoint proof did not verify');
  logOk('operator liability checkpoint write');

  const reserveTotals = parseJsonEnv('AOL_PROOF_LEDGER_SMOKE_RESERVE_TOTALS_JSON', null);
  if (!reserveTotals) {
    logOk('operator reserve/reconciliation write skipped');
    return;
  }

  const reserveEvidenceRefs = parseJsonEnv('AOL_PROOF_LEDGER_SMOKE_RESERVE_EVIDENCE_JSON', []);
  const reserve = await postOperatorJson('/api/operator/proof-ledger/reserve-snapshot', {
    reserve_totals_by_source: reserveTotals,
    reserve_evidence_refs: reserveEvidenceRefs,
    reserve_sufficient: process.env.AOL_PROOF_LEDGER_SMOKE_RESERVE_SUFFICIENT === '1',
  });
  assert(reserve.response.ok, `operator reserve snapshot failed with ${reserve.response.status}`);
  assert(reserve.body?.proof?.proof_record_type === 'reserve_snapshot', 'operator reserve proof shape invalid');
  assert(reserve.body?.verification?.valid === true, 'operator reserve proof did not verify');
  logOk('operator reserve snapshot write');

  const reconciliationStatus = process.env.AOL_PROOF_LEDGER_SMOKE_RECONCILIATION_STATUS || 'smoke_reconciliation_complete';
  const reconciliation = await postOperatorJson('/api/operator/proof-ledger/reconciliation', {
    reconciliation_status: reconciliationStatus,
    reserve_sufficient: process.env.AOL_PROOF_LEDGER_SMOKE_RESERVE_SUFFICIENT === '1',
  });
  assert(reconciliation.response.ok, `operator reconciliation failed with ${reconciliation.response.status}`);
  assert(reconciliation.body?.proof?.proof_record_type === 'reconciliation', 'operator reconciliation proof shape invalid');
  assert(reconciliation.body?.verification?.valid === true, 'operator reconciliation proof did not verify');
  logOk('operator reconciliation write');
}

await runCoreSmoke();

if (hostedEnabled) {
  const hostedProofEnabled = await runHostedWellKnownSmoke();
  if (hostedProofEnabled) {
    await runHostedMcpSmoke();
    await runOperatorWriteSmoke();
  }
} else {
  logOk('hosted proof-ledger smoke skipped');
}

console.log('proof_ledger_smoke_ok=1');
