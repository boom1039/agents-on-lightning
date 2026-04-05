import { TOTAL_ROUTES } from './manifest.js';
import { routeStats, getEventsPerSecond, onSnapshot } from './events.js';
import { agentMgr, flightMgr } from './agents.js';
import { phaseBadges, updateSpriteText } from './builder.js';

const hudAgents = document.getElementById('hud-agents');
const hudInflight = document.getElementById('hud-inflight');
const hudEps = document.getElementById('hud-eps');
const hudActive = document.getElementById('hud-active');

function updateHUD(stats) {
  hudAgents.textContent = stats?.agents ?? agentMgr.agents.size;
  hudInflight.textContent = stats?.inFlight ?? flightMgr.inflightCount;
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
  hudActive.textContent = `0/${TOTAL_ROUTES}`;

  // Simulate button
  let simulating = false;
  const simBtn = document.getElementById('btn-simulate');

  simBtn.addEventListener('click', async () => {
    try {
      if (simulating) {
        await fetch('/api/demo/synthetic/stop', { method: 'POST' });
        simulating = false;
        simBtn.textContent = 'SIMULATE';
        simBtn.classList.remove('active');
      } else {
        await fetch('/api/demo/synthetic/start', { method: 'POST' });
        simulating = true;
        simBtn.textContent = 'STOP';
        simBtn.classList.add('active');
      }
    } catch (e) { console.error('sim toggle:', e); }
  });

  // Check if already simulating
  fetch('/api/demo/synthetic').then(r => r.json()).then(s => {
    if (s.running) { simulating = true; simBtn.textContent = 'STOP'; simBtn.classList.add('active'); }
  }).catch(() => {});
}
