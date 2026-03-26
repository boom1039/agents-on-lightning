/**
 * Agents on Lightning — Express server entry point.
 * Agent platform for the Lightning Network.
 */

import express from 'express';
// cors available if needed for more complex setups
import { createServer } from 'node:http';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AgentDaemon } from './daemon.js';
import { globalRateLimit } from './identity/rate-limiter.js';
import { auditMiddleware } from './identity/audit-log.js';
import { agentGatewayRoutes } from './routes/agent-gateway.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = parseInt(process.env.PORT || '3200', 10);

export async function startServer() {
  const app = express();
  app.set('trust proxy', 1);
  app.use(express.json({ limit: '16kb' }));

  // Security headers
  app.use((_req, res, next) => {
    res.header('X-Content-Type-Options', 'nosniff');
    res.header('X-Frame-Options', 'DENY');
    res.header('X-XSS-Protection', '0');
    res.header('Referrer-Policy', 'no-referrer');
    next();
  });

  // CORS
  const allowedOrigins = new Set([
    'http://localhost:3200',
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
      res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
      res.header('Vary', 'Origin');
    }
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
  });

  // Rate limiting + audit
  app.use(globalRateLimit);
  app.use(auditMiddleware);

  // Content negotiation: serve llms.txt when agents request markdown
  const docsDir = join(__dirname, '..', 'docs');
  app.get('/', (req, res, next) => {
    const accept = req.headers.accept || '';
    if (accept.includes('text/markdown') || accept.includes('text/plain')) {
      res.set('Vary', 'Accept');
      return res.type('text/markdown').sendFile(join(docsDir, 'llms.txt'));
    }
    // Default: return platform info JSON
    res.json({
      name: 'Agents on Lightning',
      description: 'AI agent platform for the Lightning Network',
      docs: '/docs/llms.txt',
      api: '/api/v1/',
    });
  });

  // Serve llms.txt at root (agents expect /llms.txt)
  app.get('/llms.txt', (_req, res) => {
    res.type('text/markdown').sendFile(join(docsDir, 'llms.txt'));
  });

  // Serve docs statically
  app.use('/docs', express.static(docsDir));

  // Start daemon
  const daemon = new AgentDaemon();
  try {
    await daemon.start();
  } catch (err) {
    console.error(`[server] Daemon startup failed: ${err.message}`);
    console.error('[server] Continuing in limited mode');
  }

  // Mount agent API gateway
  app.use(agentGatewayRoutes(daemon));

  // Health check
  app.get('/health', (_req, res) => {
    res.json({
      status: 'ok',
      agents: daemon.agentRegistry?.count() || 0,
      nodes: daemon.nodeManager?.getNodeNames()?.length || 0,
    });
  });

  // Start listening
  const server = createServer(app);
  server.listen(PORT, () => {
    console.log(`[server] Agents on Lightning listening on port ${PORT}`);
  });

  // Graceful shutdown
  for (const sig of ['SIGTERM', 'SIGINT']) {
    process.on(sig, async () => {
      console.log(`[server] ${sig} received, shutting down...`);
      await daemon.stop();
      server.close(() => process.exit(0));
    });
  }

  return { app, server, daemon };
}

startServer().catch(err => {
  console.error('[server] Fatal:', err);
  process.exit(1);
});
