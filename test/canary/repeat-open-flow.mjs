#!/usr/bin/env node

import { loadSavedAgent, signInstruction, authHeaders } from './saved-agent.mjs';

const BASE_URL = (process.env.AOL_REPEAT_BASE_URL || process.env.AOL_CANARY_BASE_URL || 'http://127.0.0.1:3302').replace(/\/+$/, '');
const PEER_PUBKEY = `${process.env.AOL_REPEAT_PEER_PUBKEY || ''}`.trim();
const AMOUNT_SATS = Number.parseInt(process.env.AOL_REPEAT_AMOUNT_SATS || '100000', 10);
const OPEN_FOR_REAL = process.env.AOL_REPEAT_DO_OPEN !== '0';
const TIMEOUT_MS = Number.parseInt(process.env.AOL_REPEAT_TIMEOUT_MS || '20000', 10);

function printUsageAndExit() {
  console.error('Set AOL_REPEAT_PEER_PUBKEY to the peer you want to test.');
  console.error('Optional: AOL_REPEAT_BASE_URL, AOL_REPEAT_AMOUNT_SATS, AOL_REPEAT_DO_OPEN=0');
  process.exitCode = 1;
}

async function fetchJson(path, {
  method = 'GET',
  headers = {},
  body,
} = {}) {
  const response = await fetch(new URL(path, `${BASE_URL}/`), {
    method,
    headers,
    body,
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const text = await response.text();
  let data = null;
  try {
    data = JSON.parse(text);
  } catch {}
  return {
    ok: response.ok,
    status: response.status,
    text,
    data,
  };
}

function buildInstruction(savedAgent) {
  return {
    action: 'channel_open',
    agent_id: savedAgent.agent_id,
    params: {
      local_funding_amount_sats: AMOUNT_SATS,
      peer_pubkey: PEER_PUBKEY,
    },
    timestamp: Math.floor(Date.now() / 1000),
  };
}

async function ensurePubkey(savedAgent) {
  if (!savedAgent.pubkey) return { ok: true, skipped: true };
  return fetchJson('/api/v1/agents/me', {
    method: 'PUT',
    headers: {
      ...authHeaders(savedAgent),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ pubkey: savedAgent.pubkey }),
  });
}

async function readCapitalBalance(savedAgent) {
  return fetchJson('/api/v1/capital/balance', {
    headers: authHeaders(savedAgent),
  });
}

async function postSigned(savedAgent, path) {
  const instruction = buildInstruction(savedAgent);
  const signature = await signInstruction(savedAgent, instruction);
  return fetchJson(path, {
    method: 'POST',
    headers: {
      ...authHeaders(savedAgent),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ instruction, signature }),
  });
}

function summarize(label, result) {
  return {
    step: label,
    status: result?.status ?? null,
    ok: Boolean(result?.ok),
    message: result?.data?.message || result?.data?.error || null,
    failed_at: result?.data?.failed_at || null,
    retry_after_ms: result?.data?.retry_after_ms || null,
  };
}

async function main() {
  if (!PEER_PUBKEY) {
    printUsageAndExit();
    return;
  }

  const savedAgent = await loadSavedAgent();
  const pubkeyResult = await ensurePubkey(savedAgent);
  const balanceResult = await readCapitalBalance(savedAgent);
  const previewResult = await postSigned(savedAgent, '/api/v1/market/preview');
  const openResult = OPEN_FOR_REAL && previewResult.ok && previewResult.data?.valid
    ? await postSigned(savedAgent, '/api/v1/market/open')
    : null;

  const summary = {
    base_url: BASE_URL,
    peer_pubkey: PEER_PUBKEY,
    amount_sats: AMOUNT_SATS,
    opened_for_real: OPEN_FOR_REAL,
    agent: {
      id: savedAgent.agent_id,
      name: savedAgent.name || null,
      metadata_path: savedAgent.metadata_path,
    },
    steps: [
      summarize('ensure_pubkey', pubkeyResult),
      summarize('capital_balance', balanceResult),
      summarize('market_preview', previewResult),
      openResult ? summarize('market_open', openResult) : { step: 'market_open', skipped: true },
    ],
    capital_balance: balanceResult?.data || null,
    preview: previewResult?.data || null,
    open: openResult?.data || null,
  };

  console.log(JSON.stringify(summary, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
