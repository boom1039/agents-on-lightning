#!/usr/bin/env node

import { buildEndpointTestMatrix } from './endpoint-test-matrix.mjs';

const BASE_URL = (process.env.AOL_CANARY_BASE_URL || 'http://127.0.0.1:3302').replace(/\/+$/, '');
const TOKEN = `${process.env.AOL_CANARY_TOKEN || ''}`.trim();
const REGISTER_AGENTS = process.env.AOL_CANARY_REGISTER_AGENTS === '1';
const AGENT_COUNT = Math.max(1, Number.parseInt(process.env.AOL_CANARY_AGENT_COUNT || '3', 10));
const AGENT_PREFIX = `${process.env.AOL_CANARY_AGENT_PREFIX || 'journey-canary'}`.trim() || 'journey-canary';
const AGENT_DESCRIPTION = `${process.env.AOL_CANARY_AGENT_DESCRIPTION || 'Named canary agent for doc crawl and Journey visibility.'}`.trim();
const INCLUDE_KNOWLEDGE = process.env.AOL_CANARY_INCLUDE_KNOWLEDGE !== '0';
const SAFE_AUTH_ONLY = process.env.AOL_CANARY_SAFE_AUTH_ONLY !== '0';
const TIMEOUT_MS = Number.parseInt(process.env.AOL_CANARY_TIMEOUT_MS || '15000', 10);
const DOC_DELAY_MS = Number.parseInt(process.env.AOL_CANARY_DOC_DELAY_MS || '2100', 10);
const API_DELAY_MS = Number.parseInt(process.env.AOL_CANARY_API_DELAY_MS || '600', 10);
const DANGER_DELAY_MS = Number.parseInt(process.env.AOL_CANARY_DANGER_DELAY_MS || '3500', 10);

const ROUTE_RE = /\b(GET|POST|PUT|DELETE|PATCH)\s+`?(\/[^\s`'")\]},]*)/gi;
const SKIP_LINE_TAGS = ['[not-live-route]', '[manifest-excluded-route]'];
const nextAllowedAt = new Map();
const ENDPOINT_MATRIX = buildEndpointTestMatrix();
const SAFE_AUTO_ROUTE_KEYS = new Set(
  ENDPOINT_MATRIX.rows
    .filter((row) => row.prod_policy === 'safe-auto')
    .map((row) => row.key),
);

function stripTrailingSlash(url) {
  return `${url}`.replace(/\/+$/, '');
}

function routeKey(method, path) {
  return `${String(method || '').toUpperCase()} ${withoutQuery(path)}`;
}

function escapeRegex(text) {
  return `${text}`.replace(/[|\\{}()[\]^$+*?.]/g, '\\$&');
}

function pathPatternToRegex(path) {
  if (path === '/') return /^\/$/;
  const parts = `${path}`.split('/').filter(Boolean).map((segment) => {
    if (segment.startsWith(':')) return '[^/]+';
    return escapeRegex(segment);
  });
  return new RegExp(`^/${parts.join('/')}/?$`);
}

function isDynamicDocPath(path = '') {
  return /<[^>]+>|\{[^}]+\}|\/:\w+|\*/.test(path);
}

function withoutQuery(path = '') {
  return `${path}`.split('?')[0] || '/';
}

function normalizeDocPathForMatch(path = '') {
  const cleaned = `${path}`.replace(/\/+$/, '') || '/';
  const parts = cleaned.split('/').map((segment, index) => {
    if (index === 0) return '';
    if (!segment) return segment;
    if (/^<[^>]+>$/.test(segment)) return 'sample';
    if (/^\{[^}]+\}$/.test(segment)) return 'sample';
    if (/^:\w+$/.test(segment)) return 'sample';
    if (segment === '*') return 'sample';
    return segment;
  });
  return parts.join('/') || '/';
}

function isDynamicManifestPath(path = '') {
  return `${path}`.includes(':');
}

function isDocTextPath(path = '') {
  return path === '/llms.txt' || path.startsWith('/docs/');
}

function isKnowledgePath(path = '') {
  return path.startsWith('/api/v1/knowledge/');
}

function isEntryPath(path = '') {
  return path === '/' || path === '/api/v1/' || path === '/api/v1/skills';
}

function isFetchableDocTarget(path = '') {
  return isDocTextPath(path) || isEntryPath(path) || (INCLUDE_KNOWLEDGE && isKnowledgePath(path));
}

function parseRouteRefs(text, source) {
  const refs = [];
  const lines = `${text}`.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (SKIP_LINE_TAGS.some((tag) => line.includes(tag))) continue;
    ROUTE_RE.lastIndex = 0;
    let match;
    while ((match = ROUTE_RE.exec(line))) {
      refs.push({
        source,
        line: index + 1,
        method: match[1].toUpperCase(),
        rawPath: match[2],
        path: withoutQuery(match[2]),
      });
    }
  }
  return refs;
}

function uniqBy(items, getKey) {
  const seen = new Map();
  for (const item of items) {
    const key = getKey(item);
    if (!seen.has(key)) seen.set(key, item);
  }
  return [...seen.values()];
}

async function fetchWithMeta(path, {
  headers = {},
  method = 'GET',
  body = undefined,
} = {}) {
  const bucket = classifyBucket(path);
  const readyAt = nextAllowedAt.get(bucket) || 0;
  const waitMs = readyAt - Date.now();
  if (waitMs > 0) await new Promise((resolve) => setTimeout(resolve, waitMs));
  nextAllowedAt.set(bucket, Date.now() + bucketDelay(bucket));

  const url = new URL(path, `${BASE_URL}/`);
  let response;
  try {
    response = await fetch(url, {
      method,
      headers,
      body,
      redirect: 'follow',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (error) {
    return {
      ok: false,
      hardFail: true,
      status: null,
      url: url.toString(),
      error: error instanceof Error ? error.message : String(error),
      text: '',
      headers: new Headers(),
    };
  }

  const text = await response.text();
  return {
    ok: response.ok,
    status: response.status,
    url: response.url,
    text,
    headers: response.headers,
    hardFail: false,
    error: null,
  };
}

async function registerAgent(name) {
  const result = await fetchWithMeta('/api/v1/agents/register', {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      name,
      description: AGENT_DESCRIPTION,
    }),
  });
  if (!result.ok) {
    return {
      ok: false,
      status: result.status,
      reason: result.error || `status ${result.status}`,
      text: result.text,
    };
  }
  let data = null;
  try {
    data = JSON.parse(result.text);
  } catch {}
  if (!data?.api_key || !data?.agent_id) {
    return {
      ok: false,
      status: result.status,
      reason: 'missing api_key or agent_id',
      text: result.text,
    };
  }
  return {
    ok: true,
    agent: {
      id: data.agent_id,
      name,
      token: data.api_key,
    },
  };
}

function bucketDelay(bucket) {
  if (bucket === 'docs') return DOC_DELAY_MS;
  if (bucket === 'danger') return DANGER_DELAY_MS;
  return API_DELAY_MS;
}

function classifyBucket(path) {
  if (isDocTextPath(path)) return 'docs';
  if (
    path.startsWith('/api/v1/analysis/')
    || path.startsWith('/api/v1/market/')
    || path.startsWith('/api/v1/channels/')
    || path.startsWith('/api/v1/capital/')
    || path.startsWith('/api/v1/node/')
    || path === '/api/v1/help'
  ) return 'danger';
  return 'api';
}

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function classifyProbeResult(route, result, authSatisfied) {
  const payload = parseJson(result.text);
  if (result.hardFail) return { level: 'fail', reason: result.error || 'network error' };
  if (result.status === 400 && payload?.error === 'missing_field') {
    return { level: 'soft', reason: `status ${result.status}` };
  }
  if (result.status === 400 && payload?.retryable === true) {
    return { level: 'soft', reason: `status ${result.status}` };
  }
  if (result.status === 503 && payload?.error === 'service_unavailable' && payload?.retryable === true) {
    return { level: 'soft', reason: `status ${result.status}` };
  }
  if (result.status >= 500 && payload?.retryable === true) {
    return { level: 'soft', reason: `status ${result.status}` };
  }
  if (result.status === 404 || result.status === 405) return { level: 'fail', reason: `status ${result.status}` };
  if (result.status >= 500) return { level: 'fail', reason: `status ${result.status}` };

  if (route.kind === 'doc') {
    if (result.status >= 200 && result.status < 300) return { level: 'ok', reason: `status ${result.status}` };
    return { level: 'fail', reason: `status ${result.status}` };
  }

  if (route.auth === 'public' && (result.status === 401 || result.status === 403)) {
    return { level: 'fail', reason: `public route returned ${result.status}` };
  }

  if (route.auth === 'agent' && authSatisfied && (result.status === 401 || result.status === 403)) {
    return { level: 'fail', reason: `agent route returned ${result.status} with token` };
  }

  if (result.status >= 200 && result.status < 400) return { level: 'ok', reason: `status ${result.status}` };
  return { level: 'soft', reason: `status ${result.status}` };
}

function formatItem(item) {
  const line = item.line ? `:${item.line}` : '';
  return `${item.method} ${item.path} (${item.source}${line})`;
}

function printList(title, items, formatter = formatItem) {
  if (!items.length) return;
  console.log(`\n${title}`);
  for (const item of items) console.log(`- ${formatter(item)}`);
}

async function main() {
  const llms = await fetchWithMeta('/llms.txt');
  if (!llms.ok) {
    console.error(`Canary failed: could not fetch /llms.txt (${llms.status || llms.error})`);
    process.exit(1);
  }

  const llmsRefs = parseRouteRefs(llms.text, '/llms.txt');
  const docTargets = uniqBy(
    llmsRefs
      .filter((ref) => ref.method === 'GET' && isFetchableDocTarget(ref.path))
      .map((ref) => ({ ...ref, kind: 'doc' })),
    (ref) => routeKey(ref.method, ref.path),
  );

  const fetchedDocs = new Map();
  fetchedDocs.set('/llms.txt', llms.text);

  const docProbeResults = [];
  docProbeResults.push({
    method: 'GET',
    path: '/llms.txt',
    kind: 'doc',
    status: llms.status,
    level: 'ok',
    reason: `status ${llms.status}`,
  });

  for (const target of docTargets) {
    if (fetchedDocs.has(target.path)) continue;
    const result = await fetchWithMeta(target.rawPath || target.path);
    const verdict = classifyProbeResult(target, result, false);
    docProbeResults.push({
      ...target,
      status: result.status,
      level: verdict.level,
      reason: verdict.reason,
    });
    if (verdict.level === 'fail') continue;
    fetchedDocs.set(target.path, result.text);
  }

  const docRefs = [];
  for (const [path, text] of fetchedDocs) {
    docRefs.push(...parseRouteRefs(text, path));
  }

  const manifestRes = await fetchWithMeta('/api/journey/manifest');
  if (!manifestRes.ok) {
    console.error(`Canary failed: could not fetch /api/journey/manifest (${manifestRes.status || manifestRes.error})`);
    process.exit(1);
  }
  const manifest = JSON.parse(manifestRes.text);
  const manifestRoutes = (manifest.routes || []).filter((route) => route.canonical !== false);
  const exactManifest = new Map(manifestRoutes.map((route) => [routeKey(route.method, route.path), route]));
  const patternManifest = manifestRoutes.map((route) => ({
    ...route,
    regex: pathPatternToRegex(route.path),
  }));

  function matchManifestRoute(ref) {
    const exact = exactManifest.get(routeKey(ref.method, ref.path));
    if (exact) return exact;
    const samplePath = normalizeDocPathForMatch(ref.path);
    return patternManifest.find((route) => route.method === ref.method && route.regex.test(samplePath)) || null;
  }

  const manifestRefs = [];
  const excludedRefs = [];
  const missingManifestRefs = [];
  for (const ref of docRefs) {
    if (isDocTextPath(ref.path)) continue;
    if (isKnowledgePath(ref.path)) {
      excludedRefs.push(ref);
      continue;
    }
    const match = matchManifestRoute(ref);
    if (match) manifestRefs.push({ ...ref, manifest: match });
    else missingManifestRefs.push(ref);
  }

  const probeTargets = ENDPOINT_MATRIX.rows
    .filter((row) => row.method === 'GET')
    .map((row) => ({
      method: row.method,
      path: row.path,
      rawPath: row.path,
      auth: row.auth,
      matrix: row,
    }));

  const agentPool = [];
  if (REGISTER_AGENTS) {
    const runId = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 12);
    for (let index = 0; index < AGENT_COUNT; index += 1) {
      const suffix = String.fromCharCode(97 + (index % 26));
      const name = `${AGENT_PREFIX}-${suffix}-${runId}`;
      const registration = await registerAgent(name);
      if (!registration.ok) {
        console.error(`Canary failed: could not register ${name} (${registration.status || registration.reason})`);
        process.exit(1);
      }
      agentPool.push(registration.agent);
    }
  } else if (TOKEN) {
    agentPool.push({
      id: 'provided-token',
      name: 'provided-token',
      token: TOKEN,
    });
  }

  const routeProbeResults = [];
  let agentCursor = 0;
  for (const target of probeTargets) {
    if (isDynamicManifestPath(target.path)) {
      routeProbeResults.push({
        ...target,
        level: 'skip',
        reason: 'dynamic id required',
        status: null,
      });
      continue;
    }

    if (target.matrix.prod_policy !== 'safe-auto') {
      routeProbeResults.push({
        ...target,
        level: 'skip',
        reason: target.matrix.prod_policy,
        status: null,
      });
      continue;
    }

    let agent = null;
    if (target.auth === 'agent') {
      if (agentPool.length === 0) {
        routeProbeResults.push({
          ...target,
          level: 'skip',
          reason: 'agent token missing',
          status: null,
        });
        continue;
      }
      if (SAFE_AUTH_ONLY && !SAFE_AUTO_ROUTE_KEYS.has(routeKey(target.method, target.path))) {
        routeProbeResults.push({
          ...target,
          level: 'skip',
          reason: 'safe-auto-only',
          status: null,
        });
        continue;
      }
      agent = agentPool[agentCursor % agentPool.length];
      agentCursor += 1;
    }

    if (target.auth === 'agent' && !agent) {
      routeProbeResults.push({
        ...target,
        level: 'skip',
        reason: 'agent token missing',
        status: null,
      });
      continue;
    }

    const headers = {};
    if (target.auth === 'agent' && agent?.token) headers.Authorization = `Bearer ${agent.token}`;
    const result = await fetchWithMeta(target.rawPath || target.path, { headers });
    const verdict = classifyProbeResult(target, result, Boolean(agent?.token));
    routeProbeResults.push({
      ...target,
      auth: target.auth,
      agentName: agent?.name || null,
      agentId: agent?.id || null,
      status: result.status,
      level: verdict.level,
      reason: verdict.reason,
    });
  }

  const docFailures = docProbeResults.filter((item) => item.level === 'fail');
  const routeFailures = routeProbeResults.filter((item) => item.level === 'fail');
  const routeSoft = routeProbeResults.filter((item) => item.level === 'soft');
  const routeSkipped = routeProbeResults.filter((item) => item.level === 'skip');

  console.log(`Base: ${BASE_URL}`);
  console.log(`Manifest routes: ${manifestRoutes.length}`);
  console.log(`Matrix routes: ${ENDPOINT_MATRIX.total_routes}`);
  console.log(`Docs fetched: ${fetchedDocs.size}`);
  console.log(`Canary agents: ${agentPool.length}`);
  console.log(`Doc route refs matched to manifest: ${manifestRefs.length}`);
  console.log(`Knowledge refs skipped from manifest check: ${excludedRefs.length}`);
  console.log(`Doc fetch checks: ${docProbeResults.length} total, ${docFailures.length} failed`);
  console.log(`GET route probes: ${routeProbeResults.length} total, ${routeFailures.length} failed, ${routeSoft.length} input-needed, ${routeSkipped.length} skipped`);

  printList('Missing From Manifest', missingManifestRefs);
  printList('Doc Fetch Failures', docFailures, (item) => `${item.method} ${item.path} -> ${item.reason}`);
  printList('Route Probe Failures', routeFailures, (item) => `${item.method} ${item.path}${item.agentName ? ` [${item.agentName}]` : ''} -> ${item.reason}`);
  printList('Route Probe Soft Status', routeSoft, (item) => `${item.method} ${item.path}${item.agentName ? ` [${item.agentName}]` : ''} -> ${item.reason}`);
  printList('Route Probe Skipped', routeSkipped, (item) => `${item.method} ${item.path} -> ${item.reason}`);

  if (missingManifestRefs.length || docFailures.length || routeFailures.length) {
    process.exit(1);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exit(1);
});
