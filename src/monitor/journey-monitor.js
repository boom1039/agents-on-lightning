import { existsSync, statSync } from 'node:fs';
import { AnalyticsDB } from '../../monitoring_dashboards/live/analytics-db.mjs';
import { LiveJourneyState } from '../../monitoring_dashboards/live/state.mjs';
import { createSyntheticJourneySprayController } from '../../monitoring_dashboards/live/synthetic-spray.mjs';
import {
  getAgentSurfaceSummary,
  getCanonicalJourneyRouteCatalog,
  shouldIgnoreAgentSurfacePath,
} from './agent-surface-inventory.js';

const LIVE_STATE_EVENT_TYPES = new Set([
  'registration_attempt',
  'agent_bound',
  'request_start',
  'request_finish',
]);

class JourneyMonitor {
  constructor(options = {}) {
    this.analyticsDb = new AnalyticsDB(options.dbPath);
    this.journeyState = new LiveJourneyState();
    this.daemon = options.daemon || null;
    this.clients = new Set();
    this.totalEvents = 0;
    this.agentIds = new Set();
    this.historicalAgentCount = 0;
    this.hydratedAt = 0;
    this.ready = false;
    this.syntheticController = null;
    this.syntheticTimer = null;
    this.fundingCache = new Map();
    this.fundingTtlMs = Number.isFinite(options.fundingTtlMs) ? options.fundingTtlMs : 15_000;
  }

  setDaemon(daemon) {
    this.daemon = daemon || null;
  }

  async open() {
    await this.analyticsDb.open();
    await this._hydrateFromDb();
    this.ready = true;
    return this;
  }

  async close() {
    this._stopSyntheticTimer();
    for (const res of this.clients) {
      try {
        res.end();
      } catch {}
    }
    this.clients.clear();
    await this.analyticsDb.flush();
    await this.analyticsDb.close();
    this.ready = false;
  }

  async _hydrateFromDb() {
    this.totalEvents = 0;
    this.agentIds.clear();
    this.historicalAgentCount = 0;
    this.journeyState.reset();

    const events = await this.analyticsDb.listEvents({
      eventTypes: [...LIVE_STATE_EVENT_TYPES],
      order: 'ASC',
    });

    for (const event of events) {
      if (shouldIgnoreAgentSurfacePath(`${event?.path || ''}`)) continue;
      this._trackHistorical(event);
      this.journeyState.applyEvent(event);
    }

    const summary = await this.analyticsDb.summary().catch(() => null);
    if (summary) {
      this.totalEvents = Number(summary.total_events || 0);
      this.historicalAgentCount = Number(summary.unique_agents || 0);
    } else {
      this.historicalAgentCount = this.agentIds.size;
    }
    this.hydratedAt = Date.now();
  }

  _trackHistorical(event) {
    this.totalEvents += 1;
    if (event?.agent_id) {
      this.agentIds.add(event.agent_id);
      this.historicalAgentCount = Math.max(this.historicalAgentCount, this.agentIds.size);
    }
  }

  getStatus() {
    let sizeBytes = 0;
    try {
      if (existsSync(this.analyticsDb.dbPath)) sizeBytes = statSync(this.analyticsDb.dbPath).size;
    } catch {}
    return {
      backend: 'duckdb',
      path: this.analyticsDb.dbPath,
      lastSizeBytes: sizeBytes,
      sizeBytes,
      totalEvents: this.totalEvents,
      uniqueAgents: this.historicalAgentCount,
      hydratedAt: this.hydratedAt,
      level: 'ok',
    };
  }

  _emptyFunding() {
    return {
      walletBalanceSats: 0,
      walletEcashSats: 0,
      walletHubSats: 0,
      capitalAvailableSats: 0,
      pendingDepositSats: 0,
      lockedSats: 0,
      pendingCloseSats: 0,
      totalTrackedSats: 0,
      fundingState: 'empty',
      fundingLabel: 'Empty',
      depositStatus: null,
      pendingDepositConfirmations: 0,
      pendingDepositConfirmationsRequired: 0,
      pendingDepositTxid: null,
      pendingDepositAddress: null,
      fundingUpdatedAt: Date.now(),
    };
  }

  _deriveFunding(payload = {}) {
    const walletEcashSats = Math.max(0, Number(payload.walletEcashSats || 0));
    const walletHubSats = Math.max(0, Number(payload.walletHubSats || 0));
    const walletBalanceSats = walletEcashSats + walletHubSats;
    const capitalAvailableSats = Math.max(0, Number(payload.capitalAvailableSats || 0));
    const pendingDepositSats = Math.max(0, Number(payload.pendingDepositSats || 0));
    const lockedSats = Math.max(0, Number(payload.lockedSats || 0));
    const pendingCloseSats = Math.max(0, Number(payload.pendingCloseSats || 0));
    const pendingDepositConfirmations = Math.max(0, Number(payload.pendingDepositConfirmations || 0));
    const pendingDepositConfirmationsRequired = Math.max(0, Number(payload.pendingDepositConfirmationsRequired || 0));
    const totalTrackedSats =
      walletBalanceSats + capitalAvailableSats + pendingDepositSats + lockedSats + pendingCloseSats;

    let fundingState = 'empty';
    let fundingLabel = 'Empty';
    if (pendingDepositSats > 0) {
      fundingState = 'pending';
      const confText = pendingDepositConfirmationsRequired > 0
        ? ` (${pendingDepositConfirmations}/${pendingDepositConfirmationsRequired} conf)`
        : '';
      fundingLabel = `Pending ${pendingDepositSats.toLocaleString()} sats${confText}`;
    } else if (lockedSats > 0 || pendingCloseSats > 0) {
      fundingState = 'locked';
      fundingLabel = `Locked ${Math.max(lockedSats, pendingCloseSats).toLocaleString()} sats`;
    } else if (capitalAvailableSats > 0 || walletBalanceSats > 0) {
      fundingState = 'funded';
      fundingLabel = `Funded ${Math.max(capitalAvailableSats + walletBalanceSats, 0).toLocaleString()} sats`;
    }

    return {
      walletBalanceSats,
      walletEcashSats,
      walletHubSats,
      capitalAvailableSats,
      pendingDepositSats,
      lockedSats,
      pendingCloseSats,
      totalTrackedSats,
      fundingState,
      fundingLabel,
      depositStatus: payload.depositStatus || null,
      pendingDepositConfirmations,
      pendingDepositConfirmationsRequired,
      pendingDepositTxid: payload.pendingDepositTxid || null,
      pendingDepositAddress: payload.pendingDepositAddress || null,
      fundingUpdatedAt: Date.now(),
    };
  }

  async _loadFunding(agentId, { force = false } = {}) {
    if (!agentId) return this._emptyFunding();
    const cached = this.fundingCache.get(agentId);
    const now = Date.now();
    if (!force && cached && (now - cached.fundingUpdatedAt) <= this.fundingTtlMs) {
      return { ...cached };
    }

    if (!this.daemon) {
      if (cached) return { ...cached };
      const empty = this._emptyFunding();
      this.fundingCache.set(agentId, empty);
      return { ...empty };
    }

    const walletEcashPromise = this.daemon.agentCashuWallet?.getBalance
      ? this.daemon.agentCashuWallet.getBalance(agentId).catch(() => 0)
      : Promise.resolve(0);
    const walletHubPromise = this.daemon.hubWallet?.getBalance
      ? this.daemon.hubWallet.getBalance(agentId).catch(() => 0)
      : Promise.resolve(0);
    const capitalPromise = this.daemon.capitalLedger?.getBalance
      ? this.daemon.capitalLedger.getBalance(agentId).catch(() => null)
      : Promise.resolve(null);

    const depositPromise = this.daemon.depositTracker?.getDepositStatus
      ? Promise.resolve(this.daemon.depositTracker.getDepositStatus(agentId)).catch(() => ({ deposits: [] }))
      : Promise.resolve({ deposits: [] });

    const [walletEcashSats, walletHubSats, capital, depositStatus] = await Promise.all([
      walletEcashPromise,
      walletHubPromise,
      capitalPromise,
      depositPromise,
    ]);

    const pendingDeposit = Array.isArray(depositStatus?.deposits)
      ? [...depositStatus.deposits]
        .filter((entry) => entry?.status === 'pending_deposit')
        .sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')))[0]
      : null;

    const next = this._deriveFunding({
      walletEcashSats,
      walletHubSats,
      capitalAvailableSats: capital?.available || 0,
      pendingDepositSats: capital?.pending_deposit || 0,
      lockedSats: capital?.locked || 0,
      pendingCloseSats: capital?.pending_close || 0,
      depositStatus: pendingDeposit?.status || null,
      pendingDepositConfirmations: pendingDeposit?.confirmations || 0,
      pendingDepositConfirmationsRequired: pendingDeposit?.confirmations_required || 0,
      pendingDepositTxid: pendingDeposit?.txid || null,
      pendingDepositAddress: pendingDeposit?.address || null,
    });
    this.fundingCache.set(agentId, next);
    return { ...next };
  }

  async _enrichAgent(agent) {
    if (!agent?.id) return agent;
    const funding = await this._loadFunding(agent.id);
    return { ...agent, ...funding };
  }

  async buildSnapshot() {
    const catalog = getAgentSurfaceSummary();
    const rawSnapshot = this.journeyState.buildSnapshot({
      log: this.getStatus(),
    });
    const agents = await Promise.all((rawSnapshot.agents || []).map((agent) => this._enrichAgent(agent)));
    const canonicalRoutes = getCanonicalJourneyRouteCatalog();
    const liveRouteByKey = new Map((rawSnapshot.routes || []).map((route) => [route.routeKey, route]));
    const routes = canonicalRoutes.map((route) => {
      const live = liveRouteByKey.get(route.key) || {};
      return {
        routeKey: route.key,
        routeLabel: route.endpoint || route.label || route.path,
        routePath: route.path,
        method: route.method,
        domain: route.domain,
        group: route.group,
        surfaceType: 'api',
        canonical: true,
        summary: route.summary || null,
        auth: route.auth || null,
        sourceFile: route.source_file || null,
        sourceLine: Number.isInteger(route.source_line) ? route.source_line : null,
        tags: Array.isArray(route.tags) ? route.tags.slice() : [],
        order: Number.isInteger(route.order) ? route.order : null,
        docIds: Array.isArray(route.doc_ids) ? route.doc_ids.slice() : [],
        linkedRouteKeys: [],
        linkedDocIds: Array.isArray(route.doc_ids) ? route.doc_ids.slice() : [],
        activeAgents: Number(live.activeAgents || 0),
        inFlight: Number(live.inFlight || 0),
        finished: Number(live.finished || 0),
        status2xx: Number(live.status2xx || 0),
        status4xx: Number(live.status4xx || 0),
        status5xx: Number(live.status5xx || 0),
        lastEventTime: Number(live.lastEventTime || 0),
      };
    });
    const domains = new Map();
    for (const route of routes) {
      const existing = domains.get(route.domain) || {
        id: route.domain,
        routes: 0,
        activeAgents: 0,
        inFlight: 0,
      };
      existing.routes += 1;
      existing.activeAgents += Number(route.activeAgents || 0);
      existing.inFlight += Number(route.inFlight || 0);
      domains.set(route.domain, existing);
    }

    const snapshot = {
      ...rawSnapshot,
      agents,
      routes,
      domains: [...domains.values()],
    };
    snapshot.catalog = catalog;
    snapshot.stats = {
      ...snapshot.stats,
      routes: catalog.endpoint_routes_canonical,
      endpoints: catalog.endpoint_routes_canonical,
      docs: catalog.doc_nodes_total,
      docSurfaces: catalog.doc_surfaces_total,
      internalRoutes: catalog.internal_routes_canonical,
      surfaces: routes.length,
    };
    snapshot.history = {
      totalEvents: this.totalEvents,
      uniqueAgents: this.historicalAgentCount,
      hydratedAt: this.hydratedAt,
    };
    return snapshot;
  }

  addClient(res) {
    this.clients.add(res);
  }

  removeClient(res) {
    this.clients.delete(res);
  }

  _broadcast(event) {
    const data = JSON.stringify(event);
    for (const res of this.clients) {
      try {
        res.write(`data: ${data}\n\n`);
      } catch {
        this.clients.delete(res);
      }
    }
  }

  async broadcastSnapshot() {
    this._broadcast({
      type: 'snapshot',
      snapshot: await this.buildSnapshot(),
    });
  }

  _ingestLiveBatch(events) {
    const applied = this.journeyState.ingestBatch(events);
    for (const event of applied) this._broadcast(event);
    return applied;
  }

  _stopSyntheticTimer() {
    if (this.syntheticTimer) clearInterval(this.syntheticTimer);
    this.syntheticTimer = null;
  }

  getSyntheticStatus() {
    if (!this.syntheticController) {
      return {
        ok: true,
        running: false,
        agentsCreated: 0,
        activeAgents: 0,
        inflight: 0,
        eventsEmitted: 0,
        tickMs: 0,
      };
    }
    return {
      ok: true,
      ...this.syntheticController.snapshot(),
    };
  }

  startSyntheticTraffic() {
    if (this.syntheticController) return this.getSyntheticStatus();
    this.syntheticController = createSyntheticJourneySprayController();
    const tick = () => {
      if (!this.syntheticController) return;
      const events = this.syntheticController.drain(Date.now());
      if (events.length > 0) this._ingestLiveBatch(events);
    };
    tick();
    this.syntheticTimer = setInterval(tick, this.syntheticController.tickMs);
    this.syntheticTimer.unref?.();
    return this.getSyntheticStatus();
  }

  async stopSyntheticTraffic() {
    if (!this.syntheticController) return this.getSyntheticStatus();
    this._stopSyntheticTimer();
    this.syntheticController = null;
    await this.analyticsDb.flush();
    await this._hydrateFromDb();
    await this.broadcastSnapshot();
    return this.getSyntheticStatus();
  }

  async record(event) {
    if (shouldIgnoreAgentSurfacePath(`${event?.path || ''}`)) return null;
    const storedEvent = {
      ...event,
      ts: Number.isFinite(event?.ts) ? event.ts : Number.isFinite(event?._ts) ? event._ts : Date.now(),
    };
    if (!Number.isFinite(storedEvent._ts)) storedEvent._ts = storedEvent.ts;

    this._trackHistorical(storedEvent);
    this.analyticsDb.ingest(storedEvent);

    if (!LIVE_STATE_EVENT_TYPES.has(storedEvent.event)) return null;
    const applied = this.journeyState.applyEvent(storedEvent);
    if (applied?.agent) {
      applied.agent = await this._enrichAgent(applied.agent);
    }
    if (applied) this._broadcast(applied);
    return applied;
  }

  async listEvents(options = {}) {
    return this.analyticsDb.listEvents(options);
  }

  async summary() {
    return this.analyticsDb.summary();
  }

  async eventsByInterval(options = {}) {
    return this.analyticsDb.eventsByInterval(options);
  }

  async topRoutes(options = {}) {
    return this.analyticsDb.topRoutes(options);
  }

  async agentActivity(options = {}) {
    return this.analyticsDb.agentActivity(options);
  }

  async domainBreakdown(options = {}) {
    return this.analyticsDb.domainBreakdown(options);
  }

  async errorBreakdown(options = {}) {
    return this.analyticsDb.errorBreakdown(options);
  }

  async agentJourney(agentId) {
    return this.analyticsDb.agentJourney(agentId);
  }

  async query(sql, params = []) {
    return this.analyticsDb.query(sql, params);
  }
}

let singleton = null;
let openPromise = null;

export async function startJourneyMonitor(options = {}) {
  if (singleton?.ready) return singleton;
  if (!singleton) singleton = new JourneyMonitor(options);
  if (!openPromise) {
    openPromise = singleton.open()
      .finally(() => {
        openPromise = null;
      });
  }
  await openPromise;
  return singleton;
}

export async function stopJourneyMonitor() {
  if (!singleton) return;
  await singleton.close();
  singleton = null;
  openPromise = null;
}

export function getJourneyMonitor() {
  return singleton;
}

export function getJourneyMonitorStatus() {
  return singleton?.getStatus() || {
    backend: 'duckdb',
    path: null,
    lastSizeBytes: 0,
    sizeBytes: 0,
    totalEvents: 0,
    uniqueAgents: 0,
    hydratedAt: 0,
    level: 'offline',
  };
}

export async function recordJourneyEvent(event) {
  if (!singleton) return null;
  return singleton.record(event);
}

export async function listStoredJourneyEvents(options = {}) {
  if (!singleton) return [];
  return singleton.listEvents(options);
}
