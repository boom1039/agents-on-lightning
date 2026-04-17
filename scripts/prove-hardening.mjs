import { spawn } from 'node:child_process';
import { createSign, generateKeyPairSync } from 'node:crypto';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import {
  buildRegistrationAuthPayload,
  canonicalAuthJson,
  normalizeSecp256k1DerSignatureToLowS,
} from '../src/identity/signed-auth.js';
import { normalizeRegistrationProfileForSigning } from '../src/identity/registry.js';

const rootDir = resolve(import.meta.dirname, '..');
const now = new Date();
const stamp = now.toISOString().replace(/[:.]/g, '-');
const reportDir = resolve(rootDir, 'output', 'proof');
const reportPath = resolve(reportDir, `hardening-proof-${stamp}.json`);
const args = new Set(process.argv.slice(2));
const PROOF_INTERNAL_MCP_SECRET = 'proof-internal-mcp-secret';

const options = {
  prod: args.has('--prod') || process.env.AOL_PROOF_PROD === '1',
  requests: numberArg('--requests', Number(process.env.AOL_PROOF_REQUESTS || 150_000)),
  concurrency: numberArg('--concurrency', Number(process.env.AOL_PROOF_CONCURRENCY || 64)),
  rps: numberArg('--rps', Number(process.env.AOL_PROOF_RPS || 500)),
  maxRssMb: Number(process.env.AOL_PROOF_MAX_RSS_MB || 512),
  maxPostLoadRssSlopeMbPerMinute: Number(process.env.AOL_PROOF_MAX_POST_LOAD_RSS_SLOPE_MB_PER_MIN || 5),
};

const settlements = [];

function numberArg(name, fallback) {
  const prefix = `${name}=`;
  const match = process.argv.slice(2).find((arg) => arg.startsWith(prefix));
  if (!match) return fallback;
  const value = Number(match.slice(prefix.length));
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

function mb(bytes) {
  return Math.round((bytes / 1024 / 1024) * 10) / 10;
}

function okSettlement(name, evidence = {}, metrics = {}) {
  settlements.push({ name, ok: true, evidence, metrics });
}

function publicKeyToCompressedHex(publicKey) {
  const jwk = publicKey.export({ format: 'jwk' });
  const x = Buffer.from(jwk.x, 'base64url');
  const y = Buffer.from(jwk.y, 'base64url');
  return `${(y[y.length - 1] & 1) ? '03' : '02'}${x.toString('hex')}`;
}

function signLowS(privateKey, payload) {
  const signer = createSign('SHA256');
  signer.update(payload, 'utf8');
  signer.end();
  const normalized = normalizeSecp256k1DerSignatureToLowS(signer.sign(privateKey).toString('hex'));
  if (!normalized.ok) throw new Error(normalized.message || 'Could not normalize secp256k1 signature');
  return normalized.signature;
}

function buildRegistrationRequest({ name, audience }) {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'secp256k1' });
  const pubkey = publicKeyToCompressedHex(publicKey);
  const profile = normalizeRegistrationProfileForSigning({ name });
  const payload = buildRegistrationAuthPayload({
    audience,
    pubkey,
    profile,
    timestamp: Math.floor(Date.now() / 1000),
    nonce: `hardening-${Date.now()}-${Math.random().toString(16).slice(2)}`,
  });
  return {
    body: {
      name,
      pubkey,
      audience,
      registration_auth: {
        timestamp: payload.timestamp,
        nonce: payload.nonce,
        signature: signLowS(privateKey, canonicalAuthJson(payload)),
      },
    },
  };
}

function failSettlement(name, error, evidence = {}, metrics = {}) {
  settlements.push({
    name,
    ok: false,
    error: error?.stack || error?.message || String(error),
    evidence,
    metrics,
  });
}

async function runSettlement(name, fn) {
  const startedAt = performance.now();
  try {
    const result = await fn();
    okSettlement(name, result?.evidence || {}, {
      ...(result?.metrics || {}),
      duration_ms: Math.round(performance.now() - startedAt),
    });
  } catch (error) {
    failSettlement(name, error, {}, {
      duration_ms: Math.round(performance.now() - startedAt),
    });
  }
}

function runCommand(command, commandArgs, { env = {}, timeoutMs = 180_000 } = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, commandArgs, {
      cwd: rootDir,
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error(`${command} ${commandArgs.join(' ')} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) {
        resolvePromise({ stdout, stderr, code });
        return;
      }
      const message = [
        `${command} ${commandArgs.join(' ')} exited ${code}`,
        stdout.trim() ? `stdout:\n${stdout.trim()}` : '',
        stderr.trim() ? `stderr:\n${stderr.trim()}` : '',
      ].filter(Boolean).join('\n');
      reject(new Error(message));
    });
  });
}

async function manifestProof() {
  const { getAgentSurfaceManifest } = await import('../src/monitor/agent-surface-inventory.js');
  const manifest = getAgentSurfaceManifest();
  const canonicalRoutes = manifest.routes.filter((route) => route.canonical !== false);
  const keys = canonicalRoutes.map((route) => route.key);
  const duplicateKeys = keys.filter((key, index) => keys.indexOf(key) !== index);
  if (manifest.routes.length < 100) throw new Error(`manifest too small: ${manifest.routes.length}`);
  if (duplicateKeys.length > 0) throw new Error(`duplicate canonical route keys: ${duplicateKeys.join(', ')}`);
  return {
    evidence: {
      manifest_routes: manifest.routes.length,
      canonical_routes: canonicalRoutes.length,
      duplicate_canonical_keys: 0,
    },
  };
}

async function unitProof() {
  const files = [
    'src/index.test.js',
    'src/channel-market/market-transparency.test.js',
    'src/channel-market/lnd-cache.test.js',
    'src/lnd/client.test.js',
    'src/monitor/journey-monitor.test.js',
    'src/routes/mcp-routes.test.js',
    'src/identity/request-security.test.js',
    'src/identity/request-run.test.js',
    'src/mcp/catalog.test.js',
  ];
  const result = await runCommand(process.execPath, ['--test', ...files], { timeoutMs: 240_000 });
  return {
    evidence: {
      command: `node --test ${files.join(' ')}`,
      stdout_tail: tail(result.stdout, 20),
    },
  };
}

async function artifactProof() {
  const outDir = resolve(reportDir, 'runtime-artifacts');
  await mkdir(outDir, { recursive: true });
  const build = await runCommand('bash', ['deploy/build-runtime-artifact.sh', outDir], { timeoutMs: 240_000 });
  const artifactPath = build.stdout.trim().split('\n').at(-1);
  if (!artifactPath || !existsSync(artifactPath)) throw new Error('runtime artifact was not created');
  const listing = await runCommand('tar', ['-tzf', artifactPath], { timeoutMs: 120_000 });
  const entries = listing.stdout.split('\n').map(normalizeTarEntry).filter(Boolean);
  const forbidden = entries.filter(isForbiddenArtifactEntry);
  const unexpected = entries.filter((entry) => !isAllowedArtifactEntry(entry));
  const required = [
    'src/index.js',
    'package.json',
    'package-lock.json',
    'config/default.yaml',
    'docs/llms.txt',
    'monitoring_dashboards/journey/index.html',
    'monitoring_dashboards/live/analytics-db.mjs',
  ];
  const missing = required.filter((entry) => !entries.includes(entry));
  if (forbidden.length > 0) throw new Error(`forbidden artifact entries: ${forbidden.slice(0, 20).join(', ')}`);
  if (unexpected.length > 0) throw new Error(`unexpected artifact entries: ${unexpected.slice(0, 20).join(', ')}`);
  if (missing.length > 0) throw new Error(`missing artifact entries: ${missing.join(', ')}`);
  return {
    evidence: {
      artifact_path: artifactPath,
      entries: entries.length,
      forbidden_entries: 0,
      unexpected_entries: 0,
      missing_required_entries: 0,
    },
  };
}

function normalizeTarEntry(entry) {
  return entry.replace(/^\.\//, '').replace(/\/$/, '');
}

function isAllowedArtifactEntry(entry) {
  if (entry === '.') return true;
  if (entry === 'RELEASE.txt') return true;
  if (entry === 'package.json') return true;
  if (entry === 'package-lock.json') return true;
  if (entry === 'src' || entry.startsWith('src/')) return true;
  if (entry === 'config' || entry === 'config/default.yaml') return true;
  if (entry === 'docs' || entry === 'docs/llms.txt') return true;
  if (entry.startsWith('docs/mcp') || entry.startsWith('docs/knowledge')) return true;
  if (entry === 'monitoring_dashboards') return true;
  if (entry === 'monitoring_dashboards/journey' || entry.startsWith('monitoring_dashboards/journey/')) return true;
  if (entry === 'monitoring_dashboards/live' || entry.startsWith('monitoring_dashboards/live/')) return true;
  return false;
}

function isForbiddenArtifactEntry(entry) {
  if (entry.includes('/.git') || entry.startsWith('.git')) return true;
  if (entry === 'plans' || entry.startsWith('plans/')) return true;
  if (entry === 'output' || entry.startsWith('output/')) return true;
  if (entry === 'deploy' || entry.startsWith('deploy/')) return true;
  if (entry === 'test' || entry.startsWith('test/')) return true;
  if (entry === 'tests' || entry.startsWith('tests/')) return true;
  if (entry === 'node_modules' || entry.startsWith('node_modules/')) return true;
  if (/\.test\.js$/.test(entry)) return true;
  if (/(^|\/)test-[^/]+\.js$/.test(entry)) return true;
  return false;
}

async function localLoadProof() {
  const tempDir = await mkdtemp(join(tmpdir(), 'aol-proof-'));
  let serverProcess = null;
  let serverOutput = '';
  let serverError = '';
  let serverExited = false;
  try {
    const dataDir = join(tempDir, 'data-root');
    const configPath = join(tempDir, 'proof-config.json');
    const journeyDbPath = join(tempDir, 'journey.duckdb');
    const port = 39_000 + Math.floor(Math.random() * 1_000);
    await writeFile(configPath, `${JSON.stringify(buildProofConfig(), null, 2)}\n`);
    const childEnv = {
      ...process.env,
      AOL_CONFIG_PATH: configPath,
      AOL_DATA_DIR: dataDir,
      AOL_JOURNEY_DB_PATH: journeyDbPath,
      AOL_SERVER_ROLE: 'main',
      AOL_ALLOW_NONSTANDARD_PORT: '1',
      AOL_SERVER_REGISTRY_FILE: join(tempDir, 'server-registry.json'),
      HOST: '127.0.0.1',
      PORT: String(port),
      NODE_ENV: 'test',
      AOL_INTERNAL_BASE_URL: `http://127.0.0.1:${port}`,
      AOL_PUBLIC_BASE_URL: `http://127.0.0.1:${port}`,
      AOL_INTERNAL_MCP_SECRET: PROOF_INTERNAL_MCP_SECRET,
    };

    serverProcess = spawn(process.execPath, ['src/index.js'], {
      cwd: rootDir,
      env: childEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    serverProcess.stdout.on('data', (chunk) => { serverOutput += chunk.toString(); });
    serverProcess.stderr.on('data', (chunk) => { serverError += chunk.toString(); });
    serverProcess.on('exit', () => { serverExited = true; });

    await waitForJson(`http://127.0.0.1:${port}/health`);

    const baseUrl = `http://127.0.0.1:${port}`;
    await requestJson(baseUrl, '/api/v1/', {
      expect: [404],
    });

    const registration = buildRegistrationRequest({
      name: `proof-${Date.now()}`,
      audience: `${baseUrl}/mcp`,
    });
    const agent = await requestJson(baseUrl, '/api/v1/agents/register', {
      method: 'POST',
      headers: { ...internalMcpHeaders('aol_register_agent'), 'content-type': 'application/json' },
      body: JSON.stringify(registration.body),
      expect: [201],
    });
    const agentId = agent.body.agent_id;
    if (!agentId) throw new Error('agent registration did not return agent_id');

    await requestJson(baseUrl, '/api/v1/agents/me', {
      headers: internalAgentHeaders(agentId, 'aol_get_me', `${baseUrl}/mcp`),
      expect: [200],
    });

    const baseline = await readProcessRssMb(serverProcess.pid);
    const samples = [{ completed: 0, rss_mb: baseline }];
    const startedAt = performance.now();
    const sampleMemory = async (completed) => {
      if (serverExited) throw new Error(`local proof server exited early\nstdout:\n${tail(serverOutput, 20).join('\n')}\nstderr:\n${tail(serverError, 20).join('\n')}`);
      samples.push({ completed, rss_mb: await readProcessRssMb(serverProcess.pid) });
    };
    const load = await runLoad(baseUrl, agentId, options.requests, options.concurrency, options.rps, sampleMemory);
    const settleSamples = [];
    for (let i = 0; i < 10; i += 1) {
      await sleep(1000);
      const rssMb = await readProcessRssMb(serverProcess.pid);
      samples.push({ completed: load.completed, rss_mb: rssMb });
      settleSamples.push({ seconds: i + 1, rss_mb: rssMb });
    }
    const finalRss = samples.at(-1).rss_mb;
    const rssSlope = linearSlope(samples.map((sample) => sample.completed / 10_000), samples.map((sample) => sample.rss_mb));
    const postLoadRssSlope = linearSlope(
      settleSamples.map((sample) => sample.seconds / 60),
      settleSamples.map((sample) => sample.rss_mb),
    );
    const rssDelta = Math.round((finalRss - baseline) * 10) / 10;
    const maxRss = Math.max(...samples.map((sample) => sample.rss_mb));
    const durationMs = Math.round(performance.now() - startedAt);

    if (load.failures.length > 0) {
      throw new Error(`load failures: ${JSON.stringify(load.failures.slice(0, 5))}`);
    }
    if (maxRss > options.maxRssMb) {
      throw new Error(`max RSS ${maxRss}MB exceeded ${options.maxRssMb}MB`);
    }
    if (options.requests >= 10_000 && postLoadRssSlope > options.maxPostLoadRssSlopeMbPerMinute) {
      throw new Error(`post-load RSS slope ${postLoadRssSlope.toFixed(3)}MB/min exceeded ${options.maxPostLoadRssSlopeMbPerMinute}`);
    }
    if (options.requests < 10_000 && rssDelta > 64) {
      throw new Error(`RSS delta ${rssDelta}MB exceeded 64MB`);
    }

    return {
      evidence: {
        requests: load.completed,
        failures: 0,
        max_rss_mb: maxRss,
        rss_delta_mb: rssDelta,
        in_load_rss_slope_mb_per_10k: Math.round(rssSlope * 1000) / 1000,
        post_load_rss_slope_mb_per_min: Math.round(postLoadRssSlope * 1000) / 1000,
        duration_ms: durationMs,
        journey_db_path: journeyDbPath,
        server_pid: serverProcess.pid,
        target_peak_rps: Math.round((500 * 5 / 60) * 10) / 10,
        proof_rps_cap: options.rps,
        proof_rate_multiplier: Math.round((options.rps / (500 * 5 / 60)) * 10) / 10,
      },
      metrics: {
        requests_per_second: Math.round((load.completed / durationMs) * 1000),
      },
    };
  } finally {
    if (serverProcess) await stopChild(serverProcess);
    await rm(tempDir, { recursive: true, force: true });
  }
}

async function runProdProofs() {
  const prodChecks = [
    ['prod_smoke', 'bash', ['deploy/prod-check.sh'], {}, 180_000],
    ['prod_mcp', process.execPath, ['scripts/test-hosted-mcp.mjs'], { AOL_MCP_BASE_URL: 'https://agentsonlightning.com', AOL_EXPECT_MCP_ONLY: '1' }, 240_000],
    ['prod_surface', process.execPath, ['scripts/audit-public-surface.mjs'], { AOL_AUDIT_BASE_URL: 'https://agentsonlightning.com', AOL_EXPECT_MCP_ONLY: '1' }, 240_000],
  ];
  for (const [name, command, commandArgs, env, timeoutMs] of prodChecks) {
    await runSettlement(name, async () => {
      const result = await runCommand(command, commandArgs, { env, timeoutMs });
      return {
        evidence: {
          command: `${command} ${commandArgs.join(' ')}`,
          stdout_tail: tail(result.stdout, 30),
          stderr_tail: tail(result.stderr, 10),
        },
      };
    });
  }

  await runSettlement('prod_state_path', prodStatePathProof);
}

async function prodStatePathProof() {
  const target = process.env.PROD_SSH_TARGET;
  const appDir = process.env.PROD_APP_DIR;
  if (!target) throw new Error('PROD_SSH_TARGET is required for prod state path proof');
  if (!appDir) throw new Error('PROD_APP_DIR is required for prod state path proof');

  const expectedJourneyDb = process.env.PROD_JOURNEY_DB_PATH || '/var/lib/agents-on-lightning/data/journey-analytics.duckdb';
  const sshArgs = [];
  if (process.env.PROD_SSH_KEY) sshArgs.push('-i', process.env.PROD_SSH_KEY);
  sshArgs.push(target, [
    'set -euo pipefail',
    `APP_DIR=${shellQuote(appDir)}`,
    `EXPECTED_DB=${shellQuote(expectedJourneyDb)}`,
    'CURRENT="$(readlink -f "$APP_DIR/current")"',
    'test ! -e "$CURRENT/data/journey-analytics.duckdb"',
    'test ! -e "$CURRENT/data/journey-analytics.duckdb.wal"',
    'test -f "$EXPECTED_DB"',
    'echo "current=$CURRENT"',
    'echo "expected_journey_db=$EXPECTED_DB"',
  ].join('; '));

  const result = await runCommand('ssh', sshArgs, { timeoutMs: 120_000 });
  return {
    evidence: {
      command: `ssh ${target} <prod-state-path-check>`,
      stdout_tail: tail(result.stdout, 20),
      expected_journey_db: expectedJourneyDb,
    },
  };
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

async function runLoad(baseUrl, agentId, totalRequests, concurrency, rps, sampleMemory) {
  const agentHeaders = internalAgentHeaders(agentId, 'hardening-proof', `${baseUrl}/mcp`);
  const routes = [
    { path: '/health', expect: [200] },
    { path: '/', expect: [200] },
    { path: '/api/v1/', expect: [200] },
    { path: '/api/v1/platform/status', expect: [200, 503] },
    { path: '/api/v1/capabilities', expect: [200] },
    { path: '/api/v1/mcp-docs', expect: [200] },
    { path: '/api/v1/market/config', expect: [200] },
    { path: '/api/v1/leaderboard?limit=10', expect: [200] },
    { path: '/api/v1/agents/me', headers: agentHeaders, expect: [200] },
    { path: '/api/v1/wallet/balance', headers: agentHeaders, expect: [200] },
    { path: '/api/v1/capital/balance', headers: agentHeaders, expect: [200] },
    { path: '/.well-known/mcp.json', expect: [200] },
    { path: '/.well-known/mcp/server-card.json', expect: [200] },
  ];
  const failures = [];
  let next = 0;
  let completed = 0;
  const sampleEvery = Math.max(1, Math.floor(totalRequests / 10));
  let sampling = Promise.resolve();
  const startedAt = performance.now();

  async function worker() {
    while (true) {
      const index = next;
      next += 1;
      if (index >= totalRequests || failures.length > 20) return;
      const targetStartMs = startedAt + ((index / rps) * 1000);
      const waitMs = targetStartMs - performance.now();
      if (waitMs > 0) await sleep(waitMs);
      const route = routes[index % routes.length];
      try {
        const headers = route.path.startsWith('/api/v1/')
          ? { ...internalMcpHeaders(route.path), ...(route.headers || {}) }
          : route.headers || {};
        const result = await requestJson(baseUrl, route.path, {
          headers,
          expect: route.expect,
        });
        if (!route.expect.includes(result.status)) {
          failures.push({ path: route.path, status: result.status });
        }
      } catch (error) {
        failures.push({ path: route.path, error: error.message });
      }
      completed += 1;
      if (completed % sampleEvery === 0) {
        const sampledAt = completed;
        sampling = sampling.then(() => sampleMemory(sampledAt));
      }
    }
  }

  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  await sampling;
  return { completed, failures };
}

async function requestJson(baseUrl, path, {
  method = 'GET',
  headers = {},
  body = undefined,
  expect = [200],
} = {}) {
  const response = await fetch(new URL(path, baseUrl), {
    method,
    headers: { 'user-agent': 'aol-hardening-proof', ...headers },
    body,
  });
  const text = await response.text();
  let parsed = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = text;
  }
  if (!expect.includes(response.status)) {
    throw new Error(`${method} ${path} returned ${response.status}: ${String(text).slice(0, 200)}`);
  }
  return { status: response.status, body: parsed };
}

async function waitForJson(url) {
  const deadline = Date.now() + 10_000;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return response.json();
    } catch (error) {
      lastError = error;
    }
    await sleep(100);
  }
  throw lastError || new Error(`timed out waiting for ${url}`);
}

function internalMcpHeaders(toolName = 'hardening-proof') {
  return {
    'x-aol-internal-mcp': PROOF_INTERNAL_MCP_SECRET,
    'x-aol-mcp-tool': toolName,
  };
}

function internalAgentHeaders(agentId, toolName = 'hardening-proof', audience = 'http://127.0.0.1/mcp') {
  return {
    ...internalMcpHeaders(toolName),
    'x-aol-verified-agent-id': agentId,
    'x-aol-auth-payload-hash': 'a'.repeat(64),
    'x-aol-auth-audience': audience,
  };
}

function buildProofConfig() {
  const highLimit = { perAgent: 10_000_000, perIp: 10_000_000, global: 10_000_000, windowMs: 60_000 };
  const categories = Object.fromEntries([
    'registration',
    'analysis',
    'wallet_write',
    'wallet_read',
    'social_write',
    'social_read',
    'discovery',
    'mcp',
    'channel_instruct',
    'channel_read',
    'analytics_query',
    'capital_read',
    'capital_write',
    'market_read',
    'market_private_read',
    'market_write',
    'identity_read',
    'identity_write',
    'node_write',
  ].map((name) => [name, highLimit]));

  const attempts = {
    agentAttemptLimit: 10_000_000,
    sharedAttemptLimit: 10_000_000,
    attemptWindowMs: 60_000,
  };
  const caps = {
    autoApproveSats: 1_000,
    hardCapSats: 1_000,
    dailyAutoApproveSats: 1_000,
    dailyHardCapSats: 1_000,
    sharedDailyAutoApproveSats: 1_000,
    sharedDailyHardCapSats: 1_000,
  };

  return {
    nodes: {},
    cashu: {},
    rateLimits: {
      categories,
      globalCap: { limit: 10_000_000, windowMs: 60_000 },
      progressive: {
        resetWindowMs: 60_000,
        thresholds: [
          { violations: 10, multiplier: 4 },
          { violations: 5, multiplier: 2 },
        ],
      },
    },
    velocity: { dailyLimitSats: 10_000_000 },
    wallet: { maxRoutingFeeSats: 100, withdrawalTimeoutSeconds: 5 },
    help: {
      rateLimit: 10_000,
      rateWindowMs: 60_000,
      upstreamTimeoutMs: 1_000,
      circuitFailureLimit: 10,
      circuitFailureWindowMs: 60_000,
      circuitOpenMs: 1_000,
    },
    swap: {
      minSwapSats: 1,
      maxSwapSats: 1_000,
      maxConcurrentSwaps: 1,
      pollIntervalMs: 60_000,
      invoiceTimeoutSeconds: 5,
      feeLimitSat: 10,
      swapExpiryMs: 60_000,
    },
    safety: { signedChannels: { defaultCooldownMinutes: 1 } },
    channelOpen: {
      minChannelSizeSats: 20_000,
      maxChannelSizeSats: 1_000_000,
      maxTotalChannels: 1_000_000,
      maxPerAgent: 1_000_000,
      pendingOpenTimeoutBlocks: 6,
      connectPeerTimeoutMs: 1_000,
      defaultSatPerVbyte: 1,
      peerSafety: {
        forceCloseLimit: 10,
        requireAllowlist: false,
        minPeerChannels: 1,
        maxPeerLastUpdateAgeSeconds: 315_360_000,
      },
      startupPolicyLimits: {
        minBaseFeeMsat: 0,
        maxBaseFeeMsat: 10_000_000,
        minFeeRatePpm: 0,
        maxFeeRatePpm: 1_000_000,
        minTimeLockDelta: 1,
        maxTimeLockDelta: 2_016,
      },
    },
    rebalance: {
      minAmountSats: 1,
      maxAmountSats: 1_000,
      maxFeeSats: 10,
      paymentTimeoutSeconds: 5,
      maxConcurrentPerAgent: 1,
    },
    dangerRoutes: {
      channels: {
        preview: { ...attempts, perChannelAttemptLimit: 10_000_000 },
        instruct: { ...attempts, perChannelAttemptLimit: 10_000_000, sharedCooldownMs: 1 },
      },
      capitalWithdraw: {
        attemptLimit: 10_000_000,
        attemptWindowMs: 60_000,
        cooldownMs: 1,
        caps,
      },
      market: {
        sharedSuccessCooldownMs: 1,
        maxPendingOperations: 10_000,
        preview: { ...attempts, caps },
        open: { ...attempts, cooldownMs: 1, caps },
        close: { ...attempts, cooldownMs: 1 },
        swap: { ...attempts, cooldownMs: 1, caps },
        fundFromEcash: { ...attempts, cooldownMs: 1, caps },
        rebalance: { ...attempts, cooldownMs: 1, caps },
        rebalanceEstimate: attempts,
      },
    },
  };
}

function tail(text, lines) {
  return text.trim().split('\n').filter(Boolean).slice(-lines);
}

function linearSlope(xs, ys) {
  if (xs.length < 2 || ys.length < 2 || xs.length !== ys.length) return 0;
  const xMean = xs.reduce((sum, value) => sum + value, 0) / xs.length;
  const yMean = ys.reduce((sum, value) => sum + value, 0) / ys.length;
  let numerator = 0;
  let denominator = 0;
  for (let i = 0; i < xs.length; i += 1) {
    numerator += (xs[i] - xMean) * (ys[i] - yMean);
    denominator += (xs[i] - xMean) ** 2;
  }
  return denominator === 0 ? 0 : numerator / denominator;
}

function sleep(ms) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

async function readProcessRssMb(pid) {
  const result = await runCommand('ps', ['-o', 'rss=', '-p', String(pid)], { timeoutMs: 10_000 });
  const kb = Number(result.stdout.trim());
  if (!Number.isFinite(kb) || kb <= 0) throw new Error(`could not read RSS for pid ${pid}`);
  return Math.round((kb / 1024) * 10) / 10;
}

async function stopChild(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGTERM');
  const exited = await new Promise((resolveStop) => {
    const timer = setTimeout(() => resolveStop(false), 10_000);
    child.once('exit', () => {
      clearTimeout(timer);
      resolveStop(true);
    });
  });
  if (!exited) {
    child.kill('SIGKILL');
  }
}

function printSummary() {
  const failed = settlements.filter((settlement) => !settlement.ok);
  console.log('');
  console.log(failed.length === 0 ? 'AOL HARDENING PROOF: PASS' : 'AOL HARDENING PROOF: FAIL');
  console.log('');
  for (const settlement of settlements) {
    const status = settlement.ok ? 'PASS' : 'FAIL';
    const evidence = settlement.ok ? JSON.stringify(settlement.evidence) : settlement.error.split('\n')[0];
    console.log(`${status.padEnd(4)} ${settlement.name.padEnd(18)} ${evidence}`);
  }
  console.log('');
  console.log(`report=${reportPath}`);
}

await mkdir(reportDir, { recursive: true });

await runSettlement('manifest_contract', manifestProof);
await runSettlement('unit_contracts', unitProof);
await runSettlement('runtime_artifact', artifactProof);
await runSettlement('local_load_memory', localLoadProof);
if (options.prod) await runProdProofs();

const failed = settlements.filter((settlement) => !settlement.ok);
await writeFile(reportPath, `${JSON.stringify({
  built_at: now.toISOString(),
  options,
  ok: failed.length === 0,
  settlements,
}, null, 2)}\n`);

printSummary();
process.exit(failed.length === 0 ? 0 : 1);
