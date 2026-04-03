import express from 'express';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import readline from 'readline';
import { LiveJourneyState } from './live/state.mjs';
import { buildDefaultDemoSpray, loadReplayCatalog, stampBatchEvents } from './live/demo-spray.mjs';
import { createSyntheticJourneySprayController } from './live/synthetic-spray.mjs';
import { getAuditLogStatus } from '../src/identity/audit-log.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const AUDIT_LOG = path.resolve(__dirname, '../data/security-audit.jsonl');
const PORT = Number.parseInt(process.env.MONITOR_DASHBOARD_PORT || process.env.PORT || '3308', 10);
const HOST = process.env.MONITOR_DASHBOARD_HOST || '127.0.0.1';
const IDLE_MS = 60_000;
const MAX_REQ = 500;

// Domain classification (ported from agent-surface-inventory.js)

function classifyDomain(p) {
  if (p === '/' || p === '/llms.txt' || p === '/health') return 'app-level';
  if (p === '/api/v1/' || p.startsWith('/api/v1/platform/') || p === '/api/v1/ethos' || p === '/api/v1/capabilities' || p.startsWith('/api/v1/strategies') || p.startsWith('/api/v1/knowledge/') || p.startsWith('/api/v1/skills')) return 'discovery';
  if (p.startsWith('/api/v1/agents/') || p.startsWith('/api/v1/node/') || p.startsWith('/api/v1/actions/')) return 'identity';
  if (p.startsWith('/api/v1/wallet/') || p === '/api/v1/ledger') return 'wallet';
  if (p.startsWith('/api/v1/analysis/')) return 'analysis';
  if (p.startsWith('/api/v1/messages') || p.startsWith('/api/v1/alliances') || p.startsWith('/api/v1/leaderboard') || p.startsWith('/api/v1/tournaments') || p.startsWith('/api/v1/bounties')) return 'social';
  if (p.startsWith('/api/v1/channels/')) return 'channels';
  if (p.startsWith('/api/v1/market/')) return 'market';
  if (p.startsWith('/api/v1/analytics/')) return 'analytics';
  if (p.startsWith('/api/v1/capital/') || p === '/api/v1/help') return 'capital';
  return null;
}

// Domain metadata

const DOMAIN_POSITIONS = {
  'app-level':  { x:  0,   y: 2.5, z:  0   },
  'discovery':  { x:  8,   y: 1.5, z:  3   },
  'identity':   { x:  6,   y: 0.5, z: -6   },
  'wallet':     { x:  0,   y: 0,   z: -9   },
  'analysis':   { x: -6,   y:-0.5, z: -6   },
  'social':     { x: -9,   y: 0,   z:  0   },
  'channels':   { x: -6,   y: 0.5, z:  6   },
  'market':     { x:  0,   y: 1,   z:  9   },
  'analytics':  { x:  4,   y:-0.5, z:  5   },
  'capital':    { x: -3,   y:-1,   z:  3   },
};

const DOMAIN_COLORS = {
  'app-level':  '#ffffff',
  'discovery':  '#6eb5ff',
  'identity':   '#5fd89a',
  'wallet':     '#ffd36e',
  'analysis':   '#64dfdf',
  'social':     '#c77dff',
  'channels':   '#ff8e98',
  'market':     '#f4b350',
  'analytics':  '#72efdd',
  'capital':    '#ff6d6d',
};

// In-memory state

const agents = new Map();
const domainStats = new Map();
const transitions = new Map();
const journeyState = new LiveJourneyState();
let totalRequests = 0;
let byteOffset = 0;
const sseClients = new Set();
const journeyClients = new Set();
let replayCatalogPromise = null;
let demoRunId = 0;
const demoTimers = new Set();
let syntheticController = null;
let syntheticTimer = null;

function ensureAgent(id) {
  if (!agents.has(id))
    agents.set(id, { id, currentDomain: null, lastEventTime: 0, requests: [], registeredAt: null, ip: null });
  return agents.get(id);
}

function ensureDomain(domain) {
  if (!domainStats.has(domain))
    domainStats.set(domain, { requestCount: 0, activeAgents: new Set(), lastEventTime: 0 });
  return domainStats.get(domain);
}

function processEvent(evt) {
  if (evt.event === 'registration_attempt') {
    const { agent_id: agentId, ip } = evt;
    const ts = evt.timestamp || evt._ts || Date.now();
    if (!agentId) return null;
    const agent = ensureAgent(agentId);
    agent.registeredAt = ts;
    agent.ip = ip;
    if (!agent.currentDomain) agent.currentDomain = 'identity';
    if (ip) {
      for (const [aid, a] of agents) {
        if (aid.startsWith('ip:') && a.ip === ip && (ts - a.lastEventTime) < 30_000) {
          agent.requests.push(...a.requests);
          agents.delete(aid);
        }
      }
      agent.requests.sort((a, b) => a._ts - b._ts);
      if (agent.requests.length > MAX_REQ)
        agent.requests = agent.requests.slice(-MAX_REQ);
    }
    return null;
  }

  if (evt.event !== 'api_request') return null;
  const p = evt.path;
  if (!p) return null;
  const domain = classifyDomain(p);
  if (!domain) return null;

  const ts = evt.timestamp || evt._ts || Date.now();
  const agentId = evt.agent_id || (evt.ip ? `ip:${evt.ip}` : null);
  if (!agentId) return null;

  const agent = ensureAgent(agentId);
  if (!agent.ip && evt.ip) agent.ip = evt.ip;
  const prevDomain = agent.currentDomain;

  const record = {
    method: evt.method || 'GET', path: p,
    status: evt.status_code || evt.status || 0,
    duration_ms: evt.duration_ms || 0, domain, _ts: ts,
  };

  agent.requests.push(record);
  if (agent.requests.length > MAX_REQ) agent.requests.shift();
  agent.currentDomain = domain;
  agent.lastEventTime = ts;

  const ds = ensureDomain(domain);
  ds.requestCount++;
  ds.activeAgents.add(agentId);
  ds.lastEventTime = ts;
  totalRequests++;

  if (prevDomain && prevDomain !== domain) {
    const key = `${prevDomain}->${domain}`;
    transitions.set(key, (transitions.get(key) || 0) + 1);
  }

  return { agentId, ...record };
}

// Audit log reading

async function readFullLog() {
  if (!fs.existsSync(AUDIT_LOG)) return;
  const stat = fs.statSync(AUDIT_LOG);
  const rl = readline.createInterface({
    input: fs.createReadStream(AUDIT_LOG, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  });
  for await (const line of rl) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line);
      processEvent(parsed);
      journeyState.applyEvent(parsed);
    } catch {}
  }
  byteOffset = stat.size;
}

async function readNewLines() {
  if (!fs.existsSync(AUDIT_LOG)) return [];
  const stat = fs.statSync(AUDIT_LOG);
  if (stat.size < byteOffset) byteOffset = 0;
  if (stat.size <= byteOffset) return [];

  const rl = readline.createInterface({
    input: fs.createReadStream(AUDIT_LOG, { start: byteOffset, encoding: 'utf8' }),
    crlfDelay: Infinity,
  });
  const newEvents = [];
  for await (const line of rl) {
    if (!line.trim()) continue;
    try {
      const evt = processEvent(JSON.parse(line));
      if (evt) newEvents.push(evt);
    } catch {}
  }
  byteOffset = stat.size;
  return newEvents;
}

// File watcher with debounce

let watchTimer = null;
function startWatcher() {
  try {
    // Watch the file directly — more reliable on macOS than watching the directory
    fs.watchFile(AUDIT_LOG, { interval: 500 }, (curr, prev) => {
      if (curr.size <= prev.size) return;
      if (watchTimer) clearTimeout(watchTimer);
      watchTimer = setTimeout(async () => {
        const events = await readNewLines();
        if (events.length > 0) {
          console.log(`[${new Date().toLocaleTimeString()}] ${events.length} new event(s)`);
          for (const evt of events) broadcastEvent(evt);
        }
      }, 200);
    });
    console.log('Watching audit log for changes...');
  } catch (err) {
    console.warn('Watch failed, retrying in 5s:', err.message);
    setTimeout(startWatcher, 5000);
  }
}

// SSE

function broadcastEvent(evt) {
  // Normalize to the shape the Galaxy client expects
  const payload = {
    event: 'api_request',
    agent_id: evt.agentId || evt.agent_id,
    method: evt.method,
    path: evt.path,
    status: evt.status,
    duration_ms: evt.duration_ms,
    domain: evt.domain,
    _ts: evt._ts,
  };
  const data = JSON.stringify(payload);
  for (const res of sseClients) {
    try { res.write(`data: ${data}\n\n`); } catch { sseClients.delete(res); }
  }
}

function broadcastJourneyEvent(evt) {
  const data = JSON.stringify(evt);
  for (const res of journeyClients) {
    try { res.write(`data: ${data}\n\n`); } catch { journeyClients.delete(res); }
  }
}

function broadcastJourneySnapshot() {
  const data = JSON.stringify({
    type: 'snapshot',
    snapshot: journeyState.buildSnapshot({ log: getAuditLogStatus() }),
  });
  for (const res of journeyClients) {
    try { res.write(`data: ${data}\n\n`); } catch { journeyClients.delete(res); }
  }
}

function resetMonitorState() {
  agents.clear();
  domainStats.clear();
  transitions.clear();
  totalRequests = 0;
  journeyState.reset();
}

function ingestJourneyEvents(events) {
  const applied = journeyState.ingestBatch(events);
  for (const event of applied) broadcastJourneyEvent(event);
  return applied;
}

function cancelDemoSpray() {
  demoRunId += 1;
  for (const timer of demoTimers) clearTimeout(timer);
  demoTimers.clear();
}

function cancelSyntheticSpray() {
  if (syntheticTimer) clearInterval(syntheticTimer);
  syntheticTimer = null;
  syntheticController = null;
}

function getSyntheticStatus() {
  if (!syntheticController) {
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
    ...syntheticController.snapshot(),
  };
}

async function getReplayCatalog() {
  if (!replayCatalogPromise) {
    replayCatalogPromise = loadReplayCatalog().catch((error) => {
      replayCatalogPromise = null;
      throw error;
    });
  }
  return replayCatalogPromise;
}

async function startDemoSpray() {
  const records = await getReplayCatalog();
  const plan = buildDefaultDemoSpray(records);
  cancelDemoSpray();
  cancelSyntheticSpray();
  const runId = demoRunId;
  resetMonitorState();
  broadcastJourneySnapshot();

  for (const replay of plan.runs) {
    for (const batch of replay.batches) {
      const timer = setTimeout(() => {
        demoTimers.delete(timer);
        if (runId !== demoRunId) return;
        ingestJourneyEvents(stampBatchEvents(batch.events));
      }, batch.delayMs);
      timer.unref?.();
      demoTimers.add(timer);
    }
  }

  const finishTimer = setTimeout(() => {
    demoTimers.delete(finishTimer);
    if (runId !== demoRunId) return;
    broadcastJourneySnapshot();
  }, plan.totalDurationMs + 50);
  finishTimer.unref?.();
  demoTimers.add(finishTimer);

  return {
    ok: true,
    name: plan.name,
    agents: plan.agents,
    durationMs: plan.totalDurationMs,
  };
}

function startSyntheticSpray() {
  cancelDemoSpray();
  cancelSyntheticSpray();
  resetMonitorState();
  broadcastJourneySnapshot();

  syntheticController = createSyntheticJourneySprayController();
  const tick = () => {
    if (!syntheticController) return;
    const events = syntheticController.drain(Date.now());
    if (events.length > 0) ingestJourneyEvents(events);
  };

  tick();
  syntheticTimer = setInterval(tick, syntheticController.tickMs);
  syntheticTimer.unref?.();
  return getSyntheticStatus();
}

function buildStateSnapshot() {
  const now = Date.now();
  return {
    agents: Array.from(agents.values())
      .filter(a => !a.id.startsWith('ip:'))
      .map(a => ({
        id: a.id, currentDomain: a.currentDomain,
        lastEventTime: a.lastEventTime, requestCount: a.requests.length,
        idle: (now - a.lastEventTime) > IDLE_MS,
      })),
    domains: Object.fromEntries(
      Array.from(domainStats.entries()).map(([d, s]) => [d, {
        activeAgents: s.activeAgents.size,
        requestCount: s.requestCount,
        lastEventTime: s.lastEventTime,
      }])
    ),
    totalAgents: Array.from(agents.keys()).filter(k => !k.startsWith('ip:')).length,
    totalRequests,
  };
}

// Express app

const app = express();
app.use(express.json({ limit: '256kb' }));
app.use('/live', express.static(path.join(__dirname, 'live'), { etag: false, maxAge: 0 }));
app.use('/journey', express.static(path.join(__dirname, 'journey'), { etag: false, maxAge: 0 }));
app.use((_, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST');
  next();
});

app.get('/', (_, res) => {
  res.type('html').send(`<!DOCTYPE html>
<html><head><title>Agent Flow Monitor</title>
<style>body{background:#0d1117;color:#c8d6e0;font:16px/1.6 system-ui;display:flex;flex-direction:column;align-items:center;justify-content:center;height:100vh;margin:0}
a{color:#6eb5ff;font-size:20px;margin:12px;text-decoration:none;padding:12px 24px;border:1px solid #30363d;border-radius:8px}
a:hover{border-color:#6eb5ff;background:#161b22}
h1{font-size:24px;margin-bottom:32px}</style>
</head><body>
<h1>Agent Flow Monitor</h1>
<a href="/atlas">The Atlas &mdash; Elastic Route View</a>
<a href="/journey">The Journey &mdash; Live Route Grid</a>
<a href="/landscape">The Landscape &mdash; Journey Map</a>
<a href="/galaxy">The Galaxy &mdash; 3D Data Art</a>
<a href="/hive">The Hive &mdash; 2D Ops Monitor</a>
<a href="/river">The River &mdash; Analytics Flow</a>
</body></html>`);
});

app.get('/atlas', (_, res) => res.sendFile(path.join(__dirname, 'atlas/index.html')));
app.get('/journey', (_, res) => res.sendFile(path.join(__dirname, 'journey/index.html')));
app.get('/journey/flex', (_, res) => res.sendFile(path.join(__dirname, 'journey/flex.html')));
app.get('/journey/three', (_, res) => res.sendFile(path.join(__dirname, 'journey/three.html')));
app.get('/landscape', (_, res) => res.sendFile(path.join(__dirname, 'landscape/index.html')));
app.get('/galaxy', (_, res) => res.sendFile(path.join(__dirname, 'galaxy/index.html')));
app.get('/hive',   (_, res) => res.sendFile(path.join(__dirname, 'hive/index.html')));
app.get('/river',  (_, res) => res.sendFile(path.join(__dirname, 'river/index.html')));

app.get('/api/state', (_, res) => res.json(buildStateSnapshot()));

app.get('/api/flow', (_, res) => {
  const transArr = [];
  for (const [key, count] of transitions) {
    const [source, target] = key.split('->');
    transArr.push({ source, target, count });
  }
  const domainCounts = {};
  for (const [d, s] of domainStats) domainCounts[d] = s.requestCount;
  res.json({ transitions: transArr, domainCounts });
});

app.post('/api/live-events', (req, res) => {
  const events = Array.isArray(req.body?.events) ? req.body.events : [];
  const applied = ingestJourneyEvents(events);
  res.json({ ok: true, accepted: events.length, applied: applied.length });
});

app.post('/api/demo/reset-and-spray', async (_, res) => {
  try {
    const started = await startDemoSpray();
    res.json(started);
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message || 'failed to start spray' });
  }
});

app.get('/api/demo/synthetic', (_, res) => {
  res.json(getSyntheticStatus());
});

app.post('/api/demo/synthetic/start', (_, res) => {
  try {
    res.json(startSyntheticSpray());
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message || 'failed to start synthetic spray' });
  }
});

app.post('/api/demo/synthetic/stop', (_, res) => {
  if (syntheticController) {
    const events = syntheticController.flushAll(Date.now());
    if (events.length > 0) ingestJourneyEvents(events);
  }
  cancelSyntheticSpray();
  res.json(getSyntheticStatus());
});

app.get('/api/journey', (_, res) => {
  res.json(journeyState.buildSnapshot({
    log: getAuditLogStatus(),
  }));
});

app.get('/api/journey/events', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
  });
  res.flushHeaders();

  res.write(`data: ${JSON.stringify({
    type: 'snapshot',
    snapshot: journeyState.buildSnapshot({ log: getAuditLogStatus() }),
  })}\n\n`);

  journeyClients.add(res);
  const heartbeat = setInterval(() => res.write(': heartbeat\n\n'), 30_000);
  req.on('close', () => { journeyClients.delete(res); clearInterval(heartbeat); });
});

app.get('/api/landscape', (_, res) => {
  const result = [];
  for (const [id, agent] of agents) {
    if (id.startsWith('ip:')) continue;
    const domainMap = new Map();
    for (const req of agent.requests) {
      if (!req.domain) continue;
      if (!domainMap.has(req.domain)) {
        domainMap.set(req.domain, { domain: req.domain, firstSeen: req._ts, lastSeen: req._ts, requestCount: 0 });
      }
      const d = domainMap.get(req.domain);
      d.requestCount++;
      if (req._ts < d.firstSeen) d.firstSeen = req._ts;
      if (req._ts > d.lastSeen) d.lastSeen = req._ts;
    }
    const history = Array.from(domainMap.values()).sort((a, b) => a.firstSeen - b.firstSeen);
    result.push({
      id,
      currentDomain: agent.currentDomain,
      totalRequests: agent.requests.length,
      registeredAt: agent.registeredAt || (agent.requests[0] && agent.requests[0]._ts) || 0,
      lastEventTime: agent.lastEventTime,
      domainHistory: history,
    });
  }
  res.json({ agents: result });
});

app.get('/api/agent/:id', (req, res) => {
  const agent = agents.get(req.params.id);
  if (!agent) return res.status(404).json({ error: 'agent not found' });
  res.json({
    id: agent.id, requests: agent.requests,
    currentDomain: agent.currentDomain, registeredAt: agent.registeredAt,
  });
});

app.get('/api/events', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
  });
  res.flushHeaders();

  // Send compact init: type marker + just active agents with their current domain
  const activeAgents = Array.from(agents.values())
    .filter(a => !a.id.startsWith('ip:') && a.requests.length > 0)
    .map(a => ({ agent_id: a.id, domain: a.currentDomain || 'identity' }));
  res.write(`data: ${JSON.stringify({ type: 'init', agents: activeAgents, totalRequests })}\n\n`);

  // Replay last request per active agent (so Galaxy places them correctly)
  const recentAgents = Array.from(agents.values())
    .filter(a => !a.id.startsWith('ip:') && a.requests.length > 0)
    .slice(-50); // cap to 50 most recently seen
  for (const a of recentAgents) {
    const last = a.requests[a.requests.length - 1];
    res.write(`data: ${JSON.stringify({ ...last, event: 'api_request', agent_id: a.id })}\n\n`);
  }

  sseClients.add(res);
  const heartbeat = setInterval(() => res.write(': heartbeat\n\n'), 30_000);
  req.on('close', () => { sseClients.delete(res); clearInterval(heartbeat); });
});

app.get('/api/domains', (_, res) => {
  res.json({
    domains: Object.keys(DOMAIN_POSITIONS).map(id => ({
      id, color: DOMAIN_COLORS[id], position: DOMAIN_POSITIONS[id],
    })),
  });
});

// Start

await readFullLog();
startWatcher();
app.listen(PORT, HOST, () => console.log(`Agent Flow Monitor at http://${HOST}:${PORT}`));
