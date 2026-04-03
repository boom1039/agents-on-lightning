import * as THREE from 'three';

// Scene
export const BG = 0x000000;
export const WIRE = 0xffffff;

// Phase config
export const PHASE_COLORS = {
  1:'#e4e4e7',2:'#d4d4d8',3:'#a1a1aa',4:'#71717a',5:'#52525b',
  6:'#a1a1aa',7:'#71717a',8:'#52525b',9:'#3f3f46',10:'#27272a',
};
export const PHASE_NAMES = {
  1:'Arrive',2:'Identity',3:'Wallet',4:'Explore',5:'Social',
  6:'Intel',7:'Channels',8:'Revenue',9:'Advanced',10:'Audit',
};

// Layout sizing
export const RW = 1.2, RD = 1.0, RGAP = 0.4;
export const RMIN = 0.3, RMAX = 2.0;
export const SGP = 0.8, SGG = 1.5, SGH = 3.0;
export const SG_DEPTH = RD + 2 * SGP;
export const PHP = 1.2, PHG = 3.0, PHH = 3.5;
export const SG_COLS = 3;

// Agents
export const AGENT_SZ = 0.15, MAX_INST = 2000, ORBIT_R = 1.5;

// Flight arcs
export const ARC_NEAR = 1000, ARC_MID = 1200, ARC_FAR = 1500, TRAIL_N = 15;
export const SETTLE_DUR = 350, STAGGER_MS = 80;

// Bloom defaults
export const BLOOM_S = 0.25, BLOOM_R = 1.05, BLOOM_T = 0.93;

// Method badges
export const MB = { GET:'G', POST:'P', PUT:'U', DELETE:'D', PATCH:'A' };

// Sprites
export const SPRITE_FONT_PX = 64;
export const SPRITE_PAD = 16;
export const ANCHORS = ['tl','tc','tr','l','c','r','bl','bc','br'];
export const ANCHOR_LABELS = {
  tl:'Top-Left',tc:'Top-Center',tr:'Top-Right',
  l:'Left',c:'Center',r:'Right',
  bl:'Bottom-Left',bc:'Bottom-Center',br:'Bottom-Right',
};

// Mutable style state (shared across modules)
export const styleState = {
  routeActiveOp: 1,
  routeIdleOp: 1,
  trail: [0.64, 0.01, 0.01],
  trailOp: 1,
  flightSpeed: 1.0,
  anchorPhase: 'l',
  anchorSg: 'tl',
  anchorRoute: 'bl',
  badgeYFromLabel: -1.3,
  phaseRouteAnchors: {},   // phase → anchor override for route labels in that phase
  // Spacing (layout rebuild)
  phaseGap: 1.0,
  routeGap: 0.4,
  sgGap: 0.6,
  // Visibility
  agentScale: 1.0,
  agentYLift: 0,
  boxMinH: 0.3,
  boxMaxH: 2.0,
  routeLabelZOff: 0,
};

// Helpers

export function easeIO(t) {
  return t < 0.5 ? 4*t*t*t : 1 - Math.pow(-2*t+2, 3)/2;
}

export function easeOut(t) {
  return 1 - Math.pow(1 - t, 3);
}

export function heightForAgentCount(n) {
  const min = styleState.boxMinH;
  const max = styleState.boxMaxH;
  if (n <= 0) return min;
  return Math.min(min + Math.sqrt(n) * 0.5, max);
}

// 3D grid packing: agents inside route boxes (cols × rows × layers)
const GRID_PAD = 0.08;
const GRID_SPC = AGENT_SZ * 1.4;

export function gridSlotPos(boxPos, boxW, boxD, boxH, slot, yBase = 0) {
  const usableW = boxW - 2 * GRID_PAD;
  const usableD = boxD - 2 * GRID_PAD;
  const cols = Math.max(1, Math.floor(usableW / GRID_SPC));
  const rows = Math.max(1, Math.floor(usableD / GRID_SPC));
  const perLayer = cols * rows;

  const layer = Math.floor(slot / perLayer);
  const inLayer = slot % perLayer;
  const col = inLayer % cols;
  const row = Math.floor(inLayer / cols);

  const x = boxPos.x - usableW / 2 + GRID_SPC / 2 + col * GRID_SPC;
  const z = boxPos.z - usableD / 2 + GRID_SPC / 2 + row * GRID_SPC;
  const y = yBase + GRID_PAD + AGENT_SZ / 2 + layer * GRID_SPC;
  return new THREE.Vector3(x, y, z);
}

export function scatterPos(bx, bz, seed) {
  const a = seed * 6.2832;
  const r = ORBIT_R * (0.3 + ((seed * 7.13) % 1) * 0.7);
  const h = ((seed * 13.37) % 1) * 0.8;
  return new THREE.Vector3(bx + Math.cos(a) * r, 1.0 + h, bz + Math.sin(a) * r);
}

export function driftVec(seed, t) {
  const s = seed * 100;
  return new THREE.Vector3(
    Math.sin(t * 0.0003 + s) * 0.015,
    Math.sin(t * 0.0005 + s * 1.3) * 0.008,
    Math.cos(t * 0.0004 + s * 0.7) * 0.015,
  );
}

const _c = new THREE.Color();
export function hexFromThree(c) {
  _c.set(c);
  return '#' + _c.getHexString();
}
