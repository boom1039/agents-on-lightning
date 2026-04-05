import express, { Router } from 'express';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getAgentSurfaceManifest, getAgentSurfaceSummary } from '../monitor/agent-surface-inventory.js';
import { getJourneyMonitor } from '../monitor/journey-monitor.js';
import { err404HiddenRoute } from '../identity/agent-friendly-errors.js';
import { isLoopbackRequest, rejectUnauthorizedOperatorRoute } from '../identity/request-security.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const JOURNEY_DIR = resolve(__dirname, '..', '..', 'monitoring_dashboards', 'journey');

function intParam(val) {
  return val ? parseInt(val, 10) : undefined;
}

function analyticsHandler(fn, errorStatus = 500) {
  return async (req, res) => {
    try {
      res.json(await fn(req));
    } catch (err) {
      res.status(errorStatus).json({ error: err.message || 'analytics error' });
    }
  };
}

function rejectSyntheticRoute(req, res) {
  if (!isLoopbackRequest(req)) {
    return err404HiddenRoute(res);
  }
  return null;
}

export function journeyRoutes() {
  const router = Router();

  router.use('/journey', express.static(JOURNEY_DIR, { etag: false, maxAge: 0 }));
  router.get('/journey', (_req, res) => res.sendFile(resolve(JOURNEY_DIR, 'index.html')));
  router.get('/journey/three', (_req, res) => res.sendFile(resolve(JOURNEY_DIR, 'three.html')));

  router.get('/api/journey', async (_req, res) => {
    const monitor = getJourneyMonitor();
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
    res.json(getAgentSurfaceManifest());
  });

  router.get('/api/journey/events', async (req, res) => {
    const monitor = getJourneyMonitor();
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

  router.post('/api/demo/synthetic/start', (req, res) => {
    const rejection = rejectSyntheticRoute(req, res);
    if (rejection) return rejection;
    const monitor = getJourneyMonitor();
    if (!monitor) {
      return res.status(503).json({ ok: false, error: 'journey monitor unavailable' });
    }
    return res.json(monitor.startSyntheticTraffic());
  });

  router.post('/api/demo/synthetic/stop', async (req, res) => {
    const rejection = rejectSyntheticRoute(req, res);
    if (rejection) return rejection;
    const monitor = getJourneyMonitor();
    if (!monitor) {
      return res.status(503).json({ ok: false, error: 'journey monitor unavailable' });
    }
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

  router.post('/api/analytics/query', async (req, res) => {
    const rejection = rejectUnauthorizedOperatorRoute(req, res);
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
