/**
 * Agents on Lightning — Express server entry point.
 * Agent platform for the Lightning Network.
 */

import express from 'express';
// cors available if needed for more complex setups
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { realpathSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AgentDaemon } from './daemon.js';
import { globalRateLimit } from './identity/rate-limiter.js';
import { auditMiddleware } from './identity/audit-log.js';
import {
  createMcpOnlyApiGuard,
  createMcpOnlyDocsGuard,
  handleJsonBodyError,
  requireJsonWriteContent,
} from './identity/request-security.js';
import { agentGatewayRoutes } from './routes/agent-gateway.js';
import { journeyRoutes } from './routes/journey-routes.js';
import { mcpRoutes } from './routes/mcp-routes.js';
import { registerApp } from './monitor/agent-surface-inventory.js';
import { startJourneyMonitor, stopJourneyMonitor } from './monitor/journey-monitor.js';
import { getDefaultPortForRole, getServerRole, reserveServerSlot } from './server-instance-guard.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_HOST = '0.0.0.0';
const DEFAULT_PORT = 3302;

export function getListenConfig(env = process.env) {
  const role = getServerRole(env);
  const host = typeof env.HOST === 'string' && env.HOST.trim()
    ? env.HOST.trim()
    : DEFAULT_HOST;
  const rawPort = Number.parseInt(env.PORT || `${getDefaultPortForRole(role) || DEFAULT_PORT}`, 10);
  const port = Number.isFinite(rawPort) && rawPort > 0
    ? rawPort
    : getDefaultPortForRole(role) || DEFAULT_PORT;
  return { host, port, role };
}

export function getJourneyDbPath(env = process.env) {
  const explicit = typeof env.AOL_JOURNEY_DB_PATH === 'string'
    ? env.AOL_JOURNEY_DB_PATH.trim()
    : '';
  if (explicit) return explicit;

  const dataDir = typeof env.AOL_DATA_DIR === 'string'
    ? env.AOL_DATA_DIR.trim()
    : '';
  if (dataDir) return resolve(dataDir, 'data', 'journey-analytics.duckdb');

  return undefined;
}

export function getInternalMcpSecret(env = process.env) {
  const explicit = typeof env.AOL_INTERNAL_MCP_SECRET === 'string'
    ? env.AOL_INTERNAL_MCP_SECRET.trim()
    : '';
  if (explicit) return explicit;

  const generated = randomBytes(32).toString('hex');
  env.AOL_INTERNAL_MCP_SECRET = generated;
  return generated;
}

export async function startServer() {
  const { host, port, role } = getListenConfig();
  const internalMcpSecret = getInternalMcpSecret();
  const serverSlot = reserveServerSlot({ role, host, port });
  const journeyMonitor = await startJourneyMonitor({
    dbPath: getJourneyDbPath(),
  });
  const app = express();
  app.set('trust proxy', process.env.TRUST_PROXY === '1' ? 1 : false);
  app.use(express.json({ limit: '16kb' }));
  app.use(handleJsonBodyError);

  // Security headers
  app.use((_req, res, next) => {
    res.header('X-Content-Type-Options', 'nosniff');
    res.header('X-Frame-Options', 'DENY');
    res.header('X-XSS-Protection', '0');
    res.header('Referrer-Policy', 'no-referrer');
    res.header('Cross-Origin-Opener-Policy', 'same-origin');
    res.header('Cross-Origin-Resource-Policy', 'same-origin');
    res.header('Permissions-Policy', 'geolocation=(), microphone=(), camera=()');
    next();
  });

  // CORS
  const allowedOrigins = new Set([
    'https://agentsonlightning.com',
    'https://www.agentsonlightning.com',
    'https://agentsonbitcoin.com',
    'https://www.agentsonbitcoin.com',
  ]);
  if (process.env.CORS_ORIGINS) {
    process.env.CORS_ORIGINS.split(',').forEach(o => allowedOrigins.add(o.trim()));
  }
  app.use((req, res, next) => {
    const origin = req.headers.origin;
    if (origin && allowedOrigins.has(origin)) {
      res.header('Access-Control-Allow-Origin', origin);
      res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
      res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Operator-Secret');
      res.header('Vary', 'Origin');
    }
    if (req.method === 'OPTIONS') {
      if (req.path.startsWith('/api/v1/')) return next();
      return res.sendStatus(204);
    }
    next();
  });

  // Rate limiting + audit
  app.use(globalRateLimit);
  app.use(auditMiddleware);
  app.use(createMcpOnlyApiGuard({ internalMcpSecret }));
  app.use(requireJsonWriteContent);

  const docsDir = join(__dirname, '..', 'docs');
  // Serve the app root and link to the canonical docs.
  // @agent-route {"auth":"public","domain":"app-level","subgroup":"App","label":"root","summary":"Serve the app root and link to the canonical docs.","order":100,"tags":["app-level","read","docs","public"],"doc":"llms.txt","security":{"moves_money":false,"requires_ownership":false,"requires_signature":false,"long_running":false}}
  app.get('/', (_req, res) => {
    res.json({
      name: 'Agents on Lightning',
      description: 'Agent-first MCP platform for Bitcoin Lightning. Agents can register, manage wallet and capital, coordinate, open channels, provide liquidity, and earn routing fees. Zero platform fees and zero commissions.',
      agent_start: '/llms.txt',
      mcp_endpoint: '/mcp',
      tool_reference: '/docs/mcp/reference.txt',
      discovery: {
        mcp_manifest: '/.well-known/mcp.json',
        mcp_server_card: '/.well-known/mcp/server-card.json',
        agent_card: '/.well-known/agent-card.json',
      },
    });
  });

  // Serve llms.txt at root (agents expect /llms.txt)
  // Serve the root agent map document.
  // @agent-route {"auth":"public","domain":"app-level","subgroup":"App","label":"llms.txt","summary":"Serve the root agent map document.","order":110,"tags":["app-level","read","docs","public"],"doc":"llms.txt","security":{"moves_money":false,"requires_ownership":false,"requires_signature":false,"long_running":false}}
  app.get('/llms.txt', (_req, res) => {
    res.type('text/markdown').sendFile(join(docsDir, 'llms.txt'));
  });

  app.get('/docs/llms.txt', (_req, res) => {
    res.status(404).json({
      error: 'Use GET /llms.txt.',
      canonical: '/llms.txt',
    });
  });

  // Serve docs statically
  app.use('/docs', createMcpOnlyDocsGuard());
  app.use('/docs', express.static(docsDir));

  // Start daemon
  const daemon = new AgentDaemon(process.env.AOL_CONFIG_PATH);
  try {
    await daemon.start();
  } catch (err) {
    daemon._startupError = err.message;
    console.error(`[server] Daemon startup failed: ${err.message}`);
    console.error('[server] Continuing in limited mode');
  }
  journeyMonitor?.setDaemon?.(daemon);

  const internalBaseUrl = process.env.AOL_INTERNAL_BASE_URL || `http://127.0.0.1:${port}`;
  const publicBaseUrl = process.env.AOL_PUBLIC_BASE_URL || 'https://agentsonlightning.com';

  app.use(mcpRoutes({ internalBaseUrl, publicBaseUrl, internalMcpSecret }));

  // Mount agent API gateway
  app.use(agentGatewayRoutes(daemon));

  // Mount Journey dashboard and analytics on the main app server
  app.use(journeyRoutes());

  // Extract live route catalog from the mounted Express router
  const routes = registerApp(app);
  console.log(`[server] ${routes.length} agent-facing routes registered`);

  // Health check
  // Return server and daemon health.
  // @agent-route {"auth":"public","domain":"app-level","subgroup":"App","label":"health","summary":"Return server and daemon health.","order":120,"tags":["app-level","read","public"],"doc":["skills/discovery.txt","llms.txt"],"security":{"moves_money":false,"requires_ownership":false,"requires_signature":false,"long_running":false}}
  app.get('/health', (_req, res) => {
    res.json(daemon.getHealthSummary?.() || {
      status: 'degraded',
      degraded: true,
      agents: daemon.agentRegistry?.count() || 0,
      nodes: daemon.nodeManager?.getNodeNames()?.length || 0,
      warnings: [],
      startup_error: daemon._startupError || 'health summary unavailable',
    });
  });

  // Start listening
  const server = createServer(app);
  server.listen(port, host, () => {
    console.log(`[server] Agents on Lightning listening on ${host}:${port} (${role})`);
  });

  // Graceful shutdown
  let shuttingDown = false;
  for (const sig of ['SIGTERM', 'SIGINT']) {
    process.on(sig, async () => {
      if (shuttingDown) return;
      shuttingDown = true;
      console.log(`[server] ${sig} received, shutting down...`);
      try {
        await daemon.stop();
        await stopJourneyMonitor();
      } catch (err) {
        console.error(`[server] Shutdown error: ${err.message}`);
      }
      server.close(() => {
        serverSlot.release();
        process.exit(0);
      });
    });
  }

  server.on('close', () => {
    serverSlot.release();
  });

  return { app, server, daemon, journeyMonitor };
}

export function isDirectExecution(moduleUrl = import.meta.url, argv1 = process.argv[1]) {
  if (!argv1) return false;
  const modulePath = fileURLToPath(moduleUrl);
  try {
    return realpathSync(modulePath) === realpathSync(argv1);
  } catch {
    return modulePath === argv1;
  }
}

if (isDirectExecution(import.meta.url, process.argv[1])) {
  startServer().catch(err => {
    console.error('[server] Fatal:', err);
    process.exit(1);
  });
}
