import { JOURNEY_DOMAIN_ORDER, describeJourneySurface, listKnownJourneySurfaces } from './route-surface.mjs';

const DEFAULT_AGENT_TTL_MS = 12 * 60 * 60 * 1000;
const DEFAULT_INFLIGHT_TTL_MS = 15 * 60 * 1000;
const DEFAULT_IDLE_MS = 60 * 1000;
const DEFAULT_RECENT_ROUTE_MS = 6 * 60 * 60 * 1000;
const DEFAULT_MAX_AGENTS = 20_000;
const DEFAULT_MAX_RECENT_EVENTS = 2_000;
const DEFAULT_MAX_RECENT_PER_AGENT = 8;
const DEFAULT_MAX_DWELL_HISTORY = 6;

function boundedPush(list, item, max) {
  list.push(item);
  if (list.length > max) list.shift();
}

function domainRank(domain) {
  const idx = JOURNEY_DOMAIN_ORDER.indexOf(domain);
  return idx >= 0 ? idx : JOURNEY_DOMAIN_ORDER.length;
}

function toTimestamp(value, fallback = Date.now()) {
  return Number.isFinite(value) ? value : fallback;
}

function compactStatusBucket(status) {
  if (status >= 500) return '5xx';
  if (status >= 400) return '4xx';
  if (status >= 200) return '2xx';
  return 'other';
}

function extractTimingFields(event = {}) {
  return {
    requestTimelineIndex: Number.isInteger(event.request_timeline_index) ? event.request_timeline_index : null,
    startedAtMs: Number.isFinite(event.started_at_ms) ? event.started_at_ms : null,
    finishedAtMs: Number.isFinite(event.finished_at_ms) ? event.finished_at_ms : null,
    latencyMs: Number.isFinite(event.latency_ms) ? event.latency_ms : null,
    gapFromPrevRequestMs: Number.isFinite(event.gap_from_prev_request_ms) ? event.gap_from_prev_request_ms : null,
    gapFromPrevTurnMs: Number.isFinite(event.gap_from_prev_turn_ms) ? event.gap_from_prev_turn_ms : null,
    turnStartedAtMs: Number.isFinite(event.turn_started_at_ms) ? event.turn_started_at_ms : null,
    turnFinishedAtMs: Number.isFinite(event.turn_finished_at_ms) ? event.turn_finished_at_ms : null,
  };
}

function cloneList(values) {
  return Array.isArray(values) ? values.slice() : [];
}

function surfaceEventFields(surface) {
  return {
    routeKey: surface.routeKey,
    routePath: surface.routePath,
    routeLabel: surface.routeLabel,
    rawPath: surface.rawPath,
    method: surface.method,
    domain: surface.domain,
    group: surface.group,
    surfaceType: surface.surfaceType,
    canonical: surface.canonical,
    summary: surface.summary || null,
    auth: surface.auth || null,
    sourceFile: surface.sourceFile || null,
    sourceLine: Number.isInteger(surface.sourceLine) ? surface.sourceLine : null,
    tags: cloneList(surface.tags),
    docId: surface.docId || null,
    docTitle: surface.docTitle || null,
    docKind: surface.docKind || null,
    docIds: cloneList(surface.docIds),
    linkedRouteKeys: cloneList(surface.linkedRouteKeys),
    linkedDocIds: cloneList(surface.linkedDocIds),
  };
}

function applySurfaceMeta(target, surface) {
  target.routeKey = surface.routeKey;
  target.routePath = surface.routePath;
  target.routeLabel = surface.routeLabel;
  target.rawPath = surface.rawPath || surface.routePath;
  target.method = surface.method;
  target.domain = surface.domain;
  target.group = surface.group;
  target.surfaceType = surface.surfaceType;
  target.canonical = surface.canonical;
  target.summary = surface.summary || null;
  target.auth = surface.auth || null;
  target.sourceFile = surface.sourceFile || null;
  target.sourceLine = Number.isInteger(surface.sourceLine) ? surface.sourceLine : null;
  target.tags = cloneList(surface.tags);
  target.docId = surface.docId || null;
  target.docTitle = surface.docTitle || null;
  target.docKind = surface.docKind || null;
  target.docIds = cloneList(surface.docIds);
  target.linkedRouteKeys = cloneList(surface.linkedRouteKeys);
  target.linkedDocIds = cloneList(surface.linkedDocIds);
}

export class LiveJourneyState {
  constructor(options = {}) {
    this.agentTtlMs = options.agentTtlMs || DEFAULT_AGENT_TTL_MS;
    this.inflightTtlMs = options.inflightTtlMs || DEFAULT_INFLIGHT_TTL_MS;
    this.idleMs = options.idleMs || DEFAULT_IDLE_MS;
    this.recentRouteMs = options.recentRouteMs || DEFAULT_RECENT_ROUTE_MS;
    this.maxAgents = options.maxAgents || DEFAULT_MAX_AGENTS;
    this.maxRecentEvents = options.maxRecentEvents || DEFAULT_MAX_RECENT_EVENTS;
    this.maxRecentPerAgent = options.maxRecentPerAgent || DEFAULT_MAX_RECENT_PER_AGENT;
    this.maxDwellHistory = options.maxDwellHistory || DEFAULT_MAX_DWELL_HISTORY;
    this.seedKnownRoutes = options.seedKnownRoutes !== false;

    this.agents = new Map();
    this.inflight = new Map();
    this.routes = new Map();
    this.recentEvents = [];
    this.eventsSeen = 0;
    this.droppedAgents = 0;

    if (this.seedKnownRoutes) {
      for (const surface of listKnownJourneySurfaces()) this._ensureRoute(surface);
    }
  }

  reset() {
    this.agents.clear();
    this.inflight.clear();
    this.routes.clear();
    this.recentEvents = [];
    this.eventsSeen = 0;
    this.droppedAgents = 0;
    if (this.seedKnownRoutes) {
      for (const surface of listKnownJourneySurfaces()) this._ensureRoute(surface);
    }
  }

  _recordRecent(event) {
    boundedPush(this.recentEvents, event, this.maxRecentEvents);
  }

  _ensureRoute(surface) {
    let route = this.routes.get(surface.routeKey);
    if (!route) {
      route = {
        activeAgents: 0,
        inFlight: 0,
        finished: 0,
        status2xx: 0,
        status4xx: 0,
        status5xx: 0,
        lastEventTime: 0,
      };
      applySurfaceMeta(route, surface);
      this.routes.set(surface.routeKey, route);
    } else {
      applySurfaceMeta(route, surface);
    }
    return route;
  }

  _dropAgent(agentId, agent) {
    if (agent?.routeKey) {
      const route = this.routes.get(agent.routeKey);
      if (route) route.activeAgents = Math.max(0, route.activeAgents - 1);
    }
    this.agents.delete(agentId);
    this.droppedAgents += 1;
  }

  _touchAgent(agentId, agent) {
    if (this.agents.has(agentId)) this.agents.delete(agentId);
    this.agents.set(agentId, agent);
    while (this.agents.size > this.maxAgents) {
      const oldest = this.agents.entries().next().value;
      if (!oldest) break;
      const [oldestId, oldestAgent] = oldest;
      this._dropAgent(oldestId, oldestAgent);
    }
  }

  _serializeAgent(agent, now = Date.now()) {
    return {
      id: agent.id,
      routeKey: agent.routeKey,
      routePath: agent.routePath,
      rawPath: agent.rawPath,
      routeLabel: agent.routeLabel,
      method: agent.method,
      domain: agent.domain,
      group: agent.group,
      surfaceType: agent.surfaceType,
      canonical: agent.canonical,
      summary: agent.summary || null,
      auth: agent.auth || null,
      sourceFile: agent.sourceFile || null,
      sourceLine: Number.isInteger(agent.sourceLine) ? agent.sourceLine : null,
      tags: cloneList(agent.tags),
      docId: agent.docId || null,
      docTitle: agent.docTitle || null,
      docKind: agent.docKind || null,
      docIds: cloneList(agent.docIds),
      linkedRouteKeys: cloneList(agent.linkedRouteKeys),
      linkedDocIds: cloneList(agent.linkedDocIds),
      phase: agent.phase,
      status: agent.status,
      statusBucket: compactStatusBucket(agent.status || 0),
      lastEventTime: agent.lastEventTime,
      startedAt: agent.startedAt,
      registeredAt: agent.registeredAt,
      sessionStartedAt: agent.sessionStartedAt,
      routeEnteredAt: agent.routeEnteredAt,
      traceId: agent.traceId,
      requestCount: agent.requestCount,
      resultCount: agent.resultCount,
      timing: agent.timing ? { ...agent.timing } : null,
      sessionAgeMs: Number.isFinite(agent.sessionStartedAt) ? Math.max(0, now - agent.sessionStartedAt) : null,
      currentRouteMs: Number.isFinite(agent.routeEnteredAt) ? Math.max(0, now - agent.routeEnteredAt) : null,
      currentRequestMs: agent.phase === 'in-flight' && Number.isFinite(agent.startedAt)
        ? Math.max(0, now - agent.startedAt)
        : null,
      idle: (now - agent.lastEventTime) > this.idleMs,
      recent: agent.recent.slice(),
      dwellHistory: agent.dwellHistory.slice(),
    };
  }

  _moveAgent(agentId, surface, {
    ts,
    phase,
    status = null,
    traceId = null,
    startedAt = null,
    timing = null,
  } = {}) {
    const route = this._ensureRoute(surface);
    let agent = this.agents.get(agentId);
    if (!agent) {
      agent = {
        id: agentId,
        routeKey: null,
        routePath: null,
        rawPath: null,
        routeLabel: null,
        method: null,
        domain: null,
        group: null,
        surfaceType: null,
        canonical: false,
        summary: null,
        auth: null,
        sourceFile: null,
        sourceLine: null,
        tags: [],
        docId: null,
        docTitle: null,
        docKind: null,
        docIds: [],
        linkedRouteKeys: [],
        linkedDocIds: [],
        phase: 'idle',
        status: null,
        lastEventTime: 0,
        startedAt: null,
        registeredAt: null,
        sessionStartedAt: startedAt || ts,
        routeEnteredAt: null,
        traceId: null,
        requestCount: 0,
        resultCount: 0,
        timing: null,
        recent: [],
        dwellHistory: [],
      };
    }

    if (agent.routeKey !== surface.routeKey) {
      if (agent.routeKey) {
        const prevRoute = this.routes.get(agent.routeKey);
        if (prevRoute) prevRoute.activeAgents = Math.max(0, prevRoute.activeAgents - 1);
        if (Number.isFinite(agent.routeEnteredAt)) {
          boundedPush(agent.dwellHistory, {
            routeKey: agent.routeKey,
            routePath: agent.routePath,
            enteredAt: agent.routeEnteredAt,
            leftAt: ts,
            dwellMs: Math.max(0, ts - agent.routeEnteredAt),
            status: agent.status,
          }, this.maxDwellHistory);
        }
      }
      route.activeAgents += 1;
      agent.routeEnteredAt = ts;
    } else if (!Number.isFinite(agent.routeEnteredAt)) {
      agent.routeEnteredAt = startedAt || ts;
    }

    applySurfaceMeta(agent, surface);
    agent.phase = phase || agent.phase;
    agent.status = status;
    agent.lastEventTime = ts;
    agent.startedAt = startedAt || agent.startedAt;
    agent.sessionStartedAt = Number.isFinite(agent.sessionStartedAt)
      ? Math.min(agent.sessionStartedAt, startedAt || ts)
      : (startedAt || ts);
    agent.traceId = traceId;
    agent.timing = timing ? { ...timing } : agent.timing;

    if (phase === 'finished' || phase === 'registered') {
      agent.requestCount += 1;
      agent.resultCount += 1;
      boundedPush(agent.recent, {
        routeKey: surface.routeKey,
        routePath: surface.routePath,
        status,
        ts,
      }, this.maxRecentPerAgent);
    }

    this._touchAgent(agentId, agent);
    return this._serializeAgent(agent, ts);
  }

  evictStale(now = Date.now()) {
    for (const [traceId, inflight] of this.inflight) {
      if ((now - inflight.startedAt) <= this.inflightTtlMs) continue;
      const route = this.routes.get(inflight.surface.routeKey);
      if (route) route.inFlight = Math.max(0, route.inFlight - 1);
      this.inflight.delete(traceId);
    }

    for (const [agentId, agent] of this.agents) {
      if ((now - agent.lastEventTime) <= this.agentTtlMs) continue;
      this._dropAgent(agentId, agent);
    }
  }

  applyEvent(rawEvent) {
    const event = rawEvent || {};
    const ts = toTimestamp(event.ts, toTimestamp(event._ts, Date.now()));
    const timing = extractTimingFields(event);
    this.eventsSeen += 1;

    if (event.event === 'registration_attempt') {
      if (!event.success || !event.agent_id) return null;
      const surface = describeJourneySurface({
        method: 'POST',
        path: '/api/v1/agents/register',
      });
      const route = this._ensureRoute(surface);
      route.lastEventTime = ts;
      route.finished += 1;
      route.status2xx += 1;
      this._moveAgent(event.agent_id, surface, {
        ts,
        phase: 'registered',
        status: 201,
        timing,
      });
      const storedAgent = this.agents.get(event.agent_id);
      if (storedAgent) {
        storedAgent.registeredAt = Number.isFinite(storedAgent.registeredAt)
          ? Math.min(storedAgent.registeredAt, ts)
          : ts;
        storedAgent.sessionStartedAt = Number.isFinite(storedAgent.sessionStartedAt)
          ? Math.min(storedAgent.sessionStartedAt, ts)
          : ts;
      }
      const agent = storedAgent ? this._serializeAgent(storedAgent, ts) : null;
      const normalized = {
        event: 'registration_attempt',
        ts,
        agent_id: event.agent_id,
        ...surfaceEventFields(surface),
        success: true,
        timing,
        agent,
      };
      this._recordRecent(normalized);
      return normalized;
    }

    if (event.event === 'agent_bound') {
      if (!event.trace_id || !event.agent_id) return null;
      const inflight = this.inflight.get(event.trace_id);
      if (!inflight) {
        return {
          event: 'agent_bound',
          ts,
          trace_id: event.trace_id,
          agent_id: event.agent_id,
        };
      }
      inflight.agentId = event.agent_id;
      const agent = this._moveAgent(event.agent_id, inflight.surface, {
        ts,
        phase: 'in-flight',
        traceId: event.trace_id,
        startedAt: inflight.startedAt,
        timing,
      });
      const normalized = {
        event: 'agent_bound',
        ts,
        trace_id: event.trace_id,
        agent_id: event.agent_id,
        ...surfaceEventFields(inflight.surface),
        timing,
        agent,
      };
      this._recordRecent(normalized);
      return normalized;
    }

    if (event.event === 'request_start') {
      const surface = describeJourneySurface(event);
      if (surface.surfaceType === 'other') return null;
      const route = this._ensureRoute(surface);
      route.inFlight += 1;
      route.lastEventTime = ts;
      const traceId = event.trace_id || `trace-${this.eventsSeen}`;
      const requestStartedAt = timing.startedAtMs || ts;
      this.inflight.set(traceId, {
        traceId,
        surface,
        agentId: event.agent_id || null,
        startedAt: requestStartedAt,
      });
      const agent = event.agent_id
        ? this._moveAgent(event.agent_id, surface, {
          ts,
          phase: 'in-flight',
          traceId,
          startedAt: requestStartedAt,
          timing,
        })
        : null;
      const normalized = {
        event: 'request_start',
        ts,
        trace_id: traceId,
        agent_id: event.agent_id || null,
        ...surfaceEventFields(surface),
        timing,
        agent,
      };
      this._recordRecent(normalized);
      return normalized;
    }

    if (event.event === 'request_finish' || event.event === 'api_request') {
      const surface = describeJourneySurface(event);
      if (surface.surfaceType === 'other') return null;
      const route = this._ensureRoute(surface);
      route.lastEventTime = ts;
      route.finished += 1;

      const status = Number.isInteger(event.status)
        ? event.status
        : Number.isInteger(event.status_code)
          ? event.status_code
          : 0;

      if (status >= 500) route.status5xx += 1;
      else if (status >= 400) route.status4xx += 1;
      else if (status >= 200) route.status2xx += 1;

      let inflight = null;
      if (event.trace_id && this.inflight.has(event.trace_id)) {
        inflight = this.inflight.get(event.trace_id);
        const inflightRoute = this.routes.get(inflight.surface.routeKey);
        if (inflightRoute) inflightRoute.inFlight = Math.max(0, inflightRoute.inFlight - 1);
        this.inflight.delete(event.trace_id);
      }

      const agentId = event.agent_id || inflight?.agentId || null;
      const agent = agentId
        ? this._moveAgent(agentId, surface, {
          ts,
          phase: 'finished',
          status,
          traceId: event.trace_id || null,
          startedAt: inflight?.startedAt || timing.startedAtMs || null,
          timing,
        })
        : null;

      const normalized = {
        event: 'request_finish',
        ts,
        trace_id: event.trace_id || null,
        agent_id: agentId,
        ...surfaceEventFields(surface),
        status,
        duration_ms: Number.isFinite(event.duration_ms) ? event.duration_ms : null,
        timing,
        agent,
      };
      this._recordRecent(normalized);
      return normalized;
    }

    return null;
  }

  ingestBatch(events) {
    const normalized = [];
    for (const event of events || []) {
      const applied = this.applyEvent(event);
      if (applied) normalized.push(applied);
    }
    this.evictStale();
    return normalized;
  }

  buildSnapshot({
    now = Date.now(),
    log = null,
  } = {}) {
    this.evictStale(now);

    const agents = Array.from(this.agents.values())
      .map(agent => this._serializeAgent(agent, now))
      .sort((a, b) => b.lastEventTime - a.lastEventTime);

    const routes = Array.from(this.routes.values())
      .sort((a, b) => {
        const rankDelta = domainRank(a.domain) - domainRank(b.domain);
        if (rankDelta !== 0) return rankDelta;
        const groupDelta = a.group.localeCompare(b.group);
        if (groupDelta !== 0) return groupDelta;
        return a.routePath.localeCompare(b.routePath);
      })
      .map(route => ({
        routeKey: route.routeKey,
        routeLabel: route.routeLabel,
        routePath: route.routePath,
        method: route.method,
        domain: route.domain,
        group: route.group,
        surfaceType: route.surfaceType,
        canonical: route.canonical,
        summary: route.summary || null,
        auth: route.auth || null,
        sourceFile: route.sourceFile || null,
        sourceLine: Number.isInteger(route.sourceLine) ? route.sourceLine : null,
        tags: cloneList(route.tags),
        docId: route.docId || null,
        docTitle: route.docTitle || null,
        docKind: route.docKind || null,
        docIds: cloneList(route.docIds),
        linkedRouteKeys: cloneList(route.linkedRouteKeys),
        linkedDocIds: cloneList(route.linkedDocIds),
        activeAgents: route.activeAgents,
        inFlight: route.inFlight,
        finished: route.finished,
        status2xx: route.status2xx,
        status4xx: route.status4xx,
        status5xx: route.status5xx,
        lastEventTime: route.lastEventTime,
      }));

    const domains = JOURNEY_DOMAIN_ORDER.map(domain => {
      const matchingRoutes = routes.filter(route => route.domain === domain);
      const activeAgents = matchingRoutes.reduce((sum, route) => sum + route.activeAgents, 0);
      const inFlight = matchingRoutes.reduce((sum, route) => sum + route.inFlight, 0);
      return {
        id: domain,
        routes: matchingRoutes.length,
        activeAgents,
        inFlight,
      };
    }).filter(domain => domain.routes > 0 || domain.activeAgents > 0 || domain.inFlight > 0);

    return {
      builtAt: now,
      stats: {
        agents: agents.length,
        routes: routes.length,
        inFlight: this.inflight.size,
        eventsSeen: this.eventsSeen,
        droppedAgents: this.droppedAgents,
      },
      domains,
      routes,
      agents,
      recentEvents: this.recentEvents.slice(-120),
      log,
    };
  }
}
