import { MANIFEST } from './manifest.js';
import { RW, RD, styleState } from './constants.js';

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

// --- Layout registry ---

export const LAYOUTS = {
  default: {
    positions: null,
    spacing: { phaseGap: 3.0, routeGap: 0.4, sgGap: 0.6 },
    camera: { px: 24.7, py: 25.2, pz: -21.09, tx: -5.88, ty: 1.5, tz: -22.92 },
    style: { showSgWires: true, filledRoutes: false },
    label: 'Default',
  },
  flatMatrix: {
    get positions() { return computeFlatMatrix(); },
    spacing: { phaseGap: 1.0, routeGap: 0.4, sgGap: 0.6 },
    camera: { px: 12, py: 50, pz: -5, tx: 12, ty: 0, tz: -12 },
    style: { showSgWires: false, filledRoutes: true },
    label: 'Flat Matrix',
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
};

export const LAYOUT_NAMES = Object.keys(LAYOUTS);
