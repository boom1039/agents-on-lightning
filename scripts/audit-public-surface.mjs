import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { getAgentSurfaceManifest } from '../src/monitor/agent-surface-inventory.js';

const baseUrl = process.env.AOL_AUDIT_BASE_URL || 'https://agentsonlightning.com';
const expectMcpOnly = process.env.AOL_EXPECT_MCP_ONLY === '1';
const auditDelayMs = Number(process.env.AOL_AUDIT_DELAY_MS || (expectMcpOnly ? 500 : 0));
const outDir = resolve(process.cwd(), 'output');
const now = new Date();
const stamp = now.toISOString().replace(/[:.]/g, '-');
const hostTag = new URL(baseUrl).host.replace(/[^a-z0-9.-]+/gi, '_');
const outPath = resolve(outDir, `public-surface-audit-${hostTag}-${stamp}.json`);

const SAFE_UNAUTH_STATUSES = new Set([400, 401, 402, 403, 404, 405, 409, 410, 415, 422, 429, 503]);
const STREAMING_OR_SPECIAL = new Set([
  'GET /api/v1/events/stream',
  'GET /mcp',
  'POST /mcp',
  'DELETE /mcp',
]);

const SENSITIVE_FIELD_PATTERNS = [
  /api_?key/i,
  /secret/i,
  /password/i,
  /seed/i,
  /proof/i,
  /token/i,
  /preimage/i,
  /^address$/i,
  /payment_request/i,
  /invoice/i,
  /flow_id/i,
  /^reference$/i,
  /lastHash/i,
  /lastPollAt/i,
  /currentBackoff/i,
  /local_balance/i,
  /remote_balance/i,
  /^version$/i,
];

const ALLOWED_SENSITIVE_FIELDS = new Map([
  ['GET /', new Set(['proof_ledger'])],
  ['GET /.well-known/mcp.json', new Set(['version', 'serverInfo.version'])],
  ['GET /.well-known/mcp/server-card.json', new Set(['version', 'serverInfo.version'])],
  ['GET /.well-known/agent-card.json', new Set(['version'])],
  ['GET /api/v1/', new Set(['version'])],
  ['GET /api/v1/capabilities', new Set(['tiers.invoice'])],
]);

function isAllowedSensitiveField(routeKey, field) {
  const exact = ALLOWED_SENSITIVE_FIELDS.get(routeKey);
  if (exact?.has(field)) return true;

  const publicProofRoutes = new Set([
    'GET /.well-known/proof-ledger.json',
    'GET /api/v1/proofs/liabilities',
    'GET /api/v1/proofs/reserves',
  ]);
  if (!publicProofRoutes.has(routeKey)) return false;

  return [
    /^latest_global_proof_(id|hash)$/,
    /^proof_of_(liabilities|reserves)(\.|$)/,
    /(^|\.)proof_(id|hash|record_type)$/,
    /(^|\.)previous_global_proof_hash$/,
    /(^|\.)checkpointed_global_proof_hash$/,
    /(^|\.)proof_ledger$/,
  ].some((pattern) => pattern.test(field));
}

function shortJson(value, limit = 1200) {
  try {
    const text = JSON.stringify(value);
    return text.length > limit ? `${text.slice(0, limit)}...` : text;
  } catch {
    return String(value);
  }
}

async function fetchJson(path, { method = 'GET', body = null, headers = {} } = {}) {
  const url = new URL(path, baseUrl);
  const response = await fetch(url, {
    method,
    headers: {
      'user-agent': 'aol-public-surface-audit',
      ...headers,
    },
    body: body == null ? undefined : JSON.stringify(body),
  });

  const text = await response.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }

  return {
    url: url.toString(),
    status: response.status,
    ok: response.ok,
    headers: Object.fromEntries(response.headers.entries()),
    body: json,
    text,
  };
}

function sleep(ms) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

async function fetchJsonWithRetry(path, options = {}) {
  let result = await fetchJson(path, options);
  if (expectMcpOnly && result.status === 503) {
    await sleep(Math.max(250, auditDelayMs * 4));
    result = await fetchJson(path, options);
  }
  return result;
}

function collectSensitiveFields(value, prefix = '') {
  const hits = new Set();

  function walk(node, path) {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      node.slice(0, 3).forEach((item, index) => walk(item, `${path}[${index}]`));
      return;
    }
    for (const [key, child] of Object.entries(node)) {
      const next = path ? `${path}.${key}` : key;
      if (SENSITIVE_FIELD_PATTERNS.some((pattern) => pattern.test(key))) {
        hits.add(next);
      }
      walk(child, next);
    }
  }

  walk(value, prefix);
  return [...hits].sort();
}

async function buildSamples() {
  const samples = {
    agentId: '068b8557',
    pubkey: null,
    peerPubkey: null,
    chanId: null,
    strategy: 'geographic-arbitrage',
    invoice: 'lnbc2500u1p5av7stpp5guczk6964hq3e83c8wmlywcwrxzg9ghq2krmyjr42r5m0rezdthqdqqcqzzsxqrrs0fppqgfmutk00c0wzmwcm6hcwljx9u4zchjaasp5ey5lmp0vuwkd30gz0vpu2p83wpa4jmtm7f6sjy208ra782z8pf5s9qxpqysgqtu6vukaa4twsqxh5wj2afjh0eyamrjzml42j0elwtxgkm4zepyj3q7xxc0kjwxnk95vpmrz0c83s4j0yhw7xfaqgzdk58v2s9y25npsphzlya6',
  };

  if (expectMcpOnly) return samples;

  const [platform, channels, leaderboard] = await Promise.all([
    fetchJson('/api/v1/platform/status'),
    fetchJson('/api/v1/market/channels?limit=5'),
    fetchJson('/api/v1/leaderboard?limit=5'),
  ]);

  if (platform.body?.node_pubkey) samples.pubkey = platform.body.node_pubkey;

  const channel = channels.body?.channels?.[0];
  if (channel?.peer_pubkey) samples.peerPubkey = channel.peer_pubkey;
  if (channel?.chan_id) samples.chanId = channel.chan_id;
  if (channel?.agent_id) samples.agentId = channel.agent_id;

  const topAgent = leaderboard.body?.agents?.[0] || leaderboard.body?.leaderboard?.[0];
  if (topAgent?.agent_id) samples.agentId = topAgent.agent_id;
  if (topAgent?.id) samples.agentId = topAgent.id;

  if (!samples.peerPubkey) samples.peerPubkey = samples.pubkey;
  if (!samples.chanId) samples.chanId = '1038036833190019072';
  if (!samples.pubkey) samples.pubkey = '039f11768dc2c6adbbed823cc062592737e1f8702719e02909da67a58ade718274';
  if (!samples.peerPubkey) samples.peerPubkey = samples.pubkey;

  return samples;
}

function fillPath(path, samples) {
  return path
    .replace(':id', samples.agentId)
    .replace(':agentId', samples.agentId)
    .replace(':chanId', samples.chanId)
    .replace(':pubkey', samples.pubkey)
    .replace(':peerPubkey', samples.peerPubkey)
    .replace(':name', samples.strategy);
}

function buildRequest(route, samples) {
  const path = fillPath(route.path, samples);
  const method = route.method;

  if (method === 'GET') {
    if (route.path === '/api/v1/platform/decode-invoice') {
      return { method, path: `${path}?invoice=${encodeURIComponent(samples.invoice)}` };
    }
    return { method, path };
  }

  if (route.auth === 'agent') {
    return { method, path, headers: { 'content-type': 'application/json' }, body: {} };
  }

  if (route.key === 'POST /api/v1/agents/register') {
    return { method, path, headers: { 'content-type': 'application/json' }, body: { name: `audit-${Date.now()}` } };
  }

  return { method, path, headers: { 'content-type': 'application/json' }, body: {} };
}

function isDynamicRoute(path) {
  return path.includes(':');
}

function shouldSkip(route) {
  if (STREAMING_OR_SPECIAL.has(route.key)) return true;
  return false;
}

const manifest = getAgentSurfaceManifest();
const samples = await buildSamples();

const report = {
  base_url: baseUrl,
  built_at: Date.now(),
  manifest_routes: manifest.routes.length,
  public_routes: 0,
  agent_routes: 0,
  skipped_routes: [],
  mcp_only_hidden_routes: [],
  mcp_only_blocked_routes: [],
  unexpected_public_agent_routes: [],
  public_payload_risks: [],
  public_ok: [],
  probe_failures: [],
};

for (const route of manifest.routes) {
  if (!route.canonical) continue;
  if (shouldSkip(route)) {
    report.skipped_routes.push({ key: route.key, reason: 'stream_or_special' });
    continue;
  }

  const req = buildRequest(route, samples);
  try {
    if (auditDelayMs > 0) await sleep(auditDelayMs);
    const result = await fetchJsonWithRetry(req.path, req);

    if (expectMcpOnly && route.path.startsWith('/api/v1/')) {
      if (result.status === 404) {
        report.mcp_only_hidden_routes.push({ key: route.key, status: result.status, url: result.url });
      } else if (SAFE_UNAUTH_STATUSES.has(result.status)) {
        report.mcp_only_blocked_routes.push({ key: route.key, status: result.status, url: result.url });
      } else {
        report.unexpected_public_agent_routes.push({
          key: route.key,
          status: result.status,
          url: result.url,
          sample: shortJson(result.body || result.text),
        });
      }
      continue;
    }

    if (route.auth === 'public') {
      report.public_routes += 1;
      const sensitiveFields = collectSensitiveFields(result.body);
      const unexpectedSensitiveFields = sensitiveFields.filter((field) => !isAllowedSensitiveField(route.key, field));
      const row = {
        key: route.key,
        status: result.status,
        url: result.url,
        dynamic: isDynamicRoute(route.path),
        sensitive_fields: unexpectedSensitiveFields,
        allowed_sensitive_fields: sensitiveFields.filter((field) => isAllowedSensitiveField(route.key, field)),
        sample: shortJson(result.body),
      };
      if (unexpectedSensitiveFields.length > 0) {
        report.public_payload_risks.push(row);
      } else {
        report.public_ok.push(row);
      }
      continue;
    }

    report.agent_routes += 1;
    if (!SAFE_UNAUTH_STATUSES.has(result.status)) {
      report.unexpected_public_agent_routes.push({
        key: route.key,
        status: result.status,
        url: result.url,
        sample: shortJson(result.body || result.text),
      });
    }
  } catch (err) {
    report.probe_failures.push({
      key: route.key,
      error: String(err?.message || err),
    });
  }
}

await mkdir(outDir, { recursive: true });
await writeFile(outPath, `${JSON.stringify(report, null, 2)}\n`);

function printSection(title, rows, limit = 20) {
  console.log(title);
  for (const row of rows.slice(0, limit)) {
    console.log(`- ${row.key} -> ${row.status}${row.sensitive_fields?.length ? ` [${row.sensitive_fields.join(', ')}]` : ''}`);
  }
  if (rows.length > limit) console.log(`- ... ${rows.length - limit} more`);
  console.log('');
}

console.log(`audit_file=${outPath}`);
console.log(`manifest_routes=${report.manifest_routes}`);
console.log(`public_routes_checked=${report.public_routes}`);
console.log(`agent_routes_checked=${report.agent_routes}`);
console.log(`mcp_only_hidden_routes=${report.mcp_only_hidden_routes.length}`);
console.log(`mcp_only_blocked_routes=${report.mcp_only_blocked_routes.length}`);
console.log(`unexpected_public_agent_routes=${report.unexpected_public_agent_routes.length}`);
console.log(`public_payload_risks=${report.public_payload_risks.length}`);
console.log(`probe_failures=${report.probe_failures.length}`);
console.log('');

printSection('unexpected_public_agent_routes', report.unexpected_public_agent_routes);
printSection('public_payload_risks', report.public_payload_risks);
printSection('probe_failures', report.probe_failures);

if (
  report.unexpected_public_agent_routes.length > 0
  || report.public_payload_risks.length > 0
  || report.probe_failures.length > 0
) {
  process.exitCode = 1;
}
