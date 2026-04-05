import * as THREE from 'three';
import { gridSlotPos, heightForAgentCount, RW, RD, styleState } from './constants.js';
import { routeKeyMap } from './manifest.js';
import { routeBoxes } from './builder.js';
import { agentMgr, flightMgr, startSettle } from './agents.js';

// Route stats
export const routeStats = new Map();
const agentRoutes = new Map();      // agentId → current routeKey
const routeAgents = new Map();      // routeKey → Set<agentId>
const routeSlots = new Map();       // routeKey → { slots: Map<agentId,slotIdx>, free: [] }

// Events-per-second tracking
const eventTimestamps = [];

export function getEventsPerSecond() {
  const now = Date.now();
  while (eventTimestamps.length > 0 && eventTimestamps[0] < now - 5000) eventTimestamps.shift();
  return (eventTimestamps.length / 5).toFixed(1);
}

// HUD callback (set by hud.js to avoid circular imports)
let onSnapshotHUD = null;
export function onSnapshot(fn) { onSnapshotHUD = fn; }
let onConnectionHUD = null;
export function onConnection(fn) { onConnectionHUD = fn; }

function emitConnection(connected, label) {
  if (onConnectionHUD) onConnectionHUD({ connected, label });
}

function updateAgentFunding(data, agent) {
  if (!data || !agent) return;
  data.fundingState = agent.fundingState || 'empty';
  data.fundingLabel = agent.fundingLabel || null;
  data.walletBalanceSats = Number(agent.walletBalanceSats || 0);
  data.capitalAvailableSats = Number(agent.capitalAvailableSats || 0);
  data.pendingDepositSats = Number(agent.pendingDepositSats || 0);
  data.lockedSats = Number(agent.lockedSats || 0);
  data.pendingCloseSats = Number(agent.pendingCloseSats || 0);
}

// Route stat helpers

function getStats(rk) {
  if (!routeStats.has(rk)) routeStats.set(rk, { activeAgents:0, inFlight:0, finished:0, status2xx:0, status4xx:0, status5xx:0 });
  return routeStats.get(rk);
}

function bumpFinished(rk, status) {
  const s = getStats(rk);
  s.finished++;
  if (status >= 500) s.status5xx++;
  else if (status >= 400) s.status4xx++;
  else if (status >= 200) s.status2xx++;
  const box = routeBoxes.get(rk);
  if (box) box.stats = s;
}

function updateBoxHeight(rk) {
  const box = routeBoxes.get(rk);
  if (!box) return;
  const agents = routeAgents.get(rk);
  const count = agents ? agents.size : 0;
  box.targetH = heightForAgentCount(count);
  box.stats.activeAgents = count;
}

function getSlotTracker(rk) {
  if (!routeSlots.has(rk)) routeSlots.set(rk, { slots: new Map(), free: [], next: 0 });
  return routeSlots.get(rk);
}

function allocSlot(rk, agentId) {
  const t = getSlotTracker(rk);
  if (t.slots.has(agentId)) return t.slots.get(agentId);
  const slot = t.free.length > 0 ? t.free.pop() : t.next++;
  t.slots.set(agentId, slot);
  return slot;
}

function freeSlot(rk, agentId) {
  const t = routeSlots.get(rk);
  if (!t) return;
  const slot = t.slots.get(agentId);
  if (slot !== undefined) {
    t.slots.delete(agentId);
    t.free.push(slot);
  }
}

function positionAgentAtSlot(agentId, rk, skipSettle) {
  const box = routeBoxes.get(rk);
  if (!box) return;
  const slot = allocSlot(rk, agentId);
  const data = agentMgr.agents.get(agentId);
  if (data) data.slot = slot;
  const yb = box.yBase || 0;

  if (skipSettle) {
    const p = gridSlotPos(box.pos, RW, RD, box.curH, slot, yb);
    agentMgr.setPos(agentId, p.x, p.y, p.z);
  } else {
    startSettle(agentId, box.pos.x, yb + 0.5, box.pos.z, rk);
  }
}

function moveAgentToRoute(agentId, newRk) {
  const oldRk = agentRoutes.get(agentId);
  if (oldRk === newRk) return;

  // Remove from old route
  if (oldRk) {
    const oldSet = routeAgents.get(oldRk);
    if (oldSet) {
      oldSet.delete(agentId);
      freeSlot(oldRk, agentId);
      updateBoxHeight(oldRk);
    }
  }

  // Add to new route
  agentRoutes.set(agentId, newRk);
  if (!routeAgents.has(newRk)) routeAgents.set(newRk, new Set());
  routeAgents.get(newRk).add(agentId);
  updateBoxHeight(newRk);
}

function setRouteActive(rk, active) {
  const box = routeBoxes.get(rk);
  if (box) box.mat.opacity = active ? styleState.routeActiveOp : styleState.routeIdleOp;
}

// Reposition all agents after layout switch

export function repositionAllAgents() {
  // Cancel in-flight animations
  for (const id of [...flightMgr.flights.keys()]) {
    flightMgr.land(id);
  }
  // Snap all agents to their new slot positions
  for (const [agentId, data] of agentMgr.agents) {
    if (!data.routeKey) continue;
    data.settleSt = undefined;
    const box = routeBoxes.get(data.routeKey);
    if (!box) continue;
    const p = gridSlotPos(box.pos, RW, RD, box.curH, data.slot ?? 0, box.yBase || 0);
    agentMgr.setPos(agentId, p.x, p.y, p.z);
  }
  agentMgr.commit();
}

// SSE client

export function connectSSE() {
  emitConnection(false, 'CONNECTING');
  const pullSnapshot = async () => {
    const res = await fetch('/api/journey', { cache: 'no-store' });
    if (!res.ok) return;
    applySnapshot(await res.json());
  };
  const es = new EventSource('/api/journey/events');
  es.onopen = () => {
    emitConnection(true, 'LIVE');
  };
  es.onmessage = (msg) => {
    let data;
    try { data = JSON.parse(msg.data); } catch { return; }
    emitConnection(true, 'LIVE');
    if (data.type === 'snapshot') applySnapshot(data.snapshot);
    else applyEvent(data);
  };
  es.onerror = () => {
    emitConnection(false, 'RETRYING');
  };
  setInterval(() => {
    pullSnapshot().catch(() => {});
  }, 15000);
}

function applySnapshot(snap) {
  // Merge — update route stats, add/update agents, but never release existing ones

  for (const r of snap.routes || []) {
    const entry = routeKeyMap.get(r.routeKey);
    if (!entry) continue;
    routeStats.set(r.routeKey, {
      activeAgents: r.activeAgents || 0, inFlight: r.inFlight || 0,
      finished: r.finished || 0, status2xx: r.status2xx || 0,
      status4xx: r.status4xx || 0, status5xx: r.status5xx || 0,
    });
    const box = routeBoxes.get(r.routeKey);
    if (box) {
      box.stats = routeStats.get(r.routeKey);
      box.mat.opacity = (r.activeAgents > 0 || r.inFlight > 0) ? styleState.routeActiveOp : styleState.routeIdleOp;
    }
  }

  for (const agent of snap.agents || []) {
    const entry = routeKeyMap.get(agent.routeKey);
    const box = routeBoxes.get(agent.routeKey);
    if (!entry || !box) continue;

    const existing = agentMgr.agents.has(agent.id);
    const data = agentMgr.acquire(agent.id);
    if (!data) continue;

    data.name = agent.name || data.name || null;
    data.routeKey = agent.routeKey;
    data.phase = entry.phase;
    if (agent.recent) data.recent = agent.recent.slice(0, 5);
    updateAgentFunding(data, agent);
    moveAgentToRoute(agent.id, agent.routeKey);

    positionAgentAtSlot(agent.id, agent.routeKey, existing);
    agentMgr.setColor(agent.id, entry.phase);
  }
  agentMgr.commit();

  if (onSnapshotHUD) onSnapshotHUD(snap.stats);
}

function applyEvent(ev) {
  eventTimestamps.push(Date.now());

  if (ev.event === 'registration_attempt' && ev.agent_id) {
    const rk = ev.routeKey || 'POST /api/v1/agents/register';
    const entry = routeKeyMap.get(rk);
    const box = routeBoxes.get(rk);
    if (!entry || !box) return;

    const data = agentMgr.acquire(ev.agent_id);
    if (!data) return;
    data.name = ev.agent?.name || ev.agent_name || data.name || null;
    data.routeKey = rk;
    data.phase = entry.phase;
    updateAgentFunding(data, ev.agent);
    moveAgentToRoute(ev.agent_id, rk);

    positionAgentAtSlot(ev.agent_id, rk);
    agentMgr.setColor(ev.agent_id, entry.phase);
    agentMgr.commit();

    bumpFinished(rk, 201);
    setRouteActive(rk, true);
    if (ev.agent) updateAgentRecent(ev.agent_id, ev.agent);
  }

  if (ev.event === 'request_start' && ev.agent_id) {
    const toKey = ev.routeKey;
    const toEntry = routeKeyMap.get(toKey);
    const toBox = routeBoxes.get(toKey);
    if (!toEntry || !toBox) return;

    const fromKey = agentRoutes.get(ev.agent_id);
    const fromBox = fromKey ? routeBoxes.get(fromKey) : null;

    let data = agentMgr.agents.get(ev.agent_id);
    if (!data) {
      data = agentMgr.acquire(ev.agent_id);
      if (!data) return;
    }

    data.name = ev.agent?.name || ev.agent_name || data.name || null;
    data.routeKey = toKey;
    data.phase = toEntry.phase;
    updateAgentFunding(data, ev.agent);
    moveAgentToRoute(ev.agent_id, toKey);
    agentMgr.setColor(ev.agent_id, toEntry.phase);

    // Always allocate slot (even for flights — land() needs it)
    const slot = allocSlot(toKey, ev.agent_id);
    data.slot = slot;

    if (fromBox && fromBox !== toBox && !flightMgr.has(ev.agent_id)) {
      const fp = new THREE.Vector3(fromBox.pos.x, 1.5, fromBox.pos.z);
      const tp = new THREE.Vector3(toBox.pos.x, 1.5, toBox.pos.z);
      flightMgr.start(ev.agent_id, fp, tp, toKey, performance.now());
    } else if (!flightMgr.has(ev.agent_id)) {
      positionAgentAtSlot(ev.agent_id, toKey);
    }
    agentMgr.commit();

    setRouteActive(toKey, true);
    if (ev.agent) updateAgentRecent(ev.agent_id, ev.agent);
  }

  if (ev.event === 'request_finish') {
    const rk = ev.routeKey;
    const status = ev.status || 200;
    bumpFinished(rk, status);
    setRouteActive(rk, true);

    if (ev.agent_id) {
      const entry = routeKeyMap.get(rk);
      const box = routeBoxes.get(rk);
      if (!entry || !box) return;

      let data = agentMgr.agents.get(ev.agent_id);
      if (!data) {
        data = agentMgr.acquire(ev.agent_id);
        if (!data) return;
      }
      data.name = ev.agent?.name || ev.agent_name || data.name || null;
      data.routeKey = rk;
      data.phase = entry.phase;
      updateAgentFunding(data, ev.agent);
      moveAgentToRoute(ev.agent_id, rk);
      agentMgr.setColor(ev.agent_id, entry.phase);

      // Always allocate slot (idempotent if already done by request_start)
      const slot = allocSlot(rk, ev.agent_id);
      data.slot = slot;
      if (!flightMgr.has(ev.agent_id)) {
        positionAgentAtSlot(ev.agent_id, rk);
      }
      agentMgr.commit();
      if (ev.agent) updateAgentRecent(ev.agent_id, ev.agent);
    }
  }

  if (ev.event === 'agent_bound' && ev.agent_id && ev.routeKey) {
    const entry = routeKeyMap.get(ev.routeKey);
    if (entry) {
      let data = agentMgr.agents.get(ev.agent_id);
      if (!data) {
        data = agentMgr.acquire(ev.agent_id);
        if (!data) return;
      }
      data.name = ev.agent?.name || ev.agent_name || data.name || null;
      data.routeKey = ev.routeKey;
      data.phase = entry.phase;
      updateAgentFunding(data, ev.agent);
      moveAgentToRoute(ev.agent_id, ev.routeKey);
      positionAgentAtSlot(ev.agent_id, ev.routeKey);
      agentMgr.setColor(ev.agent_id, entry.phase);
      agentMgr.commit();
    }
  }
}

function updateAgentRecent(agentId, agentData) {
  const data = agentMgr.agents.get(agentId);
  if (data && agentData.recent) {
    data.recent = agentData.recent.slice(0, 5).map(r => ({
      routeKey: r.routeKey || r.key,
      routePath: r.routePath || r.path,
    }));
  }
}
