import express, { Router } from 'express';
import { resolve, dirname } from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { getAgentSurfaceManifest, getAgentSurfaceSummary } from '../monitor/agent-surface-inventory.js';
import { getJourneyMonitor } from '../monitor/journey-monitor.js';
import { err404HiddenRoute } from '../identity/agent-friendly-errors.js';
import {
  isLoopbackRequest,
  rejectUnauthorizedAnalyticsQueryRoute,
  rejectUnauthorizedJourneyRoute,
} from '../identity/request-security.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const JOURNEY_DIR = resolve(__dirname, '..', '..', 'monitoring_dashboards', 'journey');
const PRETEXT_DIST_DIR = resolve(__dirname, '..', '..', 'node_modules', '@chenglou', 'pretext', 'dist');

function intParam(val) {
  return val ? parseInt(val, 10) : undefined;
}

function requireJourneyAccess(req, res, next) {
  const rejection = rejectUnauthorizedJourneyRoute(req, res);
  if (rejection) return rejection;
  return next();
}

function analyticsHandler(fn, errorStatus = 500) {
  return async (req, res) => {
    try {
      getJourneyMonitor()?.noteJourneyAccess?.();
      res.json(await fn(req));
    } catch (err) {
      res.status(errorStatus).json({ error: err.message || 'analytics error' });
    }
  };
}

async function getJourneyMonitorForLiveView() {
  const monitor = getJourneyMonitor();
  if (!monitor) return null;
  await monitor.ensureLiveRuntime?.();
  return monitor;
}

function rejectSyntheticRoute(req, res) {
  if (!isLoopbackRequest(req)) {
    return err404HiddenRoute(res);
  }
  return null;
}

function rejectLocalOnlyRoute(req, res) {
  if (!isLoopbackRequest(req)) {
    return err404HiddenRoute(res);
  }
  return null;
}

function getJourneyUpstreamOrigin(env = process.env) {
  const raw = typeof env.AOL_JOURNEY_UPSTREAM_ORIGIN === 'string'
    ? env.AOL_JOURNEY_UPSTREAM_ORIGIN.trim()
    : '';
  return raw || 'https://agentsonlightning.com';
}

function getJourneySource(req) {
  const raw = typeof req.query?.source === 'string' ? req.query.source.trim().toLowerCase() : '';
  if (raw === 'local' || raw === 'prod') return raw;
  return null;
}

function shouldProxyJourney(req) {
  if (!isLoopbackRequest(req)) return false;
  const source = getJourneySource(req);
  if (source === 'local') return false;
  if (source === 'prod') return Boolean(getJourneyUpstreamOrigin());
  return Boolean(getJourneyUpstreamOrigin());
}

function buildJourneyUpstreamUrl(req, origin) {
  const upstreamUrl = new URL(req.originalUrl || req.url, origin);
  upstreamUrl.searchParams.delete('source');
  return upstreamUrl;
}

function copyResponseHeaders(from, to, extra = {}) {
  for (const [key, value] of from.headers.entries()) {
    const lower = key.toLowerCase();
    if (lower === 'content-length' || lower === 'transfer-encoding' || lower === 'connection') continue;
    to.setHeader(key, value);
  }
  for (const [key, value] of Object.entries(extra)) {
    to.setHeader(key, value);
  }
}

async function proxyJourneyJson(req, res, origin) {
  const upstream = await fetch(buildJourneyUpstreamUrl(req, origin), {
    headers: {
      Accept: req.get('accept') || 'application/json',
      'User-Agent': 'agents-on-lightning-local-journey-proxy',
      ...(req.get('authorization') ? { Authorization: req.get('authorization') } : {}),
      ...(req.get('x-operator-secret') ? { 'x-operator-secret': req.get('x-operator-secret') } : {}),
    },
  });
  const body = Buffer.from(await upstream.arrayBuffer());
  copyResponseHeaders(upstream, res);
  res.status(upstream.status).send(body);
}

async function proxyJourneyStream(req, res, origin) {
  const controller = new AbortController();
  req.on('close', () => controller.abort());
  const upstream = await fetch(buildJourneyUpstreamUrl(req, origin), {
    headers: {
      Accept: req.get('accept') || 'text/event-stream',
      'Cache-Control': 'no-cache',
      'User-Agent': 'agents-on-lightning-local-journey-proxy',
      ...(req.get('authorization') ? { Authorization: req.get('authorization') } : {}),
      ...(req.get('x-operator-secret') ? { 'x-operator-secret': req.get('x-operator-secret') } : {}),
    },
    signal: controller.signal,
  });
  copyResponseHeaders(upstream, res, {
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  res.status(upstream.status);
  res.flushHeaders();
  if (!upstream.body) {
    return res.end();
  }
  const upstreamStream = Readable.fromWeb(upstream.body);
  upstreamStream.on('error', () => {
    if (!res.writableEnded) res.end();
  });
  upstreamStream.pipe(res);
}

export function journeyRoutes() {
  const router = Router();
  const journeyUpstreamOrigin = getJourneyUpstreamOrigin();

  router.use('/journey', requireJourneyAccess);
  router.use('/api/journey', requireJourneyAccess);
  router.use('/api/analytics', requireJourneyAccess);
  router.use('/api/demo/synthetic', requireJourneyAccess);

  router.use('/journey/vendor/pretext', express.static(PRETEXT_DIST_DIR, { etag: false, maxAge: 0 }));
  router.use('/journey', express.static(JOURNEY_DIR, { etag: false, maxAge: 0 }));
  router.get('/journey', (_req, res) => res.sendFile(resolve(JOURNEY_DIR, 'index.html')));
  router.get('/journey/agents', (_req, res) => res.sendFile(resolve(JOURNEY_DIR, 'agents.html')));
  router.get('/journey/three', (_req, res) => res.sendFile(resolve(JOURNEY_DIR, 'three.html')));

  router.use(async (req, res, next) => {
    if (!journeyUpstreamOrigin || req.method !== 'GET' || !shouldProxyJourney(req)) {
      return next();
    }
    try {
      if (req.path === '/api/journey/events') {
        await proxyJourneyStream(req, res, journeyUpstreamOrigin);
        return;
      }
      if (
        req.path === '/api/journey'
        || req.path === '/api/journey/manifest'
        || req.path.startsWith('/api/analytics/')
      ) {
        await proxyJourneyJson(req, res, journeyUpstreamOrigin);
        return;
      }
    } catch (err) {
      return res.status(502).json({
        error: 'journey upstream unavailable',
        detail: err.message || 'proxy failed',
      });
    }
    return next();
  });

  router.get('/api/journey', async (_req, res) => {
    const monitor = await getJourneyMonitorForLiveView();
    const catalog = getAgentSurfaceSummary();
    res.json(monitor ? await monitor.buildSnapshot() : {
      builtAt: Date.now(),
      stats: {
        agents: 0,
        routes: catalog.endpoint_routes_canonical,
        endpoints: catalog.endpoint_routes_canonical,
        docs: catalog.doc_nodes_total,
        docSurfaces: catalog.doc_surfaces_total,
        internalRoutes: catalog.internal_routes_canonical,
        surfaces: 0,
        inFlight: 0,
        eventsSeen: 0,
        droppedAgents: 0,
      },
      catalog,
      domains: [],
      routes: [],
      agents: [],
      recentEvents: [],
      history: { totalEvents: 0, uniqueAgents: 0, hydratedAt: 0 },
      log: { backend: 'duckdb', level: 'offline', lastSizeBytes: 0, totalEvents: 0, uniqueAgents: 0 },
    });
  });

  router.get('/api/journey/manifest', (_req, res) => {
    getJourneyMonitor()?.noteJourneyAccess?.();
    res.json(getAgentSurfaceManifest());
  });

  router.get('/api/journey/events', async (req, res) => {
    const monitor = await getJourneyMonitorForLiveView();
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    });
    res.flushHeaders();

    res.write(`data: ${JSON.stringify({
      type: 'snapshot',
      snapshot: monitor ? await monitor.buildSnapshot() : null,
    })}\n\n`);

    if (!monitor) return res.end();
    monitor.addClient(res);
    const heartbeat = setInterval(() => res.write(': heartbeat\n\n'), 30_000);
    req.on('close', () => {
      monitor.removeClient(res);
      clearInterval(heartbeat);
    });
  });

  router.get('/api/demo/synthetic', (req, res) => {
    const rejection = rejectSyntheticRoute(req, res);
    if (rejection) return rejection;
    const monitor = getJourneyMonitor();
    monitor?.noteJourneyAccess?.();
    res.json(monitor ? monitor.getSyntheticStatus() : {
      ok: true,
      running: false,
      agentsCreated: 0,
      activeAgents: 0,
      inflight: 0,
      eventsEmitted: 0,
      tickMs: 0,
    });
  });

  router.post('/api/demo/synthetic/start', async (req, res) => {
    const rejection = rejectSyntheticRoute(req, res);
    if (rejection) return rejection;
    const monitor = getJourneyMonitor();
    if (!monitor) {
      return res.status(503).json({ ok: false, error: 'journey monitor unavailable' });
    }
    await monitor.ensureLiveRuntime?.();
    return res.json(await monitor.startSyntheticTraffic());
  });

  router.post('/api/demo/synthetic/stop', async (req, res) => {
    const rejection = rejectSyntheticRoute(req, res);
    if (rejection) return rejection;
    const monitor = getJourneyMonitor();
    if (!monitor) {
      return res.status(503).json({ ok: false, error: 'journey monitor unavailable' });
    }
    await monitor.ensureLiveRuntime?.();
    return res.json(await monitor.stopSyntheticTraffic());
  });

  router.get('/api/analytics/summary', analyticsHandler(() => getJourneyMonitor().summary()));

  router.get('/api/analytics/timeseries', analyticsHandler(req => {
    const { interval, since, until, domain, agent_id } = req.query;
    return getJourneyMonitor().eventsByInterval({
      intervalMinutes: intParam(interval) || 60,
      since: intParam(since),
      until: intParam(until),
      domain: domain || undefined,
      agentId: agent_id || undefined,
    });
  }));

  router.get('/api/analytics/top-routes', analyticsHandler(req => {
    const { limit, since, domain } = req.query;
    return getJourneyMonitor().topRoutes({
      limit: intParam(limit) || 20,
      since: intParam(since),
      domain: domain || undefined,
    });
  }));

  router.get('/api/analytics/agents', analyticsHandler(req => {
    const { limit, since } = req.query;
    return getJourneyMonitor().agentActivity({
      limit: intParam(limit) || 50,
      since: intParam(since),
    });
  }));

  router.get('/api/analytics/domains', analyticsHandler(req => {
    const { since } = req.query;
    return getJourneyMonitor().domainBreakdown({ since: intParam(since) });
  }));

  router.get('/api/analytics/errors', analyticsHandler(req => {
    const { since, limit } = req.query;
    return getJourneyMonitor().errorBreakdown({
      since: intParam(since),
      limit: intParam(limit) || 20,
    });
  }));

  router.get('/api/analytics/agent/:id/journey', analyticsHandler(req =>
    getJourneyMonitor().agentJourney(req.params.id)
  ));

  router.get('/api/analytics/schema', analyticsHandler(() =>
    getJourneyMonitor().eventSchema()
  ));

  router.get('/api/analytics/events', analyticsHandler(req =>
    getJourneyMonitor().latestEvents({
      limit: intParam(req.query.limit) || 100,
    })
  ));

  router.get('/api/analytics/mcp-activity', analyticsHandler(req =>
    getJourneyMonitor().mcpToolActivity({
      limit: intParam(req.query.limit) || 100,
      since: intParam(req.query.since),
      agentId: req.query.agent_id || undefined,
    })
  ));

  router.get('/api/analytics/mcp-tools', analyticsHandler(req =>
    getJourneyMonitor().mcpToolActivity({
      limit: intParam(req.query.limit) || 100,
      since: intParam(req.query.since),
      agentId: req.query.agent_id || undefined,
    })
  ));

  router.get('/api/analytics/mcp-agents', analyticsHandler(req =>
    getJourneyMonitor().mcpAgentSummary({
      limit: intParam(req.query.limit) || 50,
      since: intParam(req.query.since),
    })
  ));

  router.get('/api/analytics/mcp-agent/:id/journey', analyticsHandler(async req => {
    const toolEvents = await getJourneyMonitor().mcpAgentJourney(req.params.id);
    const backendRequests = await getJourneyMonitor().mcpBackendRequests({
      agentId: req.params.id,
      limit: intParam(req.query.backend_limit) || 200,
    });
    return {
      agent_id: req.params.id,
      tool_events: toolEvents,
      backend_requests: backendRequests,
    };
  }));

  router.get('/api/analytics/mcp-funnel', analyticsHandler(req =>
    getJourneyMonitor().mcpLifecycleFunnel({
      since: intParam(req.query.since),
    })
  ));

  router.get('/api/analytics/mcp-dropoffs', analyticsHandler(req =>
    getJourneyMonitor().mcpStageDropoffs({
      since: intParam(req.query.since),
    })
  ));

  router.get('/api/analytics/mcp-milestones', analyticsHandler(req =>
    getJourneyMonitor().mcpFinancialMilestones({
      since: intParam(req.query.since),
    })
  ));

  router.get('/api/analytics/mcp-retention', analyticsHandler(req =>
    getJourneyMonitor().mcpRetentionSignals({
      since: intParam(req.query.since),
    })
  ));

  router.get('/api/analytics/mcp-tool-breakdown', analyticsHandler(req =>
    getJourneyMonitor().mcpToolBreakdown({
      since: intParam(req.query.since),
    })
  ));

  router.get('/api/analytics/ledger/summary', analyticsHandler(() =>
    getJourneyMonitor().ledgerSummary()
  ));

  router.get('/api/analytics/ledger/recent', analyticsHandler(req =>
    getJourneyMonitor().ledgerRecent({
      limit: intParam(req.query.limit) || 100,
      offset: intParam(req.query.offset) || 0,
      since: intParam(req.query.since),
      type: req.query.type || undefined,
      agentId: req.query.agent_id || undefined,
    })
  ));

  router.get('/api/analytics/ledger/agents', analyticsHandler(req =>
    getJourneyMonitor().ledgerAgents({
      limit: intParam(req.query.limit) || 100,
      offset: intParam(req.query.offset) || 0,
      agentId: req.query.agent_id || undefined,
    })
  ));

  router.get('/api/analytics/ledger/agent/:id', analyticsHandler(req =>
    getJourneyMonitor().ledgerAgent(req.params.id, {
      limit: intParam(req.query.limit) || 100,
      offset: intParam(req.query.offset) || 0,
      capitalLimit: intParam(req.query.capital_limit) || 100,
      capitalOffset: intParam(req.query.capital_offset) || 0,
      type: req.query.type || undefined,
      since: intParam(req.query.since),
    })
  ));

  router.get('/api/analytics/ledger/reconciliation', analyticsHandler(() =>
    getJourneyMonitor().ledgerReconciliation()
  ));

  router.post('/api/analytics/query', async (req, res) => {
    const rejection = rejectUnauthorizedAnalyticsQueryRoute(req, res);
    if (rejection) return rejection;
    try {
      const { sql, params } = req.body || {};
      if (!sql) {
        return res.status(400).json({ error: 'sql is required' });
      }
      return res.json(await getJourneyMonitor().query(sql, params));
    } catch (err) {
      return res.status(400).json({ error: err.message || 'analytics error' });
    }
  });

  return router;
}
