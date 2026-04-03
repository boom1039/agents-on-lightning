export const DOCK_SCOPE_ROUTE = 'route';
export const DOCK_SCOPE_GROUP = 'group';
export const DOCK_HOLE_TTL_MS = 10_000;

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function sortAgentsForAppend(agents = []) {
  return [...agents].sort((a, b) => {
    const aTime = Number.isFinite(a.routeEnteredAt) ? a.routeEnteredAt : (a.lastEventTime || 0);
    const bTime = Number.isFinite(b.routeEnteredAt) ? b.routeEnteredAt : (b.lastEventTime || 0);
    if (aTime !== bTime) return aTime - bTime;
    return String(a.id).localeCompare(String(b.id));
  });
}

export function computeDockVisual(anchor, {
  occupancy = 0,
  inFlight = 0,
} = {}) {
  const live = Math.max(0, occupancy);
  const pressure = live + (Math.max(0, inFlight) * 0.4);
  let scale = 0.18;
  if (live >= 1 && live <= 4) scale = 0.45;
  else if (live >= 5 && live <= 12) scale = 0.7;
  else if (live >= 13) scale = 1.0;

  let floorWidth = anchor.envelopeWidth * scale;
  let floorDepth = anchor.envelopeDepth * clamp(scale + 0.06, 0.24, 0.92);
  let slotPitch = clamp(Math.min(floorWidth / 3.8, floorDepth / 2.8, 0.86), 0.48, 0.84);
  let cols = Math.max(1, Math.floor((floorWidth - 0.28) / slotPitch));
  let rows = Math.max(1, Math.floor((floorDepth - 0.34) / slotPitch));
  let levelCapacity = Math.max(1, cols * rows);
  let trayCount = Math.max(0, Math.ceil(Math.max(0, live - levelCapacity) / Math.max(1, levelCapacity)));

  while (trayCount > 3 && slotPitch > 0.5) {
    slotPitch = Math.max(0.5, slotPitch - 0.04);
    cols = Math.max(1, Math.floor((floorWidth - 0.2) / slotPitch));
    rows = Math.max(1, Math.floor((floorDepth - 0.28) / slotPitch));
    levelCapacity = Math.max(1, cols * rows);
    trayCount = Math.max(0, Math.ceil(Math.max(0, live - levelCapacity) / Math.max(1, levelCapacity)));
  }

  trayCount = Math.min(3, trayCount);

  const padHeight = live === 0
    ? 0.07
    : live <= 4
      ? 0.28
      : live <= 12
        ? 0.44
        : 0.62;
  const wallHeight = live === 0
    ? 0.08
    : live <= 4
      ? 0.2
      : live <= 12
        ? 0.32
        : 0.46;
  const railHeight = wallHeight * 0.55;
  const trayGap = 0.52;
  const trayThickness = 0.055;
  const labelVisible = live > 0 || inFlight > 0;
  const badgeVisible = live > 0 || inFlight > 0;

  return {
    occupancy: live,
    inFlight: Math.max(0, inFlight),
    scale,
    floorWidth,
    floorDepth,
    padHeight,
    wallHeight,
    railHeight,
    trayCount,
    trayThickness,
    trayGap,
    slotPitch,
    cols,
    rows,
    levelCapacity,
    labelVisible,
    badgeVisible,
    glow: clamp((pressure / 10) + (inFlight > 0 ? 0.35 : 0), 0.08, 1),
  };
}

export function syncDockSlots(previousSlots, agents, now, {
  holeTtlMs = DOCK_HOLE_TTL_MS,
  levelCapacity = 1,
} = {}) {
  const next = [];
  const activeIds = new Set(agents.map((agent) => agent.id));
  for (const slot of previousSlots || []) {
    if (slot.agentId && activeIds.has(slot.agentId)) {
      next.push({ agentId: slot.agentId, vacatedAt: null });
      continue;
    }
    if (slot.agentId && !activeIds.has(slot.agentId)) {
      next.push({ agentId: null, vacatedAt: now });
      continue;
    }
    if (!slot.agentId) next.push({
      agentId: null,
      vacatedAt: Number.isFinite(slot.vacatedAt) ? slot.vacatedAt : now,
    });
  }

  const seen = new Set(next.map((slot) => slot.agentId).filter(Boolean));
  for (const agent of sortAgentsForAppend(agents).filter((item) => !seen.has(item.id))) {
    next.push({ agentId: agent.id, vacatedAt: null });
  }

  const compacted = [];
  for (let offset = 0; offset < next.length; offset += Math.max(1, levelCapacity)) {
    const tray = next.slice(offset, offset + Math.max(1, levelCapacity));
    for (const slot of tray) {
      if (slot.agentId) {
        compacted.push({ agentId: slot.agentId, vacatedAt: null });
        continue;
      }
      if (Number.isFinite(slot.vacatedAt) && (now - slot.vacatedAt) <= holeTtlMs) {
        compacted.push(slot);
      }
    }
  }

  while (compacted.length > 0) {
    const tail = compacted[compacted.length - 1];
    if (tail.agentId) break;
    if (Number.isFinite(tail.vacatedAt) && (now - tail.vacatedAt) <= holeTtlMs) break;
    compacted.pop();
  }

  const indexByAgent = new Map();
  compacted.forEach((slot, index) => {
    if (slot.agentId) indexByAgent.set(slot.agentId, index);
  });

  return {
    slots: compacted,
    indexByAgent,
  };
}

export function computeDockSlotPosition(slotIndex, anchor, visual) {
  const perLevel = Math.max(1, visual.levelCapacity);
  const level = Math.floor(Math.max(0, slotIndex) / perLevel);
  const localIndex = Math.max(0, slotIndex) % perLevel;
  const col = localIndex % Math.max(1, visual.cols);
  const row = Math.floor(localIndex / Math.max(1, visual.cols));
  const planeWidth = visual.floorWidth * (level === 0 ? 0.9 : 0.86);
  const planeDepth = visual.floorDepth * (level === 0 ? 0.84 : 0.82);
  const spacingX = Math.max(0.001, planeWidth / Math.max(1, visual.cols));
  const spacingZ = Math.max(0.001, planeDepth / Math.max(1, visual.rows));
  const rowOffset = row % 2 === 1 ? Math.min(spacingX * 0.18, planeWidth * 0.08) : 0;
  const x = anchor.x - (planeWidth / 2) + spacingX * (col + 0.5) + rowOffset;
  const z = anchor.z - (planeDepth / 2) + spacingZ * (row + 0.5);
  const y = anchor.baseY + visual.padHeight + 0.18 + level * visual.trayGap;
  return {
    x,
    y,
    z,
    level,
  };
}

function lerp(a, b, t) {
  return a + ((b - a) * t);
}

function withAlpha(baseColor, alpha) {
  return {
    color: baseColor,
    alpha,
  };
}

export class RouteDock {
  constructor({
    THREE,
    route,
    anchor,
    color,
    scope = DOCK_SCOPE_ROUTE,
  }) {
    this.THREE = THREE;
    this.route = route;
    this.anchor = anchor;
    this.scope = scope;
    this.color = color;
    this.slots = [];
    this.current = computeDockVisual(anchor, { occupancy: 0, inFlight: 0 });
    this.target = { ...this.current };

    this.group = new THREE.Group();
    this.group.position.set(anchor.x, anchor.baseY, anchor.z);

    this.shadow = new THREE.Mesh(
      new THREE.CylinderGeometry(0.5, 0.5, 1, 24),
      new THREE.MeshBasicMaterial({
        color: 0x000000,
        transparent: true,
        opacity: 0.18,
        depthWrite: false,
      }),
    );
    this.shadow.position.y = 0.03;
    this.group.add(this.shadow);

    this.peg = new THREE.Mesh(
      new THREE.CylinderGeometry(0.18, 0.18, 1, 8),
      new THREE.MeshStandardMaterial({
        color,
        emissive: color,
        transparent: true,
        opacity: 0.5,
        metalness: 0.08,
        roughness: 0.72,
      }),
    );
    this.peg.position.y = 0.14;
    this.group.add(this.peg);

    this.pad = new THREE.Mesh(
      new THREE.BoxGeometry(1, 1, 1),
      new THREE.MeshStandardMaterial({
        color,
        emissive: color,
        transparent: true,
        opacity: 0.88,
        metalness: 0.05,
        roughness: 0.7,
      }),
    );
    this.group.add(this.pad);

    this.leftWall = this._makeWall(color);
    this.rightWall = this._makeWall(color);
    this.backWall = this._makeWall(color);
    this.frontRail = this._makeWall(color, 0.94);
    this.group.add(this.leftWall, this.rightWall, this.backWall, this.frontRail);

    this.trays = [];
    for (let idx = 0; idx < 3; idx += 1) {
      const tray = new THREE.Mesh(
        new THREE.BoxGeometry(1, 1, 1),
        new THREE.MeshStandardMaterial({
          color,
          emissive: color,
          transparent: true,
          opacity: 0.2,
          metalness: 0.02,
          roughness: 0.82,
        }),
      );
      tray.visible = false;
      this.group.add(tray);
      this.trays.push(tray);
    }

    this.updateVisual({
      occupancy: 0,
      inFlight: 0,
      highlighted: false,
      searchMatch: false,
      now: Date.now(),
      snap: true,
    });
  }

  _makeWall(color, opacity = 0.72) {
    return new this.THREE.Mesh(
      new this.THREE.BoxGeometry(1, 1, 1),
      new this.THREE.MeshStandardMaterial({
        color,
        emissive: color,
        transparent: true,
        opacity,
        metalness: 0.04,
        roughness: 0.72,
      }),
    );
  }

  setRoute(route) {
    this.route = route;
  }

  syncAgents(agents, now) {
    const visual = this.target || this.current;
    const synced = syncDockSlots(this.slots, agents, now, {
      holeTtlMs: DOCK_HOLE_TTL_MS,
      levelCapacity: visual.levelCapacity,
    });
    this.slots = synced.slots;
    return synced;
  }

  updateVisual({
    occupancy = 0,
    inFlight = 0,
    highlighted = false,
    searchMatch = false,
    snap = false,
  }) {
    this.target = computeDockVisual(this.anchor, { occupancy, inFlight });
    const mix = snap ? 1 : 0.18;

    for (const key of [
      'scale',
      'floorWidth',
      'floorDepth',
      'padHeight',
      'wallHeight',
      'railHeight',
      'trayGap',
      'trayThickness',
      'glow',
    ]) {
      this.current[key] = lerp(this.current[key], this.target[key], mix);
    }

    for (const key of ['trayCount', 'cols', 'rows', 'levelCapacity', 'occupancy', 'inFlight']) {
      this.current[key] = this.target[key];
    }

    this.current.labelVisible = this.target.labelVisible;
    this.current.badgeVisible = this.target.badgeVisible;

    const emphasis = highlighted ? 1 : searchMatch ? 0.75 : this.current.glow;
    const padWidth = this.current.floorWidth;
    const padDepth = this.current.floorDepth;
    const padHeight = this.current.padHeight;
    const wallHeight = this.current.wallHeight;
    const wallThickness = clamp(Math.min(padWidth, padDepth) * 0.08, 0.12, 0.28);
    const railThickness = wallThickness * 0.74;

    this.group.position.set(this.anchor.x, this.anchor.baseY, this.anchor.z);

    this.shadow.scale.set(padWidth * 1.14, 0.02, padDepth * 1.1);
    this.shadow.material.opacity = occupancy > 0 ? 0.18 : 0.1;

    this.peg.scale.set(
      clamp(this.anchor.pegRadius * (occupancy > 0 ? 1.4 : 1), 0.12, 0.34),
      occupancy > 0 ? 0.62 : 0.3,
      clamp(this.anchor.pegRadius * (occupancy > 0 ? 1.4 : 1), 0.12, 0.34),
    );
    this.peg.position.y = occupancy > 0 ? 0.28 : 0.14;
    this.peg.material.opacity = occupancy > 0 ? 0.72 : 0.42;
    this.peg.material.emissiveIntensity = occupancy > 0 ? 0.25 + emphasis * 0.2 : 0.04;

    this.pad.scale.set(Math.max(0.001, padWidth), Math.max(0.001, padHeight), Math.max(0.001, padDepth));
    this.pad.position.y = padHeight / 2;
    this.pad.material.opacity = occupancy > 0 ? 0.88 : 0.14;
    this.pad.material.emissiveIntensity = inFlight > 0 ? 0.48 : emphasis * 0.16;

    this.leftWall.scale.set(wallThickness, wallHeight, padDepth);
    this.leftWall.position.set(-(padWidth / 2) + wallThickness / 2, wallHeight / 2, 0);
    this.rightWall.scale.set(wallThickness, wallHeight, padDepth);
    this.rightWall.position.set((padWidth / 2) - wallThickness / 2, wallHeight / 2, 0);
    this.backWall.scale.set(padWidth, wallHeight, wallThickness);
    this.backWall.position.set(0, wallHeight / 2, -(padDepth / 2) + wallThickness / 2);
    this.frontRail.scale.set(padWidth, this.current.railHeight, railThickness);
    this.frontRail.position.set(0, this.current.railHeight / 2, (padDepth / 2) - railThickness / 2);

    for (const wall of [this.leftWall, this.rightWall, this.backWall, this.frontRail]) {
      wall.visible = occupancy > 0 || inFlight > 0 || highlighted || searchMatch;
      wall.material.opacity = wall === this.frontRail ? 0.9 : 0.65;
      wall.material.emissiveIntensity = inFlight > 0 ? 0.36 : emphasis * 0.1;
    }

    for (let index = 0; index < this.trays.length; index += 1) {
      const tray = this.trays[index];
      tray.visible = index < this.current.trayCount;
      if (!tray.visible) continue;
      tray.scale.set(padWidth * 0.92, this.current.trayThickness, padDepth * 0.88);
      tray.position.set(0, padHeight + 0.12 + index * this.current.trayGap, 0);
      tray.material.opacity = 0.18 + (index * 0.04);
      tray.material.emissiveIntensity = emphasis * 0.06;
    }

    const glowMat = withAlpha(this.color, 0.16 + emphasis * 0.12);
    this.pad.material.color.set(glowMat.color);
    this.peg.material.color.set(glowMat.color);
    for (const wall of [this.leftWall, this.rightWall, this.backWall, this.frontRail, ...this.trays]) {
      wall.material.color.set(glowMat.color);
    }
  }

  getSlotTarget(slotIndex) {
    return computeDockSlotPosition(slotIndex, this.anchor, this.target || this.current);
  }

  getLabelAnchor() {
    return {
      x: this.anchor.x - this.current.floorWidth / 2 + 0.3,
      y: this.anchor.baseY + this.current.wallHeight + 0.26,
      z: this.anchor.z + this.current.floorDepth / 2 - 0.18,
    };
  }

  getBadgeAnchor() {
    return {
      x: this.anchor.x + this.current.floorWidth / 2 - 0.18,
      y: this.anchor.baseY + this.current.wallHeight + 0.28,
      z: this.anchor.z + this.current.floorDepth / 2 - 0.18,
    };
  }
}
