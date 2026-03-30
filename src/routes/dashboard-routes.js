/**
 * Dashboard Routes — /dashboard
 *
 * Read-only monitoring dashboard for platform operators.
 * Focused on agent success, endpoint health, and doc reads.
 */

import { Router } from 'express';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DOC_CATALOG,
  DOMAIN_ORDER,
  ROUTE_CATALOG,
  matchAgentFacingRoute,
  matchDocSurface,
} from '../monitor/agent-surface-inventory.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SNAPSHOT_TTL_MS = 5000;
const FEED_LIMIT = 120;

let snapshotCache = {
  builtAt: 0,
  value: null,
  pending: null,
};

function percentile(values, pct) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((pct / 100) * sorted.length) - 1));
  return sorted[idx];
}

function countBy(items, keyFn) {
  const counts = new Map();
  for (const item of items) {
    const key = keyFn(item);
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return counts;
}

function createRouteStats() {
  return new Map(ROUTE_CATALOG.map(route => [route.key, {
    ...route,
    total: 0,
    hits_24h: 0,
    status_known_24h: 0,
    success_24h: 0,
    errors_24h: 0,
    status_4xx_24h: 0,
    status_5xx_24h: 0,
    p50_ms: null,
    p95_ms: null,
    _latencies_24h: [],
  }]));
}

function createDocStats() {
  return new Map(DOC_CATALOG.map(doc => [doc.key, {
    ...doc,
    total: 0,
    hits_24h: 0,
  }]));
}

function buildRepeatedFailureStats(requests24) {
  const grouped = new Map();
  for (const event of requests24) {
    if (!event.agent_id || !Number.isInteger(event.status)) continue;
    const route = matchAgentFacingRoute(event.method, event.path);
    if (!route) continue;
    const key = `${event.agent_id} ${route.key}`;
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push({ ts: event._ts || 0, status: event.status });
  }

  let recoveryAttempts = 0;
  let recovered = 0;
  let repeatedFailurePairs = 0;

  for (const items of grouped.values()) {
    items.sort((a, b) => a.ts - b.ts);
    let saw4xx = false;
    let consecutive4xx = 0;
    let countedRepeated = false;
    let countedRecovery = false;

    for (const item of items) {
      if (item.status >= 400 && item.status < 500) {
        saw4xx = true;
        consecutive4xx += 1;
        if (consecutive4xx >= 2 && !countedRepeated) {
          countedRepeated = true;
          repeatedFailurePairs += 1;
        }
        continue;
      }

      if (item.status >= 200 && item.status < 300) {
        if (saw4xx && !countedRecovery) {
          countedRecovery = true;
          recovered += 1;
        }
      }

      consecutive4xx = 0;
    }

    if (saw4xx) recoveryAttempts += 1;
  }

  return {
    recovery_attempts_24h: recoveryAttempts,
    recovered_24h: recovered,
    recovery_rate_24h: recoveryAttempts > 0 ? recovered / recoveryAttempts : null,
    repeated_failure_pairs_24h: repeatedFailurePairs,
  };
}

async function buildDashboardSnapshot(daemon) {
  const now = Date.now();
  const hourAgo = now - 3600000;
  const dayAgo = now - 86400000;
  const minuteAgo = now - 60000;

  const [allEvents, agentProfiles, ledgerSummary] = await Promise.all([
    daemon.dataLayer.readLog('data/security-audit.jsonl', 1).catch(() => []),
    Promise.resolve(daemon.agentRegistry?.listAll() || []),
    daemon.publicLedger?.getSummary
      ? daemon.publicLedger.getSummary().catch(() => null)
      : Promise.resolve(null),
  ]);

  const requestEvents = allEvents.filter(event => (
    event.event === 'api_request'
    && typeof event.method === 'string'
    && typeof event.path === 'string'
  ));
  const requests24 = requestEvents.filter(event => (event._ts || 0) >= dayAgo);
  const requests1h = requestEvents.filter(event => (event._ts || 0) >= hourAgo);
  const requests1m = requestEvents.filter(event => (event._ts || 0) >= minuteAgo);
  const authFailures24 = allEvents.filter(event => event.event === 'auth_failure' && (event._ts || 0) >= dayAgo);
  const rateLimits24 = allEvents.filter(event => event.event === 'rate_limit_hit' && (event._ts || 0) >= dayAgo);
  const validationFailures24 = allEvents.filter(event => event.event === 'validation_failure' && (event._ts || 0) >= dayAgo);

  const routeStats = createRouteStats();
  const docStats = createDocStats();
  const overallLatencies24 = [];
  let success24 = 0;
  let clientErrors24 = 0;
  let serverErrors24 = 0;
  let knownStatuses24 = 0;

  const active1h = new Set();
  const active24h = new Set();
  const anonIps1h = new Set();
  const reqCount1hByAgent = new Map();
  const reqCount24hByAgent = new Map();
  const errorCount24hByAgent = new Map();

  for (const event of requestEvents) {
    const route = matchAgentFacingRoute(event.method, event.path);
    if (route) {
      const stats = routeStats.get(route.key);
      stats.total += 1;
      if ((event._ts || 0) >= dayAgo) {
        stats.hits_24h += 1;
        if (Number.isInteger(event.status)) {
          stats.status_known_24h += 1;
          knownStatuses24 += 1;
          if (event.status >= 200 && event.status < 300) {
            stats.success_24h += 1;
            success24 += 1;
          } else if (event.status >= 400 && event.status < 500) {
            stats.errors_24h += 1;
            stats.status_4xx_24h += 1;
            clientErrors24 += 1;
          } else if (event.status >= 500) {
            stats.errors_24h += 1;
            stats.status_5xx_24h += 1;
            serverErrors24 += 1;
          }
        }
        if (Number.isFinite(event.duration_ms)) {
          stats._latencies_24h.push(event.duration_ms);
          overallLatencies24.push(event.duration_ms);
        }
      }
    }

    const doc = matchDocSurface(event);
    if (doc) {
      const stats = docStats.get(doc.key);
      stats.total += 1;
      if ((event._ts || 0) >= dayAgo) stats.hits_24h += 1;
    }

    if ((event._ts || 0) >= hourAgo) {
      if (event.agent_id) {
        active1h.add(event.agent_id);
        reqCount1hByAgent.set(event.agent_id, (reqCount1hByAgent.get(event.agent_id) || 0) + 1);
      } else if (event.ip) {
        anonIps1h.add(event.ip);
      }
    }

    if ((event._ts || 0) >= dayAgo && event.agent_id) {
      active24h.add(event.agent_id);
      reqCount24hByAgent.set(event.agent_id, (reqCount24hByAgent.get(event.agent_id) || 0) + 1);
      if (Number.isInteger(event.status) && event.status >= 400) {
        errorCount24hByAgent.set(event.agent_id, (errorCount24hByAgent.get(event.agent_id) || 0) + 1);
      }
    }
  }

  for (const stats of routeStats.values()) {
    stats.p50_ms = percentile(stats._latencies_24h, 50);
    stats.p95_ms = percentile(stats._latencies_24h, 95);
    delete stats._latencies_24h;
    stats.error_rate_24h = stats.status_known_24h > 0 ? stats.errors_24h / stats.status_known_24h : null;
  }

  const profilesById = new Map(agentProfiles.map(profile => [profile.id, profile]));
  const mostActiveEntry = [...reqCount1hByAgent.entries()].sort((a, b) => b[1] - a[1])[0] || null;
  const mostActiveAgent = mostActiveEntry ? {
    id: mostActiveEntry[0],
    name: profilesById.get(mostActiveEntry[0])?.name || mostActiveEntry[0],
    requests_1h: mostActiveEntry[1],
  } : null;

  const repeatedFailureStats = buildRepeatedFailureStats(requests24);
  const authFailureIps = countBy(authFailures24.filter(event => event.ip), event => event.ip);
  const rateLimitByCategory = countBy(rateLimits24, event => event.category || 'unknown');

  const topFailing = [...routeStats.values()]
    .filter(route => route.hits_24h > 0 && route.errors_24h > 0)
    .sort((a, b) => {
      if (b.error_rate_24h !== a.error_rate_24h) return b.error_rate_24h - a.error_rate_24h;
      return b.errors_24h - a.errors_24h;
    })
    .slice(0, 10)
    .map(route => ({
      method: route.method,
      path: route.path,
      domain: route.domain,
      hits_24h: route.hits_24h,
      errors_24h: route.errors_24h,
      error_rate_24h: route.error_rate_24h,
      p95_ms: route.p95_ms,
    }));

  const recentFeed = [...allEvents]
    .sort((a, b) => (b._ts || 0) - (a._ts || 0))
    .slice(0, FEED_LIMIT);

  return {
    built_at: now,
    summary: {
      timestamp: now,
      inventory: {
        endpoints_total: ROUTE_CATALOG.length,
        docs_total: DOC_CATALOG.length,
      },
      agents: {
        total: agentProfiles.length,
        active_1h: active1h.size,
        active_24h: active24h.size,
        new_24h: agentProfiles.filter(profile => (profile.registered_at || 0) >= dayAgo).length,
        anonymous_1h: anonIps1h.size,
        idle_24h: agentProfiles.filter(profile => !active24h.has(profile.id)).length,
        most_active: mostActiveAgent,
      },
      traffic: {
        total_24h: requests24.length,
        requests_per_min: requests1m.length,
        success_rate_24h: knownStatuses24 > 0 ? success24 / knownStatuses24 : null,
        p50_ms: percentile(overallLatencies24, 50),
        p95_ms: percentile(overallLatencies24, 95),
        status_4xx_24h: clientErrors24,
        status_5xx_24h: serverErrors24,
      },
      errors: {
        auth_failures_24h: authFailures24.length,
        validation_failures_24h: validationFailures24.length,
        repeated_failure_pairs_24h: repeatedFailureStats.repeated_failure_pairs_24h,
        recovery_attempts_24h: repeatedFailureStats.recovery_attempts_24h,
        recovered_24h: repeatedFailureStats.recovered_24h,
        recovery_rate_24h: repeatedFailureStats.recovery_rate_24h,
        top_failing: topFailing,
        top_auth_failure_ips: [...authFailureIps.entries()]
          .sort((a, b) => b[1] - a[1])
          .slice(0, 5)
          .map(([ip, count]) => ({ ip, count })),
        rate_limit_categories_24h: [...rateLimitByCategory.entries()]
          .sort((a, b) => b[1] - a[1])
          .map(([category, count]) => ({ category, count })),
      },
      platform: {
        nodes: daemon.nodeManager?.getNodeNames()?.length || 0,
        total_transactions: ledgerSummary?.total_transactions || 0,
      },
    },
    endpoints: [...routeStats.values()].map(route => ({
      method: route.method,
      path: route.path,
      domain: route.domain,
      total: route.total,
      hits_24h: route.hits_24h,
      status_known_24h: route.status_known_24h,
      success_24h: route.success_24h,
      errors_24h: route.errors_24h,
      status_4xx_24h: route.status_4xx_24h,
      status_5xx_24h: route.status_5xx_24h,
      error_rate_24h: route.error_rate_24h,
      p50_ms: route.p50_ms,
      p95_ms: route.p95_ms,
    })),
    docs: [...docStats.values()].map(doc => ({
      method: doc.method,
      path: doc.path,
      label: doc.label,
      type: doc.type,
      total: doc.total,
      hits_24h: doc.hits_24h,
    })),
    activity: recentFeed,
    agentActivity: {
      reqs_1h_by_agent: reqCount1hByAgent,
      reqs_24h_by_agent: reqCount24hByAgent,
      errors_24h_by_agent: errorCount24hByAgent,
      active_1h: active1h,
      active_24h: active24h,
      profiles_by_id: profilesById,
    },
  };
}

async function getDashboardSnapshot(daemon, { force = false } = {}) {
  const now = Date.now();
  if (!force && snapshotCache.value && (now - snapshotCache.builtAt) < SNAPSHOT_TTL_MS) {
    return snapshotCache.value;
  }
  if (snapshotCache.pending) return snapshotCache.pending;

  snapshotCache.pending = buildDashboardSnapshot(daemon)
    .then(snapshot => {
      snapshotCache.value = snapshot;
      snapshotCache.builtAt = Date.now();
      return snapshot;
    })
    .finally(() => {
      snapshotCache.pending = null;
    });

  return snapshotCache.pending;
}

export function dashboardRoutes(daemon) {
  const router = Router();

  router.get('/dashboard', (_req, res) => {
    res.sendFile(resolve(__dirname, '..', '..', 'agents', 'monitor', 'public', 'index.html'));
  });

  router.get('/dashboard/api/summary', async (_req, res) => {
    try {
      const snapshot = await getDashboardSnapshot(daemon);
      res.json(snapshot.summary);
    } catch (err) {
      res.status(500).json({ error: 'Failed to load summary', detail: err.message });
    }
  });

  router.get('/dashboard/api/endpoints', async (_req, res) => {
    try {
      const snapshot = await getDashboardSnapshot(daemon);
      const domains = DOMAIN_ORDER.map(name => ({
        name,
        count: snapshot.endpoints.filter(endpoint => endpoint.domain === name).length,
      }));
      res.json({
        endpoints: snapshot.endpoints,
        domains,
        total_requests_24h: snapshot.summary.traffic.total_24h,
        inventory_total: snapshot.summary.inventory.endpoints_total,
      });
    } catch (err) {
      res.status(500).json({ error: 'Failed to load endpoint stats', detail: err.message });
    }
  });

  router.get('/dashboard/api/docs', async (_req, res) => {
    try {
      const snapshot = await getDashboardSnapshot(daemon);
      res.json({
        docs: snapshot.docs,
        total_reads_24h: snapshot.docs.reduce((sum, doc) => sum + doc.hits_24h, 0),
        inventory_total: snapshot.summary.inventory.docs_total,
      });
    } catch (err) {
      res.status(500).json({ error: 'Failed to load doc stats', detail: err.message });
    }
  });

  router.get('/dashboard/api/agents', async (_req, res) => {
    try {
      const snapshot = await getDashboardSnapshot(daemon);
      const agents = daemon.agentRegistry?.listAll() || [];
      const profiles = await Promise.all(
        agents.slice(0, 200).map(agent => daemon.agentRegistry.getFullProfile(agent.id).catch(() => null))
      );

      const result = profiles.filter(Boolean).map(profile => ({
        id: profile.id,
        name: profile.name,
        tier: profile.state?.tier || profile.tier || 'observatory',
        wallet_balance_sats: profile.state?.wallet_balance_sats || 0,
        strategy: profile.state?.strategy || null,
        registered_at: profile.registered_at,
        last_active_at: profile.state?.last_active_at || profile.registered_at,
        requests_24h: snapshot.agentActivity.reqs_24h_by_agent.get(profile.id) || 0,
        requests_1h: snapshot.agentActivity.reqs_1h_by_agent.get(profile.id) || 0,
        errors_24h: snapshot.agentActivity.errors_24h_by_agent.get(profile.id) || 0,
        active_24h: snapshot.agentActivity.active_24h.has(profile.id),
        active_1h: snapshot.agentActivity.active_1h.has(profile.id),
      }));

      result.sort((a, b) => {
        if (b.requests_24h !== a.requests_24h) return b.requests_24h - a.requests_24h;
        return (b.registered_at || 0) - (a.registered_at || 0);
      });

      res.json({ agents: result, count: result.length });
    } catch (err) {
      res.status(500).json({ error: 'Failed to load agents', detail: err.message });
    }
  });

  router.get('/dashboard/api/activity', async (req, res) => {
    try {
      const snapshot = await getDashboardSnapshot(daemon);
      const since = req.query.since ? Number(req.query.since) : null;
      const limit = Math.min(Number(req.query.limit) || 80, FEED_LIMIT);
      let events = snapshot.activity;
      if (since) events = events.filter(event => (event._ts || 0) >= since);
      res.json({ events: events.slice(0, limit), count: events.length, since });
    } catch (err) {
      res.status(500).json({ error: 'Failed to load activity', detail: err.message });
    }
  });

  router.get('/dashboard/api/leaderboard', (_req, res) => {
    try {
      const data = daemon.externalLeaderboard?.getData();
      res.json(data || { entries: [], updatedAt: null, metric: '', agentCount: 0 });
    } catch (err) {
      res.status(500).json({ error: 'Failed to load leaderboard', detail: err.message });
    }
  });

  router.get('/dashboard/api/transactions', async (req, res) => {
    try {
      const limit = Math.min(Number(req.query.limit) || 100, 500);
      const type = req.query.type || undefined;
      const data = await daemon.publicLedger?.getAll({ limit, type });
      res.json(data || { entries: [], total: 0 });
    } catch (err) {
      res.status(500).json({ error: 'Failed to load transactions', detail: err.message });
    }
  });

  return router;
}
