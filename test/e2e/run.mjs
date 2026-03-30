#!/usr/bin/env node
/**
 * Agent E2E Validation — single runner, every endpoint, one flag.
 *
 *   node scripts/skills/agent-e2e/run.mjs              # free tests (0 sats)
 *   node scripts/skills/agent-e2e/run.mjs --real-sats   # includes paid tests
 */

import {
  lncli, generateTestKeypair, signInstruction, CHAN_POINT,
} from '../../../ai_panel/e2e-helpers.mjs';
import { tests } from './tests.mjs';
import { appendFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const RUNS_FILE = join(__dirname, 'runs.jsonl');
const BASE = 'http://localhost:3200';
const REAL_SATS = process.argv.includes('--real-sats');

// ─── Payload Tracking ───

const measurements = [];

// ─── HTTP Client with payload tracking ───

async function api(method, path, body, apiKey, opts = {}) {
  const isRaw = method === 'RAW_POST';
  const httpMethod = isRaw ? 'POST' : method;
  const url = `${BASE}${path}`;
  const headers = { ...(opts.headers || {}) };
  if (body) headers['Content-Type'] = 'application/json';
  if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;

  const rawBody = isRaw ? body : (body ? JSON.stringify(body) : undefined);
  const reqBytes = rawBody ? (typeof rawBody === 'string' ? rawBody.length : 0) : 0;
  const start = Date.now();

  const res = await fetch(url, { method: httpMethod, headers, body: rawBody });
  const text = await res.text();
  const ms = Date.now() - start;

  let json;
  try { json = JSON.parse(text); } catch { json = null; }

  measurements.push({
    endpoint: `${isRaw ? 'POST' : method} ${path.split('?')[0]}`,
    reqBytes, respBytes: text.length, ms, status: res.status,
  });

  return { status: res.status, json, text, ms, headers: res.headers };
}

// ─── Main ───

async function main() {
  const t0 = Date.now();
  console.log('\n  Agent E2E Validation\n');

  // Health check with retry
  let health;
  for (let i = 0; i < 5; i++) {
    try {
      health = await api('GET', '/api/v1/');
      if (health.status === 200) break;
    } catch {}
    if (i < 4) await new Promise(r => setTimeout(r, 2000));
  }
  if (!health || health.status !== 200) {
    console.log('  ✗ Server not responding on port 3200');
    process.exit(1);
  }
  console.log(`  Server: ${BASE} (v${health.json?.version || '?'})`);
  console.log(`  Mode: ${REAL_SATS ? 'real sats' : 'free only'}\n`);

  // Register 5 agents (perIp=3 rate limit: register 3, reset, register 2)
  await api('POST', '/api/v1/test/reset-rate-limits');
  const agents = [];
  for (let i = 0; i < 3; i++) {
    const r = await api('POST', '/api/v1/agents/register', {
      name: `e2e-${i}-${Date.now()}`,
    });
    if (r.status !== 201) throw new Error(`Register agent ${i}: ${r.status} ${r.text}`);
    agents.push(r.json);
  }
  await api('POST', '/api/v1/test/reset-rate-limits');
  for (let i = 3; i < 5; i++) {
    const r = await api('POST', '/api/v1/agents/register', {
      name: `e2e-${i}-${Date.now()}`,
    });
    if (r.status !== 201) throw new Error(`Register agent ${i}: ${r.status} ${r.text}`);
    agents.push(r.json);
  }
  console.log(`  Registered ${agents.length} test agents`);

  // secp256k1 keypair → register on agent 0
  const keypair = generateTestKeypair();
  await api('PUT', '/api/v1/agents/me', { public_key: keypair.pubHex }, agents[0].api_key);
  console.log('  Keypair registered on agent 0\n');

  // Build context shared by all tests
  const leanSavings = [];
  const ctx = {
    api,
    agents,
    key: (i = 0) => agents[i].api_key,
    keypair,
    sign: (action, params, i = 0) => {
      const instruction = {
        agent_id: agents[i].agent_id,
        action,
        timestamp: new Date().toISOString(),
        ...params,
      };
      return {
        instruction,
        signature: signInstruction(instruction, keypair.privateKey),
        public_key: keypair.pubHex,
      };
    },
    signRaw: (instruction) => ({
      instruction,
      signature: signInstruction(instruction, keypair.privateKey),
      public_key: keypair.pubHex,
    }),
    lncli,
    nodePubkey: '039f11768dc2c6adbbed823cc062592737e1f8702719e02909da67a58ade718274',
    chanPoint: CHAN_POINT,
    leanSavings,
    measurements,
  };

  // Filter tests and run
  const selected = tests.filter(t => !t.paid || REAL_SATS);
  let pass = 0, fail = 0;
  const skip = tests.length - selected.length;
  const failures = [];

  for (const test of selected) {
    await api('POST', '/api/v1/test/reset-rate-limits');
    const tag = test.paid ? '💰' : '  ';
    process.stdout.write(`  ${tag} ${test.name} `);
    const start = Date.now();
    try {
      await test.fn(ctx);
      console.log(`\x1b[32m✓\x1b[0m ${Date.now() - start}ms`);
      pass++;
    } catch (e) {
      console.log(`\x1b[31m✗\x1b[0m ${Date.now() - start}ms`);
      failures.push({ name: test.name, error: e.message });
      fail++;
    }
  }

  // ─── Summary ───

  const totalMs = Date.now() - t0;
  const color = fail ? '31' : '32';
  console.log('\n  ─────────────────────────────');
  console.log(`  \x1b[${color}m${pass} passed  ${fail} failed  ${skip} skipped\x1b[0m  ${totalMs}ms`);

  // Top 5 largest responses
  const sorted = [...measurements].sort((a, b) => b.respBytes - a.respBytes);
  if (sorted.length) {
    console.log('\n  Largest responses:');
    for (const m of sorted.slice(0, 5)) {
      console.log(`    ${String(m.respBytes).padStart(7)}B  ${m.endpoint}`);
    }
  }

  // Lean savings
  if (leanSavings.length) {
    console.log('\n  Lean savings (?lean=true):');
    for (const s of leanSavings) {
      console.log(`    ${String(s.savings).padStart(3)}%  ${s.endpoint}  (${s.normal}B → ${s.lean}B)`);
    }
  }

  // Failure detail
  if (failures.length) {
    console.log('\n  Failures:');
    for (const f of failures) {
      console.log(`    \x1b[31m✗\x1b[0m ${f.name}`);
      console.log(`      ${f.error}`);
    }
  }

  // Append run to history
  appendFileSync(RUNS_FILE, JSON.stringify({
    ts: new Date().toISOString(),
    pass, fail, skip, ms: totalMs,
    real_sats: REAL_SATS,
    endpoints_hit: new Set(measurements.map(m => m.endpoint)).size,
  }) + '\n');

  console.log(`\n  → runs.jsonl\n`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch(e => {
  console.error(`\n  Fatal: ${e.message}\n`);
  process.exit(1);
});
