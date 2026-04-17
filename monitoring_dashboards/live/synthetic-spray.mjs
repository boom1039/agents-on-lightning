import { JOURNEY_DOMAIN_ORDER, listKnownJourneySurfaces } from './route-surface.mjs';

const DEFAULT_OPTIONS = {
  seed: 17,
  tickMs: 140,
  initialBurstSize: 20,
  burstEveryMs: 2400,
  burstMin: 4,
  burstMax: 9,
  maxAgents: 180,
  maxInflight: 72,
  maxStartsPerTick: 18,
  holdMinMs: 90,
  holdMaxMs: 1100,
  gapMinMs: 90,
  gapMaxMs: 820,
};

const HOME_DOMAIN_WEIGHTS = [
  'identity', 'identity',
  'wallet', 'wallet',
  'market', 'market',
  'social', 'social',
  'channels',
  'analytics',
  'capital',
  'analysis',
  'discovery',
];

function createSeededRandom(seed = 1) {
  let state = (Number(seed) || 1) >>> 0;
  return () => {
    state = (state + 0x6D2B79F5) >>> 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t ^= t + Math.imul(t ^ (t >>> 7), 61 | t);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomInt(rng, min, max) {
  const lower = Math.min(min, max);
  const upper = Math.max(min, max);
  return lower + Math.floor(rng() * ((upper - lower) + 1));
}

function pick(rng, list) {
  if (!Array.isArray(list) || list.length === 0) return null;
  return list[Math.floor(rng() * list.length)] || null;
}

function pickDistinct(rng, list, excluded = new Set()) {
  const filtered = list.filter((item) => !excluded.has(item.routeKey));
  return pick(rng, filtered.length > 0 ? filtered : list);
}

function buildCatalog() {
  const known = listKnownJourneySurfaces();
  const byKey = new Map(known.map((surface) => [surface.routeKey, surface]));
  const api = known.filter((surface) => surface.surfaceType === 'api' && surface.canonical);
  const byDomain = new Map();
  const byDomainGroup = new Map();

  for (const surface of api) {
    const domainList = byDomain.get(surface.domain) || [];
    domainList.push(surface);
    byDomain.set(surface.domain, domainList);

    const groupKey = `${surface.domain}:${surface.group}`;
    const groupList = byDomainGroup.get(groupKey) || [];
    groupList.push(surface);
    byDomainGroup.set(groupKey, groupList);
  }

  const skillByDomain = new Map();
  for (const domain of JOURNEY_DOMAIN_ORDER) {
    const skill = byKey.get(`GET /docs/skills/${domain}.txt`);
    if (skill) skillByDomain.set(domain, skill);
  }

  return {
    byKey,
    byDomain,
    byDomainGroup,
    root: byKey.get('GET /'),
    llms: byKey.get('GET /llms.txt'),
    register: byKey.get('POST /api/v1/agents/register'),
    agentMe: byKey.get('GET /api/v1/agents/me'),
    agentMePut: byKey.get('PUT /api/v1/agents/me'),
    skillByDomain,
  };
}

function materializePath(path, agentId, sequenceId) {
  const short = agentId.replace(/[^a-z0-9]/gi, '').slice(-8).toLowerCase() || 'agent';
  const fakePubkey = `02${short.padEnd(64, 'a').slice(0, 64)}`;
  return String(path || '').replace(/:([a-zA-Z_]+)/g, (_, key) => {
    switch (key) {
      case 'id':
        return `${short}-${sequenceId}`;
      case 'pubkey':
        return fakePubkey;
      case 'chanId':
        return `${100000 + sequenceId}x${10 + (sequenceId % 30)}x${1 + (sequenceId % 8)}`;
      case 'topic':
        return ['strategy', 'protocol', 'onboarding', 'operator-wisdom'][sequenceId % 4];
      case 'name':
        return ['identity', 'wallet', 'social', 'market'][sequenceId % 4];
      case 'group':
        return ['social', 'market', 'channels', 'capital'][sequenceId % 4];
      default:
        return `${key}-${sequenceId}`;
    }
  });
}

function pickStatus(surface, rng) {
  const method = String(surface.method || 'GET').toUpperCase();
  const path = String(surface.routePath || '');
  const roll = rng();

  if (path === '/api/v1/agents/register') return 201;
  if (path === '/api/v1/node/test-connection' || path === '/api/v1/node/connect') {
    return roll < 0.7 ? 400 : 200;
  }
  if (method === 'PUT') return roll < 0.86 ? 200 : 400;
  if (method === 'POST') {
    if (roll < 0.04) return 500;
    if (roll < 0.18) return 400;
    return 200;
  }
  if (roll < 0.025) return 500;
  if (roll < 0.08) return 404;
  return 200;
}

function buildOnboardingQueue(agent, catalog, rng) {
  const queue = [];
  const skill = catalog.skillByDomain.get(agent.homeDomain) || catalog.skillByDomain.get('discovery');
  const homeRoutes = catalog.byDomain.get(agent.homeDomain) || [];
  const homeStart = pickDistinct(rng, homeRoutes, new Set([
    'POST /api/v1/agents/register',
    'GET /api/v1/agents/me',
    'PUT /api/v1/agents/me',
  ]));

  if (catalog.root) queue.push({ surface: catalog.root });
  if (catalog.llms) queue.push({ surface: catalog.llms });
  if (skill) queue.push({ surface: skill });
  if (catalog.register) queue.push({ surface: catalog.register, registration: true });
  if (catalog.agentMe) queue.push({ surface: catalog.agentMe });
  if (catalog.agentMePut && rng() < 0.45) queue.push({ surface: catalog.agentMePut });
  if (homeStart) queue.push({ surface: homeStart });
  return queue;
}

export function createSyntheticJourneySprayController(options = {}) {
  const settings = { ...DEFAULT_OPTIONS, ...options };
  const rng = createSeededRandom(settings.seed);
  const catalog = buildCatalog();
  const state = {
    startedAt: 0,
    nextBurstAt: 0,
    sequence: 0,
    traceSeq: 0,
    agentsCreated: 0,
    eventsEmitted: 0,
    agents: new Map(),
    pendingFinishes: [],
  };

  function spawnAgent(now) {
    if (state.agents.size >= settings.maxAgents) return null;
    const homeDomain = pick(rng, HOME_DOMAIN_WEIGHTS) || 'identity';
    const agentId = `synth-${String(++state.sequence).padStart(4, '0')}`;
    const agent = {
      id: agentId,
      homeDomain,
      queue: [],
      recentRouteKeys: [],
      currentSurface: null,
      busy: false,
      nextActionAt: now + randomInt(rng, 0, 600),
      lastEventAt: now,
    };
    agent.queue = buildOnboardingQueue(agent, catalog, rng);
    state.agents.set(agentId, agent);
    state.agentsCreated += 1;
    return agent;
  }

  function spawnBurst(now, size) {
    for (let i = 0; i < size; i += 1) spawnAgent(now);
  }

  function chooseNextSurface(agent) {
    const current = agent.currentSurface;
    if (!current) {
      const home = catalog.byDomain.get(agent.homeDomain) || [];
      return pickDistinct(rng, home);
    }

    const excluded = new Set(agent.recentRouteKeys.slice(0, 2));
    const sameGroup = catalog.byDomainGroup.get(`${current.domain}:${current.group}`) || [];
    const sameDomain = (catalog.byDomain.get(current.domain) || []).filter((surface) => surface.group !== current.group);
    const otherDomains = JOURNEY_DOMAIN_ORDER.filter((domain) => domain !== current.domain && catalog.byDomain.has(domain));
    const crossDomain = pick(rng, otherDomains);
    const crossDomainRoutes = crossDomain ? (catalog.byDomain.get(crossDomain) || []) : [];
    const docReset = [catalog.root, catalog.llms, catalog.skillByDomain.get(agent.homeDomain)].filter(Boolean);
    const roll = rng();

    if (roll < 0.48) return pickDistinct(rng, sameGroup, excluded) || pickDistinct(rng, sameDomain, excluded) || pickDistinct(rng, crossDomainRoutes, excluded);
    if (roll < 0.78) return pickDistinct(rng, sameDomain, excluded) || pickDistinct(rng, sameGroup, excluded) || pickDistinct(rng, crossDomainRoutes, excluded);
    if (roll < 0.94) return pickDistinct(rng, crossDomainRoutes, excluded) || pickDistinct(rng, sameDomain, excluded) || pickDistinct(rng, sameGroup, excluded);
    return pickDistinct(rng, docReset, excluded) || pickDistinct(rng, crossDomainRoutes, excluded) || pickDistinct(rng, sameGroup, excluded);
  }

  function startAction(agent, now) {
    const action = agent.queue.length > 0
      ? agent.queue.shift()
      : { surface: chooseNextSurface(agent) };
    if (!action?.surface) return [];

    const startTs = now + randomInt(rng, 0, 30);
    const holdMs = randomInt(rng, settings.holdMinMs, settings.holdMaxMs) + (action.surface.method === 'POST' ? 90 : 0);
    const finishTs = startTs + holdMs;
    const traceId = `${agent.id}-synth-${++state.traceSeq}`;
    const path = materializePath(action.surface.routePath, agent.id, state.traceSeq);
    const events = [];

    if (action.registration) {
      events.push({
        event: 'registration_attempt',
        ts: startTs - 1,
        agent_id: agent.id,
        success: true,
      });
    }

    events.push({
      event: 'request_start',
      ts: startTs,
      trace_id: traceId,
      agent_id: agent.id,
      method: action.surface.method,
      path,
      started_at_ms: startTs,
    });

    state.pendingFinishes.push({
      dueAt: finishTs,
      agentId: agent.id,
      surface: action.surface,
      event: {
        event: 'request_finish',
        ts: finishTs,
        trace_id: traceId,
        agent_id: agent.id,
        method: action.surface.method,
        path,
        status: pickStatus(action.surface, rng),
        duration_ms: holdMs,
        started_at_ms: startTs,
        finished_at_ms: finishTs,
        latency_ms: holdMs,
      },
    });

    agent.currentSurface = action.surface;
    agent.busy = true;
    agent.lastEventAt = startTs;
    agent.nextActionAt = finishTs + randomInt(rng, settings.gapMinMs, settings.gapMaxMs);
    return events;
  }

  function flushFinishes(now) {
    const ready = [];
    const pending = [];
    for (const entry of state.pendingFinishes) {
      if (entry.dueAt <= now) ready.push(entry);
      else pending.push(entry);
    }
    state.pendingFinishes = pending;

    ready.sort((a, b) => a.dueAt - b.dueAt);
    for (const entry of ready) {
      const agent = state.agents.get(entry.agentId);
      if (!agent) continue;
      agent.busy = false;
      agent.lastEventAt = entry.dueAt;
      agent.recentRouteKeys.unshift(entry.surface.routeKey);
      if (agent.recentRouteKeys.length > 6) agent.recentRouteKeys.length = 6;
    }
    return ready.map((entry) => entry.event);
  }

  function flushAll(now = Date.now()) {
    const remaining = state.pendingFinishes.splice(0, state.pendingFinishes.length)
      .sort((a, b) => a.dueAt - b.dueAt);
    const events = [];
    for (const entry of remaining) {
      const agent = state.agents.get(entry.agentId);
      if (agent) {
        agent.busy = false;
        agent.lastEventAt = now;
        agent.recentRouteKeys.unshift(entry.surface.routeKey);
        if (agent.recentRouteKeys.length > 6) agent.recentRouteKeys.length = 6;
      }
      events.push({
        ...entry.event,
        ts: now,
        finished_at_ms: now,
        latency_ms: Math.max(1, now - Number(entry.event.started_at_ms || now)),
        duration_ms: Math.max(1, now - Number(entry.event.started_at_ms || now)),
      });
    }
    state.eventsEmitted += events.length;
    return events;
  }

  function snapshot(now = Date.now()) {
    return {
      running: true,
      tickMs: settings.tickMs,
      agentsCreated: state.agentsCreated,
      activeAgents: state.agents.size,
      inflight: state.pendingFinishes.length,
      eventsEmitted: state.eventsEmitted,
      nextBurstAt: state.nextBurstAt || now,
    };
  }

  function drain(now = Date.now()) {
    if (!state.startedAt) {
      state.startedAt = now;
      state.nextBurstAt = now;
    }

    const events = flushFinishes(now);

    if (state.nextBurstAt <= now) {
      const burstSize = state.agentsCreated === 0
        ? settings.initialBurstSize
        : randomInt(rng, settings.burstMin, settings.burstMax);
      spawnBurst(now, burstSize);
      state.nextBurstAt = now + settings.burstEveryMs;
    }

    const inflightNow = state.pendingFinishes.length;
    let startsLeft = Math.max(0, settings.maxStartsPerTick - inflightNow);
    const readyAgents = Array.from(state.agents.values())
      .filter((agent) => !agent.busy && agent.nextActionAt <= now)
      .sort((a, b) => a.nextActionAt - b.nextActionAt);

    for (const agent of readyAgents) {
      if (startsLeft <= 0) break;
      if (state.pendingFinishes.length >= settings.maxInflight) break;
      events.push(...startAction(agent, now));
      startsLeft -= 1;
    }

    events.sort((a, b) => a.ts - b.ts);
    state.eventsEmitted += events.length;
    return events;
  }

  return {
    tickMs: settings.tickMs,
    drain,
    flushAll,
    snapshot,
  };
}
