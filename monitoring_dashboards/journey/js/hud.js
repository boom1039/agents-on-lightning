import { TOTAL_ROUTES } from './manifest.js';
import { routeStats, getEventsPerSecond, onConnection, onSnapshot } from './events.js';
import { agentMgr, flightMgr } from './agents.js';
import { phaseBadges, updateSpriteText } from './builder.js';

const hudAgents = document.getElementById('hud-agents');
const hudInflight = document.getElementById('hud-inflight');
const hudEps = document.getElementById('hud-eps');
const hudActive = document.getElementById('hud-active');
const hudLive = document.getElementById('hud-live');

function updateHUD(stats) {
  hudAgents.textContent = stats?.agents ?? agentMgr.agents.size;
  hudInflight.textContent = stats?.inFlight ?? flightMgr.inflightCount;
}

function updateConnectionHUD(state) {
  if (!hudLive) return;
  hudLive.textContent = state?.label || 'CONNECTING';
  hudLive.style.color = state?.connected ? '#4ade80' : '#f59e0b';
}

export function refreshHUD() {
  hudAgents.textContent = agentMgr.agents.size;
  hudInflight.textContent = flightMgr.inflightCount;
  hudEps.textContent = getEventsPerSecond();

  let active = 0;
  for (const [, s] of routeStats) {
    if (s.finished > 0 || s.activeAgents > 0 || s.inFlight > 0) active++;
  }
  hudActive.textContent = `${active}/${TOTAL_ROUTES}`;

  // Phase badges — count agents per journey phase (1–10)
  const counts = new Map();
  for (const [, data] of agentMgr.agents) {
    if (data.phase >= 1 && data.phase <= 10) {
      counts.set(data.phase, (counts.get(data.phase) || 0) + 1);
    }
  }
  for (const [p, sprite] of phaseBadges) {
    const n = counts.get(p) || 0;
    updateSpriteText(sprite, `[${n} agent${n === 1 ? '' : 's'}]`);
  }
}

export function initHUD() {
  // Register for SSE snapshot updates
  onSnapshot(updateHUD);
  onConnection(updateConnectionHUD);
  hudActive.textContent = `0/${TOTAL_ROUTES}`;
  updateConnectionHUD({ connected: false, label: 'CONNECTING' });

  // Simulate button
  let simulating = false;
  const simBtn = document.getElementById('btn-simulate');

  simBtn.addEventListener('click', async () => {
    try {
      if (simulating) {
        const res = await fetch('/api/demo/synthetic/stop', { method: 'POST' });
        if (!res.ok) throw new Error('synthetic unavailable');
        simulating = false;
        simBtn.textContent = 'SIMULATE';
        simBtn.classList.remove('active');
      } else {
        const res = await fetch('/api/demo/synthetic/start', { method: 'POST' });
        if (!res.ok) throw new Error('synthetic unavailable');
        simulating = true;
        simBtn.textContent = 'STOP';
        simBtn.classList.add('active');
      }
    } catch (e) {
      simBtn.disabled = true;
      simBtn.title = 'Synthetic traffic is local-only';
      console.error('sim toggle:', e);
    }
  });

  // Check if already simulating
  fetch('/api/demo/synthetic').then(async (r) => {
    if (!r.ok) throw new Error('synthetic unavailable');
    return r.json();
  }).then(s => {
    if (s.running) { simulating = true; simBtn.textContent = 'STOP'; simBtn.classList.add('active'); }
  }).catch(() => {
    simBtn.disabled = true;
    simBtn.title = 'Synthetic traffic is local-only';
  });
}
