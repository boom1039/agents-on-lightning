import { MANIFEST } from './manifest.js';
import { RW, RD, RGAP, styleState } from './constants.js';

// --- Shared helpers ---

function groupByPhase() {
  const phases = new Map();
  for (const m of MANIFEST) {
    if (!phases.has(m.phase)) phases.set(m.phase, new Map());
    const sgs = phases.get(m.phase);
    if (!sgs.has(m.subgroup)) sgs.set(m.subgroup, []);
    sgs.get(m.subgroup).push(m);
  }
  return phases;
}

function wrapRows(sgMap, maxPerRow, rGap) {
  const gap = rGap ?? styleState.routeGap;
  const rows = [];
  let maxW = 0;
  for (const [, routes] of sgMap) {
    for (let i = 0; i < routes.length; i += maxPerRow) {
      const chunk = routes.slice(i, i + maxPerRow);
      rows.push(chunk);
      const w = chunk.length * RW + Math.max(0, chunk.length - 1) * gap;
      if (w > maxW) maxW = w;
    }
  }
  return { rows, maxW };
}

// --- A. Circuit Board: 5x2 grid, dense phases front row ---

const CB_GRID = [
  [1, 2, 3, 5, 7],
  [4, 6, 8, 9, 10],
];
const CB_MAX = 4;

function computeCircuitBoard() {
  const phases = groupByPhase();
  const phGap = styleState.phaseGap;
  const sGap = styleState.sgGap;
  const rGap = styleState.routeGap;

  const cellInfo = new Map();
  for (const [p, sgMap] of phases) {
    const { rows, maxW } = wrapRows(sgMap, CB_MAX);
    const depth = rows.length * RD + Math.max(0, rows.length - 1) * sGap;
    cellInfo.set(p, { width: maxW, depth, rows });
  }

  const numCols = CB_GRID[0].length;
  const colW = Array(numCols).fill(0);
  const rowD = Array(CB_GRID.length).fill(0);
  for (let r = 0; r < CB_GRID.length; r++) {
    for (let c = 0; c < numCols; c++) {
      const info = cellInfo.get(CB_GRID[r][c]);
      if (!info) continue;
      if (info.width > colW[c]) colW[c] = info.width;
      if (info.depth > rowD[r]) rowD[r] = info.depth;
    }
  }

  const origins = new Map();
  let z0 = 0;
  for (let r = 0; r < CB_GRID.length; r++) {
    let x0 = 0;
    for (let c = 0; c < numCols; c++) {
      origins.set(CB_GRID[r][c], { x: x0, z: z0 });
      x0 += colW[c] + phGap;
    }
    z0 -= rowD[r] + phGap;
  }

  const positions = new Map();
  for (const [p, info] of cellInfo) {
    const o = origins.get(p);
    let cw = 0, cd = 0;
    for (let r = 0; r < CB_GRID.length; r++) {
      const c = CB_GRID[r].indexOf(p);
      if (c >= 0) { cw = colW[c]; cd = rowD[r]; break; }
    }
    const offX = o.x + (cw - info.width) / 2;
    const offZ = o.z - (cd - info.depth) / 2;

    let rz = offZ;
    for (const chunk of info.rows) {
      const rw = chunk.length * RW + Math.max(0, chunk.length - 1) * rGap;
      const rx0 = offX + (info.width - rw) / 2 + RW / 2;
      for (let i = 0; i < chunk.length; i++) {
        positions.set(chunk[i].routeKey, { x: rx0 + i * (RW + rGap), z: rz - RD / 2 });
      }
      rz -= RD + sGap;
    }
  }
  return positions;
}

// --- B. Spine: phases alternate left/right of a central backbone ---

function computeSpine() {
  const sideOffset = 1.5;
  const maxPerRow = 5;
  const phGap = styleState.phaseGap;
  const sGap = styleState.sgGap;
  const rGap = styleState.routeGap;

  const positions = new Map();
  const phases = groupByPhase();

  let z = 0;
  for (let p = 1; p <= 10; p++) {
    const sgMap = phases.get(p);
    if (!sgMap) continue;

    const side = (p % 2 === 1) ? 1 : -1;
    const { rows, maxW } = wrapRows(sgMap, maxPerRow);
    const blockStart = side === 1 ? sideOffset : -(sideOffset + maxW);

    for (const chunk of rows) {
      const rw = chunk.length * RW + Math.max(0, chunk.length - 1) * rGap;
      const rx0 = blockStart + (maxW - rw) / 2 + RW / 2;
      for (let i = 0; i < chunk.length; i++) {
        positions.set(chunk[i].routeKey, { x: rx0 + i * (RW + rGap), z: z - RD / 2 });
      }
      z -= RD + sGap;
    }
    z -= phGap;
  }
  return positions;
}

// --- C. Stadium: concentric arcs, phase 1 innermost ---

function computeStadium() {
  const baseR = 5;
  const ringGap = styleState.phaseGap;
  const arcSpread = Math.PI * 0.6;

  const positions = new Map();
  const phases = groupByPhase();

  for (let p = 1; p <= 10; p++) {
    const sgMap = phases.get(p);
    if (!sgMap) continue;
    const r = baseR + (p - 1) * ringGap;

    // Flat route list with null gap markers between subgroups
    const slots = [];
    const sgEntries = [...sgMap.values()];
    for (let s = 0; s < sgEntries.length; s++) {
      for (const m of sgEntries[s]) slots.push(m);
      if (s < sgEntries.length - 1) slots.push(null);
    }

    const n = slots.length;
    for (let i = 0; i < n; i++) {
      if (!slots[i]) continue;
      const angle = n > 1 ? -arcSpread / 2 + (i / (n - 1)) * arcSpread : 0;
      positions.set(slots[i].routeKey, {
        x: r * Math.sin(angle),
        z: -r * Math.cos(angle),
      });
    }
  }
  return positions;
}

// --- D. Flat Matrix: all routes on single rows per phase, top-down ---

function computeFlatMatrix() {
  const sGap = styleState.sgGap;
  const phGap = styleState.phaseGap;
  const rGap = styleState.routeGap;

  const positions = new Map();
  const phases = groupByPhase();

  let z = 0;
  for (let p = 1; p <= 10; p++) {
    const sgMap = phases.get(p);
    if (!sgMap) continue;

    let x = 0;
    for (const [, routes] of sgMap) {
      for (const m of routes) {
        positions.set(m.routeKey, { x: x + RW / 2, z: z - RD / 2 });
        x += RW + rGap;
      }
      x += sGap;
    }
    z -= RD + phGap;
  }
  return positions;
}

// --- E. Cascade: diagonal staircase, each phase offset right+down ---

function computeCascade() {
  const xStep = 3;
  const zStep = -3;
  const maxPerRow = 4;
  const sGap = styleState.sgGap;
  const rGap = styleState.routeGap;

  const positions = new Map();
  const phases = groupByPhase();

  for (let p = 1; p <= 10; p++) {
    const sgMap = phases.get(p);
    if (!sgMap) continue;

    const baseX = (p - 1) * xStep;
    const baseZ = (p - 1) * zStep;
    const { rows, maxW } = wrapRows(sgMap, maxPerRow);

    let rz = baseZ;
    for (const chunk of rows) {
      const rw = chunk.length * RW + Math.max(0, chunk.length - 1) * rGap;
      const rx0 = baseX + (maxW - rw) / 2 + RW / 2;
      for (let i = 0; i < chunk.length; i++) {
        positions.set(chunk[i].routeKey, { x: rx0 + i * (RW + rGap), z: rz - RD / 2 });
      }
      rz -= RD + sGap;
    }
  }
  return positions;
}

// --- F. Ledger: left-aligned with gutter for phase labels ---

function computeLedger() {
  const phGap = styleState.phaseGap;
  const rGap = styleState.routeGap;
  const sGap = styleState.sgGap;
  const gutter = 3;

  const positions = new Map();
  const phases = groupByPhase();

  let z = 0;
  for (let p = 1; p <= 10; p++) {
    const sgMap = phases.get(p);
    if (!sgMap) continue;

    let x = gutter;
    for (const [, routes] of sgMap) {
      for (const m of routes) {
        positions.set(m.routeKey, { x: x + RW / 2, z: z - RD / 2 });
        x += RW + rGap;
      }
      x += sGap;
    }
    z -= RD + phGap;
  }
  return positions;
}

// --- G. Terraced: centered rows, Y elevation applied by switchLayout ---

function computeTerraced() {
  const phGap = styleState.phaseGap;
  const rGap = styleState.routeGap;
  const sGap = styleState.sgGap;

  const positions = new Map();
  const phases = groupByPhase();

  let z = 0;
  for (let p = 1; p <= 10; p++) {
    const sgMap = phases.get(p);
    if (!sgMap) continue;

    const sgEntries = [...sgMap.values()];
    let totalW = 0;
    for (let s = 0; s < sgEntries.length; s++) {
      totalW += sgEntries[s].length * RW + Math.max(0, sgEntries[s].length - 1) * rGap;
      if (s < sgEntries.length - 1) totalW += sGap;
    }

    let x = -totalW / 2;
    for (let s = 0; s < sgEntries.length; s++) {
      for (let i = 0; i < sgEntries[s].length; i++) {
        if (i > 0) x += rGap;
        positions.set(sgEntries[s][i].routeKey, { x: x + RW / 2, z: z - RD / 2 });
        x += RW;
      }
      if (s < sgEntries.length - 1) x += sGap;
    }
    z -= RD + phGap;
  }
  return positions;
}

// --- H. Pinboard: compact centered grid with wrapping ---

function computePinboard() {
  const maxPerRow = 6;
  const phGap = styleState.phaseGap;
  const sGap = styleState.sgGap;
  const rGap = styleState.routeGap;

  const positions = new Map();
  const phases = groupByPhase();

  let z = 0;
  for (let p = 1; p <= 10; p++) {
    const sgMap = phases.get(p);
    if (!sgMap) continue;

    const { rows, maxW } = wrapRows(sgMap, maxPerRow);

    for (const chunk of rows) {
      const rw = chunk.length * RW + Math.max(0, chunk.length - 1) * rGap;
      const rx0 = -rw / 2 + RW / 2;
      for (let i = 0; i < chunk.length; i++) {
        positions.set(chunk[i].routeKey, { x: rx0 + i * (RW + rGap), z: z - RD / 2 });
      }
      z -= RD + sGap;
    }
    z += sGap;
    z -= phGap;
  }
  return positions;
}

// --- I. Double Row: extra Z space before each phase for label strip ---

function computeDoubleRow() {
  const phGap = styleState.phaseGap;
  const rGap = styleState.routeGap;
  const sGap = styleState.sgGap;
  const labelRowDepth = 1.5;

  const positions = new Map();
  const phases = groupByPhase();

  let z = 0;
  for (let p = 1; p <= 10; p++) {
    const sgMap = phases.get(p);
    if (!sgMap) continue;

    z -= labelRowDepth;

    const sgEntries = [...sgMap.values()];
    let totalW = 0;
    for (let s = 0; s < sgEntries.length; s++) {
      totalW += sgEntries[s].length * RW + Math.max(0, sgEntries[s].length - 1) * rGap;
      if (s < sgEntries.length - 1) totalW += sGap;
    }

    let x = -totalW / 2;
    for (let s = 0; s < sgEntries.length; s++) {
      for (let i = 0; i < sgEntries[s].length; i++) {
        if (i > 0) x += rGap;
        positions.set(sgEntries[s][i].routeKey, { x: x + RW / 2, z: z - RD / 2 });
        x += RW;
      }
      if (s < sgEntries.length - 1) x += sGap;
    }
    z -= RD + phGap;
  }
  return positions;
}

// --- J. Tilted Grid: honeycomb brick pattern with offset rows ---

function computeTiltedGrid() {
  const maxCols = 8;
  const phGap = styleState.phaseGap;
  const rGap = styleState.routeGap;
  const xSpc = RW + rGap;
  const zSpc = RD + 0.3;

  const positions = new Map();
  const phases = groupByPhase();

  let zBase = 0;
  for (let p = 1; p <= 10; p++) {
    const sgMap = phases.get(p);
    if (!sgMap) continue;

    const allRoutes = [];
    for (const [, routes] of sgMap) allRoutes.push(...routes);

    const totalRows = Math.ceil(allRoutes.length / maxCols);
    const gridW = Math.min(allRoutes.length, maxCols) * xSpc;

    for (let i = 0; i < allRoutes.length; i++) {
      const row = Math.floor(i / maxCols);
      const col = i % maxCols;
      const isOddRow = row % 2 === 1;
      const x = col * xSpc + (isOddRow ? xSpc / 2 : 0) - gridW / 2;
      const z = zBase - row * zSpc;
      positions.set(allRoutes[i].routeKey, { x: x + RW / 2, z: z - RD / 2 });
    }

    zBase -= totalRows * zSpc + phGap;
  }
  return positions;
}

// --- Layout registry ---

export const LAYOUTS = {
  default: {
    positions: null,
    spacing: { phaseGap: 3.0, routeGap: 0.4, sgGap: 0.6 },
    camera: { px: 24.7, py: 25.2, pz: -21.09, tx: -5.88, ty: 1.5, tz: -22.92 },
    style: { showSgWires: true, filledRoutes: false },
    label: 'Default',
  },
  circuitBoard: {
    get positions() { return computeCircuitBoard(); },
    spacing: { phaseGap: 2.0, routeGap: 0.4, sgGap: 0.5 },
    camera: { px: 25, py: 30, pz: 2, tx: 14, ty: 0, tz: -8 },
    style: { showSgWires: false, filledRoutes: true },
    label: 'Circuit Board',
  },
  spine: {
    get positions() { return computeSpine(); },
    spacing: { phaseGap: 1.5, routeGap: 0.4, sgGap: 0.4 },
    camera: { px: 12, py: 30, pz: -15, tx: 0, ty: 0, tz: -25 },
    style: { showSgWires: false, filledRoutes: false },
    label: 'Spine',
  },
  stadium: {
    get positions() { return computeStadium(); },
    spacing: { phaseGap: 3.0, routeGap: 0.4, sgGap: 0.6 },
    camera: { px: 0, py: 40, pz: 10, tx: 0, ty: 0, tz: -15 },
    style: { showSgWires: false, filledRoutes: true },
    label: 'Stadium',
  },
  flatMatrix: {
    get positions() { return computeFlatMatrix(); },
    spacing: { phaseGap: 1.0, routeGap: 0.4, sgGap: 0.6 },
    camera: { px: 12, py: 50, pz: -5, tx: 12, ty: 0, tz: -12 },
    style: { showSgWires: false, filledRoutes: true },
    label: 'Flat Matrix',
  },
  cascade: {
    get positions() { return computeCascade(); },
    spacing: { phaseGap: 1.0, routeGap: 0.4, sgGap: 0.4 },
    camera: { px: 30, py: 25, pz: -5, tx: 14, ty: 0, tz: -14 },
    style: { showSgWires: false, filledRoutes: false },
    label: 'Cascade',
  },
  ledger: {
    get positions() { return computeLedger(); },
    spacing: { phaseGap: 2.0, routeGap: 0.4, sgGap: 0.8 },
    camera: { px: 20, py: 20, pz: 5, tx: 12, ty: 0, tz: -8 },
    style: { showSgWires: false, filledRoutes: true },
    label: 'Ledger',
  },
  terraced: {
    get positions() { return computeTerraced(); },
    spacing: { phaseGap: 1.2, routeGap: 0.4, sgGap: 0.6 },
    yStep: 1.8,
    camera: { px: 25, py: 12, pz: 12, tx: 0, ty: 8, tz: -8 },
    style: { showSgWires: false, filledRoutes: true },
    label: 'Terraced',
  },
  pinboard: {
    get positions() { return computePinboard(); },
    spacing: { phaseGap: 3.0, routeGap: 0.2, sgGap: 0.3 },
    camera: { px: 8, py: 30, pz: 5, tx: 0, ty: 0, tz: -10 },
    style: { showSgWires: false, filledRoutes: true },
    label: 'Pinboard',
  },
  doubleRow: {
    get positions() { return computeDoubleRow(); },
    spacing: { phaseGap: 1.5, routeGap: 0.4, sgGap: 0.6 },
    camera: { px: 15, py: 18, pz: 8, tx: 0, ty: 0, tz: -10 },
    style: { showSgWires: false, filledRoutes: true },
    label: 'Double Row',
  },
  tiltedGrid: {
    get positions() { return computeTiltedGrid(); },
    spacing: { phaseGap: 1.5, routeGap: 0.5, sgGap: 0.6 },
    camera: { px: 12, py: 28, pz: 5, tx: 0, ty: 0, tz: -10 },
    style: { showSgWires: false, filledRoutes: true },
    label: 'Tilted Grid',
  },
};

export const LAYOUT_NAMES = Object.keys(LAYOUTS);
