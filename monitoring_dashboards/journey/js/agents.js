import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { AGENT_SZ, MAX_INST, PHASE_COLORS, ARC_NEAR, ARC_MID, ARC_FAR,
         TRAIL_N, easeIO, easeOut, gridSlotPos, driftVec, RW, RD, styleState,
         SETTLE_DUR, STAGGER_MS } from './constants.js';
import { scene } from './scene.js';
import { routeBoxes } from './builder.js';

// Agent shapes — accept size parameter for runtime scaling
function edgeCubeGeo(s) {
  const e = s * 0.08;
  const hs = s / 2;
  const pieces = [];
  for (const y of [-hs, hs]) for (const z of [-hs, hs]) {
    const g = new THREE.BoxGeometry(s, e, e); g.translate(0, y, z); pieces.push(g);
  }
  for (const x of [-hs, hs]) for (const z of [-hs, hs]) {
    const g = new THREE.BoxGeometry(e, s, e); g.translate(x, 0, z); pieces.push(g);
  }
  for (const x of [-hs, hs]) for (const y of [-hs, hs]) {
    const g = new THREE.BoxGeometry(e, e, s); g.translate(x, y, 0); pieces.push(g);
  }
  const merged = mergeGeometries(pieces);
  pieces.forEach(g => g.dispose());
  return merged;
}

const SHAPES = {
  'cube-solid': (s) => new THREE.BoxGeometry(s, s, s),
  'octahedron': (s) => new THREE.OctahedronGeometry(s * 0.65),
  'sphere': (s) => new THREE.SphereGeometry(s * 0.55, 8, 6),
  'cube-wire': (s) => edgeCubeGeo(s),
};
export const SHAPE_NAMES = Object.keys(SHAPES);

// Agent Instance Manager — pools instanced meshes

class AgentMgr {
  constructor() {
    this.shapeName = 'cube-solid';
    const geo = SHAPES[this.shapeName](AGENT_SZ * styleState.agentScale);
    const mat = new THREE.MeshBasicMaterial({ color: 0xd12120 });
    this.mesh = new THREE.InstancedMesh(geo, mat, MAX_INST);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.count = 0;
    this.mesh.layers.enable(2);
    this.mesh.frustumCulled = false;
    scene.add(this.mesh);

    this.agents = new Map();     // agentId → { idx, routeKey, phase, seed, recent, slot }
    this.idxToAgent = new Map(); // idx → agentId
    this.freeList = [];
    this.nextIdx = 0;
    this.dummy = new THREE.Object3D();
    this.col = new THREE.Color();
  }

  acquire(agentId) {
    if (this.agents.has(agentId)) return this.agents.get(agentId);
    let idx;
    if (this.freeList.length > 0) idx = this.freeList.pop();
    else { idx = this.nextIdx++; if (idx >= MAX_INST) return null; }

    const data = { idx, routeKey: null, phase: 0, seed: Math.random(), recent: [] };
    this.agents.set(agentId, data);
    this.idxToAgent.set(idx, agentId);
    if (idx >= this.mesh.count) this.mesh.count = idx + 1;
    return data;
  }

  release(agentId) {
    const data = this.agents.get(agentId);
    if (!data) return;
    this.dummy.scale.set(0, 0, 0);
    this.dummy.updateMatrix();
    this.mesh.setMatrixAt(data.idx, this.dummy.matrix);
    this.agents.delete(agentId);
    this.idxToAgent.delete(data.idx);
    this.freeList.push(data.idx);
    this.mesh.instanceMatrix.needsUpdate = true;
  }

  setPos(agentId, x, y, z) {
    const data = this.agents.get(agentId);
    if (!data) return;
    this.dummy.position.set(x, y, z);
    this.dummy.scale.set(1, 1, 1);
    this.dummy.updateMatrix();
    this.mesh.setMatrixAt(data.idx, this.dummy.matrix);
  }

  setColor(agentId, phaseNum) {
    const data = this.agents.get(agentId);
    if (!data) return;
    data.phase = phaseNum;
    this.col.set(PHASE_COLORS[phaseNum] || '#ffffff');
    this.mesh.setColorAt(data.idx, this.col);
  }

  setBright(agentId) {
    const data = this.agents.get(agentId);
    if (!data) return;
    this.col.set('#ff4040');
    this.mesh.setColorAt(data.idx, this.col);
  }

  commit() {
    this.mesh.instanceMatrix.needsUpdate = true;
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
  }

  swapGeometry(shapeName, force = false) {
    if (!SHAPES[shapeName] || (shapeName === this.shapeName && !force)) return;

    // Snapshot matrices + colors
    const count = this.mesh.count;
    const matrices = new Float32Array(count * 16);
    for (let i = 0; i < count; i++) {
      this.mesh.getMatrixAt(i, this.dummy.matrix);
      this.dummy.matrix.toArray(matrices, i * 16);
    }
    const colors = this.mesh.instanceColor
      ? new Float32Array(this.mesh.instanceColor.array.slice(0, count * 3))
      : null;

    // Dispose old
    scene.remove(this.mesh);
    this.mesh.geometry.dispose();
    this.mesh.dispose();

    // Build new
    this.shapeName = shapeName;
    const geo = SHAPES[shapeName](AGENT_SZ * styleState.agentScale);
    const mat = new THREE.MeshBasicMaterial({ color: 0xd12120 });
    this.mesh = new THREE.InstancedMesh(geo, mat, MAX_INST);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.count = count;
    this.mesh.layers.enable(2);
    this.mesh.frustumCulled = false;

    // Restore matrices
    for (let i = 0; i < count; i++) {
      this.dummy.matrix.fromArray(matrices, i * 16);
      this.mesh.setMatrixAt(i, this.dummy.matrix);
    }

    // Restore colors
    if (colors) {
      for (let i = 0; i < count; i++) {
        this.col.fromArray(colors, i * 3);
        this.mesh.setColorAt(i, this.col);
      }
    }

    scene.add(this.mesh);
    this.commit();
  }
}

// Flight Arc Manager — animates agents along bezier curves between routes

class FlightMgr {
  constructor() { this.flights = new Map(); }

  start(agentId, fromPos, toPos, toRouteKey, now) {
    if (this.flights.has(agentId)) this.land(agentId);

    const mid = new THREE.Vector3().lerpVectors(fromPos, toPos, 0.5);
    const dist = fromPos.distanceTo(toPos);
    mid.y = Math.max(fromPos.y, toPos.y) + Math.min(dist * 0.4, 12);

    const curve = new THREE.QuadraticBezierCurve3(fromPos.clone(), mid, toPos.clone());
    const baseDur = dist < 5 ? ARC_NEAR : dist < 20 ? ARC_MID : ARC_FAR;
    const dur = baseDur / Math.max(0.1, styleState.flightSpeed);

    const geo = new THREE.BufferGeometry();
    const posA = new Float32Array(TRAIL_N * 3);
    const colA = new Float32Array(TRAIL_N * 3);
    geo.setAttribute('position', new THREE.BufferAttribute(posA, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(colA, 3));
    geo.setDrawRange(0, 0);
    const line = new THREE.Line(geo, new THREE.LineBasicMaterial({
      vertexColors: true, transparent: true, opacity: styleState.trailOp,
    }));
    scene.add(line);

    agentMgr.setBright(agentId);

    this.flights.set(agentId, {
      curve, start: now, dur, toRouteKey,
      line, posA, colA, trail: [],
    });
  }

  update(now) {
    const landed = [];
    for (const [id, f] of this.flights) {
      const t = Math.min(1, (now - f.start) / f.dur);
      const pt = f.curve.getPointAt(easeIO(t));

      f.trail.push(pt.clone());
      if (f.trail.length > TRAIL_N) f.trail.shift();
      const n = f.trail.length;
      for (let i = 0; i < n; i++) {
        const p = f.trail[i];
        f.posA[i*3] = p.x; f.posA[i*3+1] = p.y; f.posA[i*3+2] = p.z;
        const b = (i + 1) / n;
        f.colA[i*3] = styleState.trail[0]*b; f.colA[i*3+1] = styleState.trail[1]*b; f.colA[i*3+2] = styleState.trail[2]*b;
      }
      f.line.geometry.attributes.position.needsUpdate = true;
      f.line.geometry.attributes.color.needsUpdate = true;
      f.line.geometry.setDrawRange(0, n);

      agentMgr.setPos(id, pt.x, pt.y, pt.z);

      if (t >= 1) landed.push(id);
    }
    for (const id of landed) this.land(id);
    if (landed.length > 0 || this.flights.size > 0) agentMgr.commit();
  }

  land(agentId) {
    const f = this.flights.get(agentId);
    if (!f) return;
    scene.remove(f.line);
    f.line.geometry.dispose();
    f.line.material.dispose();

    const landPos = f.curve.getPointAt(1);
    this.flights.delete(agentId);

    const box = routeBoxes.get(f.toRouteKey);
    const data = agentMgr.agents.get(agentId);
    if (box && data) {
      agentMgr.setColor(agentId, data.phase);
      startSettle(agentId, landPos.x, landPos.y, landPos.z, f.toRouteKey);
    }
  }

  has(id) { return this.flights.has(id); }
  get inflightCount() { return this.flights.size; }
}

export const agentMgr = new AgentMgr();
export const flightMgr = new FlightMgr();

// Settle helper — smooth ease-out from entry point to grid slot

export function startSettle(agentId, fromX, fromY, fromZ, rk) {
  const data = agentMgr.agents.get(agentId);
  if (!data) return;
  // Count agents already settling at same route → stagger start
  let queued = 0;
  if (rk) {
    for (const [, d] of agentMgr.agents) {
      if (d.routeKey === rk && d.settleSt !== undefined) queued++;
    }
  }
  data.settleSt = performance.now() + queued * STAGGER_MS;
  if (!data.settleFrom) data.settleFrom = new THREE.Vector3();
  data.settleFrom.set(fromX, fromY, fromZ);
}

// Animation helper — settle + idle drift for agents at their route

export function updateAgentDrift(now) {
  let dirty = false;
  for (const [id, data] of agentMgr.agents) {
    if (flightMgr.has(id)) continue;
    const box = routeBoxes.get(data.routeKey);
    if (!box) continue;
    const target = gridSlotPos(box.pos, RW, RD, box.curH, data.slot ?? 0, box.yBase || 0);
    target.y += styleState.agentYLift;

    if (data.settleSt !== undefined) {
      const t = Math.min(1, Math.max(0, (now - data.settleSt) / SETTLE_DUR));
      const e = easeOut(t);
      const x = data.settleFrom.x + (target.x - data.settleFrom.x) * e;
      const y = data.settleFrom.y + (target.y - data.settleFrom.y) * e;
      const z = data.settleFrom.z + (target.z - data.settleFrom.z) * e;
      agentMgr.setPos(id, x, y, z);
      if (t >= 1) data.settleSt = undefined;
    } else {
      const d = driftVec(data.seed, now);
      agentMgr.setPos(id, target.x + d.x, target.y + d.y, target.z + d.z);
    }
    dirty = true;
  }
  if (dirty) agentMgr.commit();
}
