import * as THREE from 'three';
import { WIRE, styleState, ANCHORS, ANCHOR_LABELS, hexFromThree } from './constants.js';
import { renderer, grid, bloomPass } from './scene.js';
import { phaseMats, sgMats, routeBoxes, labelStore,
         applyAnchor, syncBadgePositions } from './builder.js';
import { agentMgr, SHAPE_NAMES } from './agents.js';

function rebuildLayout() { if (window.switchLayout) window.switchLayout(window._currentLayout); }

const stylePanel = document.getElementById('style-panel');
const styleToggle = document.getElementById('style-toggle');

styleToggle.addEventListener('click', () => {
  stylePanel.classList.toggle('open');
  styleToggle.textContent = stylePanel.classList.contains('open') ? 'Close' : 'Style';
});

export function buildStylePanel() {
  const knobs = [
    { section: 'Scene' },
    { id: 'bg', label: 'Background', type: 'color', get: () => hexFromThree(renderer.getClearColor(new THREE.Color())), set: (v) => { renderer.setClearColor(new THREE.Color(v)); document.body.style.background = v; } },
    { id: 'gridColor', label: 'Grid', type: 'color', get: () => hexFromThree(grid.material.color), set: (v) => grid.material.color.set(v) },
    { id: 'gridOpacity', label: 'Grid opacity', type: 'range', min: 0, max: 1, step: 0.01, get: () => grid.material.opacity, set: (v) => { grid.material.opacity = v; } },
    { id: 'bloomStr', label: 'Bloom strength', type: 'range', min: 0, max: 1, step: 0.01, get: () => bloomPass.strength, set: (v) => { bloomPass.strength = v; } },
    { id: 'bloomRad', label: 'Bloom radius', type: 'range', min: 0, max: 2, step: 0.01, get: () => bloomPass.radius, set: (v) => { bloomPass.radius = v; } },
    { id: 'bloomThr', label: 'Bloom threshold', type: 'range', min: 0, max: 1, step: 0.01, get: () => bloomPass.threshold, set: (v) => { bloomPass.threshold = v; } },
    { section: 'Boxes' },
    { id: 'phaseBox', label: 'Phase box', type: 'color', get: () => hexFromThree(phaseMats[0]?.color || WIRE), set: (v) => phaseMats.forEach(m => m.color.set(v)) },
    { id: 'phaseBoxOp', label: 'Phase opacity', type: 'range', min: 0, max: 1, step: 0.01, get: () => phaseMats[0]?.opacity ?? 0.02, set: (v) => phaseMats.forEach(m => { m.opacity = v; }) },
    { id: 'sgBox', label: 'Subgroup box', type: 'color', get: () => hexFromThree(sgMats[0]?.color || WIRE), set: (v) => sgMats.forEach(m => m.color.set(v)) },
    { id: 'sgBoxOp', label: 'Subgroup opacity', type: 'range', min: 0, max: 1, step: 0.01, get: () => sgMats[0]?.opacity ?? 0, set: (v) => sgMats.forEach(m => { m.opacity = v; }) },
    { id: 'routeBox', label: 'Route box', type: 'color',
      get: () => { const first = routeBoxes.values().next().value; return first ? hexFromThree(first.mat.color) : '#52525b'; },
      set: (v) => { for (const [,rb] of routeBoxes) rb.mat.color.set(v); } },
    { id: 'routeBoxActiveOp', label: 'Route active opacity', type: 'range', min: 0, max: 1, step: 0.01, get: () => 1, set: (v) => { styleState.routeActiveOp = v; } },
    { id: 'routeBoxIdleOp', label: 'Route idle opacity', type: 'range', min: 0, max: 1, step: 0.01, get: () => 1, set: (v) => { styleState.routeIdleOp = v; } },
    { section: 'Agents' },
    { id: 'agentShape', label: 'Shape', type: 'select', options: SHAPE_NAMES,
      get: () => agentMgr.shapeName,
      set: (v) => agentMgr.swapGeometry(v) },
    { id: 'agentWire', label: 'Agent color', type: 'color', get: () => hexFromThree(agentMgr.mesh.material.color), set: (v) => agentMgr.mesh.material.color.set(v) },
    { id: 'trailColor', label: 'Flight trail', type: 'color', get: () => '#a30202', set: (v) => { const c = new THREE.Color(v); styleState.trail = [c.r, c.g, c.b]; } },
    { id: 'trailOp', label: 'Trail opacity', type: 'range', min: 0, max: 1, step: 0.01, get: () => 1, set: (v) => { styleState.trailOp = v; } },
    { id: 'flightSpeed', label: 'Flight speed', type: 'range', min: 0.1, max: 5, step: 0.1, get: () => styleState.flightSpeed, set: (v) => { styleState.flightSpeed = v; } },
    { section: 'Spacing & Visibility' },
    { id: 'phaseGap', label: 'Phase gap', type: 'range', min: 0.2, max: 6, step: 0.1,
      get: () => styleState.phaseGap, set: (v) => { styleState.phaseGap = v; rebuildLayout(); } },
    { id: 'routeGap', label: 'Route gap', type: 'range', min: 0.1, max: 2, step: 0.05,
      get: () => styleState.routeGap, set: (v) => { styleState.routeGap = v; rebuildLayout(); } },
    { id: 'sgGap', label: 'Subgroup gap', type: 'range', min: 0.1, max: 3, step: 0.1,
      get: () => styleState.sgGap, set: (v) => { styleState.sgGap = v; rebuildLayout(); } },
    { id: 'agentScale', label: 'Agent scale', type: 'range', min: 0.5, max: 3, step: 0.1,
      get: () => styleState.agentScale,
      set: (v) => { styleState.agentScale = v; agentMgr.swapGeometry(agentMgr.shapeName, true); } },
    { id: 'agentYLift', label: 'Agent Y lift', type: 'range', min: -0.5, max: 2, step: 0.05,
      get: () => styleState.agentYLift, set: (v) => { styleState.agentYLift = v; } },
    { id: 'boxMinH', label: 'Box height min', type: 'range', min: 0.05, max: 1, step: 0.05,
      get: () => styleState.boxMinH, set: (v) => { styleState.boxMinH = v; for (const [,rb] of routeBoxes) if (rb.stats.activeAgents === 0) rb.targetH = v; } },
    { id: 'boxMaxH', label: 'Box height max', type: 'range', min: 0.5, max: 5, step: 0.1,
      get: () => styleState.boxMaxH, set: (v) => { styleState.boxMaxH = v; } },
    { id: 'routeLabelZOff', label: 'Route label Z', type: 'range', min: -3, max: 3, step: 0.1,
      get: () => styleState.routeLabelZOff,
      set: (v) => { styleState.routeLabelZOff = v; labelStore.route.forEach(l => { if (l.userData.baseZ !== undefined) l.position.z = l.userData.baseZ + v; }); } },
    { section: 'Label Presets', presets: true },
    { section: 'Phase Labels' },
    { id: 'labelPhaseVis', label: 'Visible', type: 'toggle', get: () => true,
      set: (v) => labelStore.phase.forEach(l => { l.visible = v; }) },
    { id: 'labelPhase', label: 'Color', type: 'color', get: () => '#e4e4e7',
      set: (v) => labelStore.phase.forEach(l => { l.material.color.set(v); }) },
    { id: 'labelPhaseSize', label: 'Size', type: 'range', min: 0.5, max: 5, step: 0.1,
      get: () => 2.0,
      set: (v) => labelStore.phase.forEach(l => { l.userData._baseHeight = v; l.scale.set(v * l.userData._aspect, v, 1); }) },
    { id: 'labelPhaseY', label: 'Y offset', type: 'range', min: -5, max: 15, step: 0.1,
      get: () => 0,
      set: (v) => { labelStore.phase.forEach(l => { l.position.y = l.userData.baseY + v; }); syncBadgePositions(); } },
    { id: 'labelPhaseAnchor', label: 'Anchor', type: 'select', options: ANCHORS, optionLabels: ANCHOR_LABELS,
      get: () => styleState.anchorPhase,
      set: (v) => { styleState.anchorPhase = v; applyAnchor('phase', v); } },
    { section: 'Phase Badges' },
    { id: 'labelBadgeVis', label: 'Visible', type: 'toggle', get: () => true,
      set: (v) => labelStore.phaseBadge.forEach(l => { l.visible = v; }) },
    { id: 'labelBadge', label: 'Color', type: 'color', get: () => '#a1a1aa',
      set: (v) => labelStore.phaseBadge.forEach(l => { l.material.color.set(v); }) },
    { id: 'labelBadgeSize', label: 'Size', type: 'range', min: 0.3, max: 3, step: 0.1,
      get: () => 1.2,
      set: (v) => labelStore.phaseBadge.forEach(l => { l.userData._baseHeight = v; l.scale.set(v * l.userData._aspect, v, 1); }) },
    { id: 'labelBadgeY', label: 'Y from label', type: 'range', min: -5, max: 5, step: 0.1,
      get: () => -1.3,
      set: (v) => { styleState.badgeYFromLabel = v; labelStore.phaseBadge.forEach(l => { l.userData.yOffsetFromLabel = v; }); syncBadgePositions(); } },
    { section: 'Subgroup Labels' },
    { id: 'labelSgVis', label: 'Visible', type: 'toggle', get: () => true,
      set: (v) => labelStore.sg.forEach(l => { l.visible = v; }) },
    { id: 'labelSg', label: 'Color', type: 'color', get: () => '#a1a1aa',
      set: (v) => labelStore.sg.forEach(l => { l.material.color.set(v); }) },
    { id: 'labelSgSize', label: 'Size', type: 'range', min: 0.2, max: 3, step: 0.1,
      get: () => 1.1,
      set: (v) => labelStore.sg.forEach(l => { l.userData._baseHeight = v; l.scale.set(v * l.userData._aspect, v, 1); }) },
    { id: 'labelSgY', label: 'Y offset', type: 'range', min: -5, max: 15, step: 0.1,
      get: () => 0,
      set: (v) => labelStore.sg.forEach(l => { l.position.y = l.userData.baseY + v; }) },
    { id: 'labelSgAnchor', label: 'Anchor', type: 'select', options: ANCHORS, optionLabels: ANCHOR_LABELS,
      get: () => styleState.anchorSg,
      set: (v) => { styleState.anchorSg = v; applyAnchor('sg', v); } },
    { section: 'Route Labels' },
    { id: 'labelRouteVis', label: 'Visible', type: 'toggle', get: () => true,
      set: (v) => labelStore.route.forEach(l => { l.visible = v; }) },
    { id: 'labelRoute', label: 'Color', type: 'color', get: () => '#888888',
      set: (v) => labelStore.route.forEach(l => { l.material.color.set(v); }) },
    { id: 'labelRouteSize', label: 'Size', type: 'range', min: 0.1, max: 2, step: 0.05,
      get: () => 0.65,
      set: (v) => labelStore.route.forEach(l => { l.userData._baseHeight = v; l.scale.set(v * l.userData._aspect, v, 1); }) },
    { id: 'labelRouteY', label: 'Y offset', type: 'range', min: -5, max: 15, step: 0.1,
      get: () => 0,
      set: (v) => labelStore.route.forEach(l => { l.position.y = l.userData.baseY + v; }) },
    { id: 'labelRouteAnchor', label: 'Anchor', type: 'select', options: ANCHORS, optionLabels: ANCHOR_LABELS,
      get: () => styleState.anchorRoute,
      set: (v) => { styleState.anchorRoute = v; applyAnchor('route', v); } },
  ];

  // Render panel HTML
  let html = '';
  for (const k of knobs) {
    if (k.section) {
      html += `<div class="sp-section-title">${k.section}</div>`;
      if (k.presets) {
        html += `<div class="sp-presets">
          <button class="sp-preset-btn" data-preset="spread">Spread</button>
          <button class="sp-preset-btn" data-preset="stacked">Stacked</button>
          <button class="sp-preset-btn" data-preset="clean">Clean</button>
          <button class="sp-preset-btn" data-preset="minimal">Minimal</button>
          <button class="sp-preset-btn" data-preset="all">All On</button>
        </div>`;
      }
      continue;
    }
    if (k.type === 'color') {
      html += `<div class="sp-row"><label>${k.label}</label><input type="color" data-id="${k.id}" value="${k.get()}"></div>`;
    } else if (k.type === 'toggle') {
      html += `<div class="sp-row"><label>${k.label}</label><input type="checkbox" data-id="${k.id}" checked></div>`;
    } else if (k.type === 'select') {
      const opts = (k.options || []).map(o => `<option value="${o}"${o === k.get() ? ' selected' : ''}>${k.optionLabels?.[o] || o}</option>`).join('');
      html += `<div class="sp-row"><label>${k.label}</label><select data-id="${k.id}">${opts}</select></div>`;
    } else {
      const val = typeof k.get() === 'number' ? k.get() : 0;
      html += `<div class="sp-row"><label>${k.label}</label><input type="range" data-id="${k.id}" min="${k.min}" max="${k.max}" step="${k.step}" value="${val}"><span class="sp-val">${val.toFixed(2)}</span></div>`;
    }
  }
  stylePanel.innerHTML = html;

  // Wire up events
  const knobMap = new Map(knobs.filter(k => k.id).map(k => [k.id, k]));

  const PRESETS = {
    spread: {
      labelPhaseVis: true, labelPhaseSize: 3.0, labelPhaseY: 6, labelPhaseAnchor: 'l',
      labelBadgeVis: true, labelBadgeSize: 1.5, labelBadgeY: -2,
      labelSgVis: true, labelSgSize: 1.0, labelSgY: 1.5, labelSgAnchor: 'tl',
      labelRouteVis: true, labelRouteSize: 0.65, labelRouteY: -2, labelRouteAnchor: 'bl',
    },
    stacked: {
      labelPhaseVis: true, labelPhaseSize: 3.5, labelPhaseY: 10, labelPhaseAnchor: 'l',
      labelBadgeVis: true, labelBadgeSize: 1.5, labelBadgeY: -2,
      labelSgVis: true, labelSgSize: 1.2, labelSgY: 4, labelSgAnchor: 'tl',
      labelRouteVis: true, labelRouteSize: 0.65, labelRouteY: -3, labelRouteAnchor: 'bl',
    },
    clean: {
      labelPhaseVis: true, labelPhaseSize: 2.0, labelPhaseY: 4, labelPhaseAnchor: 'l',
      labelBadgeVis: true, labelBadgeSize: 1.2, labelBadgeY: -1.3,
      labelSgVis: true, labelSgSize: 1.1, labelSgY: -1.1, labelSgAnchor: 'tl',
      labelRouteVis: true, labelRouteSize: 0.65, labelRouteY: 0, labelRouteAnchor: 'bl',
    },
    minimal: {
      labelPhaseVis: true, labelPhaseSize: 3.0, labelPhaseY: 5, labelPhaseAnchor: 'l',
      labelBadgeVis: false, labelBadgeSize: 1.2, labelBadgeY: -1.3,
      labelSgVis: false, labelSgSize: 1.1, labelSgY: -1.1, labelSgAnchor: 'tl',
      labelRouteVis: false, labelRouteSize: 0.65, labelRouteY: 0, labelRouteAnchor: 'bl',
    },
    all: {
      labelPhaseVis: true, labelPhaseSize: 2.0, labelPhaseY: 0, labelPhaseAnchor: 'l',
      labelBadgeVis: true, labelBadgeSize: 1.2, labelBadgeY: -1.3,
      labelSgVis: true, labelSgSize: 1.1, labelSgY: -1.1, labelSgAnchor: 'tl',
      labelRouteVis: true, labelRouteSize: 0.65, labelRouteY: 0, labelRouteAnchor: 'bl',
    },
  };

  function applyPreset(name) {
    const p = PRESETS[name];
    if (!p) return;
    for (const [id, val] of Object.entries(p)) {
      const knob = knobMap.get(id);
      if (!knob) continue;
      knob.set(val);
      const input = stylePanel.querySelector(`[data-id="${id}"]`);
      if (!input) continue;
      if (knob.type === 'toggle') input.checked = val;
      else if (knob.type === 'range') { input.value = val; const vs = input.nextElementSibling; if (vs?.classList.contains('sp-val')) vs.textContent = Number(val).toFixed(2); }
      else if (knob.type === 'color') input.value = val;
      else if (knob.type === 'select') input.value = val;
    }
  }

  stylePanel.addEventListener('input', (e) => {
    const knob = knobMap.get(e.target.dataset.id);
    if (!knob) return;
    if (knob.type === 'toggle') { knob.set(e.target.checked); return; }
    const val = knob.type === 'color' ? e.target.value : parseFloat(e.target.value);
    knob.set(val);
    const valSpan = e.target.nextElementSibling;
    if (valSpan?.classList.contains('sp-val')) valSpan.textContent = parseFloat(e.target.value).toFixed(2);
  });

  stylePanel.addEventListener('change', (e) => {
    const knob = knobMap.get(e.target.dataset.id);
    if (knob?.type === 'toggle') knob.set(e.target.checked);
    if (knob?.type === 'select') knob.set(e.target.value);
  });

  stylePanel.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-preset]');
    if (btn) applyPreset(btn.dataset.preset);
  });

  // Apply default preset
  applyPreset('clean');
}

export function refreshSpacingUI() {
  const panel = document.getElementById('style-panel');
  if (!panel) return;
  const fields = { phaseGap: styleState.phaseGap, routeGap: styleState.routeGap, sgGap: styleState.sgGap,
    agentScale: styleState.agentScale, agentYLift: styleState.agentYLift,
    boxMinH: styleState.boxMinH, boxMaxH: styleState.boxMaxH, routeLabelZOff: styleState.routeLabelZOff };
  for (const [id, val] of Object.entries(fields)) {
    const input = panel.querySelector(`[data-id="${id}"]`);
    if (!input) continue;
    input.value = val;
    const vs = input.nextElementSibling;
    if (vs?.classList.contains('sp-val')) vs.textContent = Number(val).toFixed(2);
  }
}
