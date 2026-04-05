import * as THREE from 'three';
import { styleState, hexFromThree } from './constants.js';
import { getPhaseName } from './manifest.js';
import { renderer, camera, controls, grid, bloomPass } from './scene.js';
import { routeBoxes, routeMeshArr, phaseGroups, sgGroups, phaseMats, sgMats,
         phaseHitArr, routeHitMap, labelStore, phaseLabelArr, phaseBadges,
         syncBadgePositions, applyPhaseRouteAnchor, routeLabelArr, flipRouteLabel } from './builder.js';
import { agentMgr } from './agents.js';
import { LAYOUT_NAMES, LAYOUTS } from './layouts.js';

const raycaster = new THREE.Raycaster();
const pointer = new THREE.Vector2();
const tooltipEl = document.getElementById('tooltip');
const dragHint = document.getElementById('drag-hint');

let isDragging = false;
let mouseDown = { x: 0, y: 0 };

// Drag state
const dragPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
const dragIntersect = new THREE.Vector3();
let dragOffset = new THREE.Vector3();
let dragActive = null;
const undoStack = [];
const sgHitArr = [];
const ROUTE_ANCHOR_CYCLE = ['bl', 'br'];

// Shared hint helper (used by drag, undo, keyboard dumps)
function showHint(text, duration = 2000) {
  dragHint.style.display = 'block';
  dragHint.textContent = text;
  setTimeout(() => { dragHint.style.display = 'none'; }, duration);
}

function copyToClipboard(label, json) {
  navigator.clipboard.writeText(json).then(() => {
    showHint(`${label} copied to clipboard!`);
  }).catch(() => {
    console.log(`${label}:\n`, json);
    showHint(`${label} logged to console (clipboard blocked)`);
  });
}

// Tooltips

function showRouteTooltip(rb, mx, my) {
  const s = rb.stats;
  tooltipEl.innerHTML = `
    <div class="tt-title">${rb.entry.method} ${rb.entry.path}</div>
    <div class="tt-dim">Domain ${getPhaseName(rb.entry.phase)} &rsaquo; ${rb.entry.subgroup}</div>
    <hr>
    <div>Agents inside: ${s.activeAgents} &middot; In-flight: ${s.inFlight}</div>
    <div>2xx: ${s.status2xx} &middot; 4xx: ${s.status4xx} &middot; 5xx: ${s.status5xx}</div>
    <div class="tt-dim">Requests: ${s.finished} &middot; Height: ${rb.curH.toFixed(1)}</div>
  `;
  positionTooltip(mx, my);
}

function showAgentTooltip(agentId, mx, my) {
  const data = agentMgr.agents.get(agentId);
  if (!data) return;
  const recentStr = data.recent.length > 0
    ? data.recent.map(r => r.routePath || r.routeKey).slice(0, 3).join(' &rarr; ')
    : 'none';
  tooltipEl.innerHTML = `
    <div class="tt-title">${data.name || agentId}</div>
    <div>ID: ${agentId}</div>
    <div>Route: ${data.routeKey || 'unknown'}</div>
    <div>Domain: ${getPhaseName(data.phase)} &middot; Slot: ${data.slot ?? '?'}</div>
    <div class="tt-dim">Recent: ${recentStr}</div>
  `;
  positionTooltip(mx, my);
}

function positionTooltip(mx, my) {
  tooltipEl.style.display = 'block';
  const pad = 15;
  let left = mx + pad;
  let top = my + pad;
  if (left + tooltipEl.offsetWidth > window.innerWidth - 10) left = mx - tooltipEl.offsetWidth - pad;
  if (top + tooltipEl.offsetHeight > window.innerHeight - 10) top = my - tooltipEl.offsetHeight - pad;
  tooltipEl.style.left = left + 'px';
  tooltipEl.style.top = top + 'px';
}

// Drag — find target at cursor

function findDragTarget() {
  // Phase label — layer 5 (drag label + badge together)
  raycaster.layers.set(5);
  const plHits = raycaster.intersectObjects(phaseLabelArr, false);
  if (plHits.length > 0) {
    const p = plHits[0].object.userData.phase;
    const badge = phaseBadges.get(p);
    const objs = [plHits[0].object];
    if (badge) objs.push(badge);
      return { kind: 'phaseLabel', key: p, objects: objs, routeKeys: [], label: `${getPhaseName(p)} label` };
  }
  // Route (most specific) — layer 1
  raycaster.layers.set(1);
  const rHits = raycaster.intersectObjects(routeMeshArr, false);
  if (rHits.length > 0) {
    const rk = routeHitMap.get(rHits[0].object);
    if (rk) {
      const rb = routeBoxes.get(rk);
      return { kind: 'route', key: rk, objects: [rb.mesh, rb.hitMesh, rb.label], routeKeys: [rk], label: `Route: ${rb.entry.endpoint}` };
    }
  }
  // Subgroup — layer 3
  raycaster.layers.set(3);
  const sgHits = raycaster.intersectObjects(sgHitArr, false);
  if (sgHits.length > 0) {
    const sgKey = sgHits[0].object.userData.sgKey;
    const sg = sgGroups.get(sgKey);
    if (sg) return { kind: 'sg', key: sgKey, objects: [sg.group], routeKeys: [...sg.routes], label: `Subgroup: ${sg.sgName} (${getPhaseName(sg.phase)})` };
  }
  // Phase — layer 4
  raycaster.layers.set(4);
  const phHits = raycaster.intersectObjects(phaseHitArr, false);
  if (phHits.length > 0) {
    const p = phHits[0].object.userData.phase;
    const group = phaseGroups.get(p);
    if (group) {
      const rks = [];
      for (const [, sg] of sgGroups) { if (sg.phase === p) rks.push(...sg.routes); }
      return { kind: 'phase', key: p, objects: [group], routeKeys: rks, label: `Domain: ${getPhaseName(p)}` };
    }
  }
  return null;
}

function startDrag(target) {
  const routePosBefore = new Map();
  for (const rk of target.routeKeys) {
    const rb = routeBoxes.get(rk);
    if (rb) routePosBefore.set(rk, rb.pos.clone());
  }
  dragActive = {
    ...target,
    startPositions: target.objects.map(o => o.position.clone()),
    routePosBefore,
  };
  raycaster.ray.intersectPlane(dragPlane, dragIntersect);
  dragOffset.copy(dragIntersect).sub(target.objects[0].position);
  controls.enabled = false;
  showHint(`Dragging: ${target.label}`, 60000);
  document.body.classList.add('sg-dragging');
}

function updateDrag(e) {
  if (!dragActive) return;
  pointer.x = (e.clientX / window.innerWidth) * 2 - 1;
  pointer.y = -(e.clientY / window.innerHeight) * 2 + 1;
  raycaster.setFromCamera(pointer, camera);
  raycaster.ray.intersectPlane(dragPlane, dragIntersect);
  const dx = dragIntersect.x - dragOffset.x - dragActive.startPositions[0].x;
  const dz = dragIntersect.z - dragOffset.z - dragActive.startPositions[0].z;
  for (let i = 0; i < dragActive.objects.length; i++) {
    dragActive.objects[i].position.x = dragActive.startPositions[i].x + dx;
    dragActive.objects[i].position.z = dragActive.startPositions[i].z + dz;
  }
}

function endDrag() {
  if (!dragActive) return;
  const dx = dragActive.objects[0].position.x - dragActive.startPositions[0].x;
  const dz = dragActive.objects[0].position.z - dragActive.startPositions[0].z;

  if (Math.abs(dx) < 0.01 && Math.abs(dz) < 0.01) {
    dragActive = null;
    controls.enabled = true;
    document.body.classList.remove('sg-dragging');
    dragHint.style.display = 'none';
    return;
  }

  const delta = new THREE.Vector3(dx, 0, dz);
  undoStack.push({
    objects: dragActive.objects,
    startPositions: dragActive.startPositions,
    routePosBefore: dragActive.routePosBefore,
    label: dragActive.label,
  });

  for (const rk of dragActive.routeKeys) {
    const rb = routeBoxes.get(rk);
    if (rb) rb.pos.add(delta);
  }

  dragActive = null;
  controls.enabled = true;
  document.body.classList.remove('sg-dragging');
  dragHint.style.display = 'none';
}

function undoLast() {
  const entry = undoStack.pop();
  if (!entry) { showHint('Nothing to undo', 1200); return; }
  for (let i = 0; i < entry.objects.length; i++) {
    entry.objects[i].position.copy(entry.startPositions[i]);
  }
  for (const [rk, pos] of entry.routePosBefore) {
    const rb = routeBoxes.get(rk);
    if (rb) rb.pos.copy(pos);
  }
  showHint(`Undo: ${entry.label}`, 1500);
}

// Keyboard dumps — D (layout), S (style), C (camera)

function dumpLayout() {
  const r2 = (v) => Math.round(v * 100) / 100;
  const dump = {};
  // Phase label positions
  const phaseLabels = {};
  for (const pl of labelStore.phase) {
    const p = pl.userData.phase;
    if (p !== undefined) phaseLabels[p] = { x: r2(pl.position.x), z: r2(pl.position.z) };
  }
  dump._phaseLabels = phaseLabels;
  // Subgroups and routes
  for (const [sgKey, sg] of sgGroups) {
    const gp = sg.group.position;
    dump[sgKey] = {
      phase: sg.phase, subgroup: sg.sgName,
      offset: { x: r2(gp.x), y: r2(gp.y), z: r2(gp.z) },
      routes: sg.routes.map(rk => {
        const rb = routeBoxes.get(rk);
        return rb ? { routeKey: rk, x: r2(rb.pos.x), z: r2(rb.pos.z) } : { routeKey: rk };
      }),
    };
  }
  copyToClipboard('Layout JSON', JSON.stringify(dump, null, 2));
}

function dumpStyle() {
  const h = (c) => hexFromThree(c);
  const firstRoute = routeBoxes.values().next().value;
  const styleDump = {
    bg: h(renderer.getClearColor(new THREE.Color())),
    grid: h(grid.material.color),
    gridOp: Math.round(grid.material.opacity * 100) / 100,
    bloomStr: Math.round(bloomPass.strength * 100) / 100,
    bloomRad: Math.round(bloomPass.radius * 100) / 100,
    bloomThr: Math.round(bloomPass.threshold * 100) / 100,
    phaseBox: phaseMats[0] ? h(phaseMats[0].color) : null,
    phaseBoxOp: phaseMats[0] ? Math.round(phaseMats[0].opacity * 100) / 100 : null,
    sgBox: sgMats[0] ? h(sgMats[0].color) : null,
    sgBoxOp: sgMats[0] ? Math.round(sgMats[0].opacity * 100) / 100 : null,
    routeBox: firstRoute ? h(firstRoute.mat.color) : null,
    routeActiveOp: styleState.routeActiveOp,
    routeIdleOp: styleState.routeIdleOp,
    agentShape: agentMgr.shapeName,
    agentWire: h(agentMgr.mesh.material.color),
    trail: styleState.trail.map(v => Math.round(v * 100) / 100),
    trailOp: styleState.trailOp,
    flightSpeed: styleState.flightSpeed,
    labelPhase: labelStore.phase[0] ? h(labelStore.phase[0].material.color) : '#e4e4e7',
    labelPhaseSize: labelStore.phase[0]?.userData._baseHeight || 2.0,
    labelPhaseY: labelStore.phase[0] ? Math.round((labelStore.phase[0].position.y - labelStore.phase[0].userData.baseY) * 100) / 100 : 0,
    labelPhaseAnchor: styleState.anchorPhase,
    labelBadge: labelStore.phaseBadge[0] ? h(labelStore.phaseBadge[0].material.color) : '#a1a1aa',
    labelBadgeSize: labelStore.phaseBadge[0]?.userData._baseHeight || 1.0,
    labelBadgeY: styleState.badgeYFromLabel,
    labelSg: labelStore.sg[0] ? h(labelStore.sg[0].material.color) : '#a1a1aa',
    labelSgSize: labelStore.sg[0]?.userData._baseHeight || 0.7,
    labelSgY: labelStore.sg[0] ? Math.round((labelStore.sg[0].position.y - labelStore.sg[0].userData.baseY) * 100) / 100 : 0,
    labelSgAnchor: styleState.anchorSg,
    labelRoute: labelStore.route[0] ? h(labelStore.route[0].material.color) : '#888888',
    labelRouteSize: labelStore.route[0]?.userData._baseHeight || 0.35,
    labelRouteY: labelStore.route[0] ? Math.round((labelStore.route[0].position.y - labelStore.route[0].userData.baseY) * 100) / 100 : 0,
    labelRouteAnchor: styleState.anchorRoute,
  };
  copyToClipboard('Style JSON', JSON.stringify(styleDump, null, 2));
}

function dumpCamera() {
  const r2 = (v) => Math.round(v * 100) / 100;
  const camDump = {
    position: { x: r2(camera.position.x), y: r2(camera.position.y), z: r2(camera.position.z) },
    target: { x: r2(controls.target.x), y: r2(controls.target.y), z: r2(controls.target.z) },
    fov: camera.fov,
  };
  copyToClipboard('Camera JSON', JSON.stringify(camDump, null, 2));
}

// Refresh after layout rebuild (repopulates hit arrays)
export function refreshInteraction() {
  sgHitArr.length = 0;
  for (const [, sg] of sgGroups) sgHitArr.push(sg.hit);
}

// Event listener setup

export function initInteraction() {
  // Populate subgroup hit array for drag detection
  for (const [, sg] of sgGroups) sgHitArr.push(sg.hit);

  // Mouse handlers (combined tooltip + drag)
  renderer.domElement.addEventListener('mousedown', (e) => {
    mouseDown = { x: e.clientX, y: e.clientY };
    isDragging = false;

    if (e.shiftKey) {
      pointer.x = (e.clientX / window.innerWidth) * 2 - 1;
      pointer.y = -(e.clientY / window.innerHeight) * 2 + 1;
      raycaster.setFromCamera(pointer, camera);
      const target = findDragTarget();
      if (target) { startDrag(target); e.preventDefault(); e.stopPropagation(); }
    }
  });

  renderer.domElement.addEventListener('mousemove', (e) => {
    if (dragActive) { updateDrag(e); e.preventDefault(); return; }

    if (Math.abs(e.clientX - mouseDown.x) + Math.abs(e.clientY - mouseDown.y) > 5) isDragging = true;
    if (isDragging) { tooltipEl.style.display = 'none'; return; }

    pointer.x = (e.clientX / window.innerWidth) * 2 - 1;
    pointer.y = -(e.clientY / window.innerHeight) * 2 + 1;
    raycaster.setFromCamera(pointer, camera);

    // Check route boxes
    raycaster.layers.set(1);
    const routeHits = raycaster.intersectObjects(routeMeshArr, false);
    if (routeHits.length > 0) {
      const hit = routeHits[0].object;
      for (const [, rb] of routeBoxes) {
        if (rb.hitMesh === hit) { showRouteTooltip(rb, e.clientX, e.clientY); return; }
      }
    }

    // Check agents
    raycaster.layers.set(2);
    const agentHits = raycaster.intersectObject(agentMgr.mesh, false);
    if (agentHits.length > 0) {
      const instId = agentHits[0].instanceId;
      const agentId = agentMgr.idxToAgent.get(instId);
      if (agentId) { showAgentTooltip(agentId, e.clientX, e.clientY); return; }
    }

    tooltipEl.style.display = 'none';
  });

  renderer.domElement.addEventListener('mouseup', () => { if (dragActive) endDrag(); });
  renderer.domElement.addEventListener('mouseleave', () => { tooltipEl.style.display = 'none'; });

  // Double-click: route label → flip that label; phase label/box → flip all route labels in phase
  renderer.domElement.addEventListener('dblclick', (e) => {
    pointer.x = (e.clientX / window.innerWidth) * 2 - 1;
    pointer.y = -(e.clientY / window.innerHeight) * 2 + 1;
    raycaster.setFromCamera(pointer, camera);

    // Single route label — layer 6
    raycaster.layers.set(6);
    const rlHit = raycaster.intersectObjects(routeLabelArr, false);
    if (rlHit.length > 0) {
      flipRouteLabel(rlHit[0].object);
      e.preventDefault();
      return;
    }

    // Phase label or box — flip all route labels in that phase
    let phase = null;
    raycaster.layers.set(5);
    const plHit = raycaster.intersectObjects(phaseLabelArr, false);
    if (plHit.length > 0) { phase = plHit[0].object.userData.phase; }
    else {
      raycaster.layers.set(4);
      const phHit = raycaster.intersectObjects(phaseHitArr, false);
      if (phHit.length > 0) phase = phHit[0].object.userData.phase;
    }
    if (phase !== null) {
      const cur = styleState.phaseRouteAnchors[phase] || styleState.anchorRoute;
      const idx = ROUTE_ANCHOR_CYCLE.indexOf(cur);
      const next = ROUTE_ANCHOR_CYCLE[(idx + 1) % ROUTE_ANCHOR_CYCLE.length];
      styleState.phaseRouteAnchors[phase] = next;
      applyPhaseRouteAnchor(phase, next);
      showHint(`${getPhaseName(phase)} routes → ${next.includes('l') ? 'left' : 'right'}`, 1500);
      e.preventDefault();
    }
  });

  // Keyboard shortcuts
  document.addEventListener('keydown', (e) => {
    if (e.key === 'z' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); undoLast(); return; }
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
    if (e.key === 's' || e.key === 'S') dumpStyle();
    else if (e.key === 'c' || e.key === 'C') dumpCamera();
    else if (e.key === 'd' || e.key === 'D') dumpLayout();
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      e.preventDefault();
      if (window.switchLayout) {
        const cur = window._currentLayout || 'default';
        const idx = LAYOUT_NAMES.indexOf(cur);
        const dir = e.key === 'ArrowRight' ? 1 : -1;
        const next = LAYOUT_NAMES[(idx + dir + LAYOUT_NAMES.length) % LAYOUT_NAMES.length];
        window.switchLayout(next);
      }
    }
  });
}
