import * as THREE from 'three';
import { WIRE, RMIN, RD, RW, SGH, PHH, MB,
         SPRITE_FONT_PX, SPRITE_PAD, PHASE_NAMES, styleState } from './constants.js';
import { scene } from './scene.js';

// Shared collections (populated by buildScene)
export const routeBoxes = new Map();   // routeKey → { mesh, hitMesh, label, mat, pos, entry, targetH, curH, stats }
export const routeMeshArr = [];        // for raycasting
export const phaseBadges = new Map();  // phaseNum → sprite
export const phaseGroups = new Map();  // phaseNum → THREE.Group
export const sgGroups = new Map();     // "phase:sgName" → { group, hit, phase, sgName, routes[] }
export const phaseMats = [];
export const sgMats = [];
export const labelStore = { phase: [], phaseBadge: [], sg: [], route: [] };
export const phaseHitArr = [];
export const routeHitMap = new Map();
export const phaseLabelArr = [];   // phase label sprites for raycasting (layer 5)
export const routeLabelArr = [];  // route label sprites for raycasting (layer 6)

// Saved phase label positions (from layout dump — D key)
const SAVED_LABEL_POS = new Map([
  // populated via D key dump → _phaseLabels
]);

// Text sprites

export function makeTextSprite(text, opts = {}) {
  const fw = opts.fontWeight || '600';
  const wh = opts.worldHeight || 1.0;
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  const font = `${fw} ${SPRITE_FONT_PX}px system-ui,-apple-system,sans-serif`;
  ctx.font = font;
  const tw = Math.ceil(ctx.measureText(text).width + SPRITE_PAD * 2);
  const th = Math.ceil(SPRITE_FONT_PX * 1.4 + SPRITE_PAD);
  canvas.width = tw; canvas.height = th;
  ctx.font = font;
  ctx.fillStyle = '#ffffff';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, SPRITE_PAD, th / 2);
  const texture = new THREE.CanvasTexture(canvas);
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  const material = new THREE.SpriteMaterial({
    map: texture, transparent: true, depthTest: false, depthWrite: false,
    color: new THREE.Color(opts.color || '#ffffff'), opacity: opts.opacity ?? 1,
  });
  const sprite = new THREE.Sprite(material);
  sprite.center.set(0, 0.5);
  const aspect = tw / th;
  sprite.scale.set(wh * aspect, wh, 1);
  sprite.userData._canvas = canvas;
  sprite.userData._texture = texture;
  sprite.userData._aspect = aspect;
  sprite.userData._baseHeight = wh;
  sprite.userData._fontWeight = fw;
  return sprite;
}

export function updateSpriteText(sprite, newText) {
  const canvas = sprite.userData._canvas;
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const font = `${sprite.userData._fontWeight || '600'} ${SPRITE_FONT_PX}px system-ui,-apple-system,sans-serif`;
  ctx.font = font;
  const needed = Math.ceil(ctx.measureText(newText).width + SPRITE_PAD * 2);
  const resized = needed > canvas.width;
  if (resized) { canvas.width = needed; ctx.font = font; }
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = '#ffffff';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.fillText(newText, SPRITE_PAD, canvas.height / 2);
  if (resized) {
    // Canvas backing store changed size — dispose old GPU texture to avoid
    // ANGLE glCopySubTextureCHROMIUM offset overflow on stale dimensions.
    sprite.userData._texture.dispose();
    const tex = new THREE.CanvasTexture(canvas);
    tex.minFilter = THREE.LinearFilter;
    tex.magFilter = THREE.LinearFilter;
    sprite.material.map = tex;
    sprite.userData._texture = tex;
  } else {
    sprite.userData._texture.needsUpdate = true;
  }
  const aspect = canvas.width / canvas.height;
  const h = sprite.userData._baseHeight;
  sprite.scale.set(h * aspect, h, 1);
  sprite.userData._aspect = aspect;
}

export function anchorXZ(anchor, cx, cz, hx, hz) {
  let x = cx, z = cz;
  if (anchor.includes('l')) x = cx - hx;
  else if (anchor.includes('r')) x = cx + hx;
  if (anchor.startsWith('t')) z = cz + hz;
  else if (anchor.startsWith('b')) z = cz - hz;
  return { x, z };
}

export function applyAnchor(tier, anchor) {
  for (const s of labelStore[tier] || []) {
    const b = s.userData.box;
    if (!b) continue;
    const p = anchorXZ(anchor, b.cx, b.cz, b.hx, b.hz);
    s.position.x = p.x;
    s.position.z = p.z;
  }
  if (tier === 'phase') syncBadgePositions();
}

export function syncBadgePositions() {
  for (let i = 0; i < labelStore.phase.length; i++) {
    const pl = labelStore.phase[i];
    const pb = labelStore.phaseBadge[i];
    if (pl && pb) {
      pb.position.x = pl.position.x;
      pb.position.z = pl.position.z;
      pb.position.y = pl.position.y + (pb.userData.yOffsetFromLabel || -1.5);
    }
  }
}

function edgeBox(w, h, d, opacity, color = WIRE) {
  const box = new THREE.BoxGeometry(w, h, d);
  const edges = new THREE.EdgesGeometry(box);
  box.dispose();
  const mat = new THREE.LineBasicMaterial({ color, transparent: true, opacity });
  return { obj: new THREE.LineSegments(edges, mat), mat };
}

// Scene teardown — dispose all phase groups and clear collections

export function clearScene() {
  for (const [, group] of phaseGroups) {
    group.traverse(obj => {
      if (obj.geometry) obj.geometry.dispose();
      if (obj.material) {
        if (obj.material.map) obj.material.map.dispose();
        obj.material.dispose();
      }
    });
    scene.remove(group);
  }
  routeBoxes.clear();
  routeMeshArr.length = 0;
  phaseBadges.clear();
  phaseGroups.clear();
  sgGroups.clear();
  phaseMats.length = 0;
  sgMats.length = 0;
  for (const k of Object.keys(labelStore)) labelStore[k].length = 0;
  phaseHitArr.length = 0;
  routeHitMap.clear();
  phaseLabelArr.length = 0;
  routeLabelArr.length = 0;
}

// Scene graph builder

export function buildScene(layout, style = {}) {
  const { showSgWires = true, filledRoutes = false } = style;
  for (const [p, ph] of layout) {
    const group = new THREE.Group();
    phaseGroups.set(p, group);

    // Phase outline — flat 2D rectangle on the ground plane
    const phShape = new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(-ph.size.x / 2, 0, -ph.size.z / 2),
      new THREE.Vector3( ph.size.x / 2, 0, -ph.size.z / 2),
      new THREE.Vector3( ph.size.x / 2, 0,  ph.size.z / 2),
      new THREE.Vector3(-ph.size.x / 2, 0,  ph.size.z / 2),
      new THREE.Vector3(-ph.size.x / 2, 0, -ph.size.z / 2),
    ]);
    const phMat = new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.02 });
    const phMesh = new THREE.Line(phShape, phMat);
    phMesh.position.set(ph.pos.x, 0.01, ph.pos.z);
    group.add(phMesh);
    phaseMats.push(phMat);

    // Phase hit volume for dragging (flat)
    const phHitGeo = new THREE.PlaneGeometry(ph.size.x, ph.size.z);
    phHitGeo.rotateX(-Math.PI / 2);
    const phHitMat = new THREE.MeshBasicMaterial({ visible: false });
    const phHit = new THREE.Mesh(phHitGeo, phHitMat);
    phHit.position.set(ph.pos.x, 0.01, ph.pos.z);
    phHit.layers.enable(4);
    phHit.userData.phase = p;
    group.add(phHit);
    phaseHitArr.push(phHit);

    // Phase label
    const phLabel = makeTextSprite(`${p}. ${PHASE_NAMES[p]}`, { worldHeight: 2.0, fontWeight: '700', color: '#e4e4e7' });
    phLabel.userData.box = { cx: ph.pos.x, cz: ph.pos.z, hx: ph.size.x / 2, hz: ph.size.z / 2 };
    const phAnch = anchorXZ(styleState.anchorPhase, ph.pos.x, ph.pos.z, ph.size.x / 2, ph.size.z / 2);
    const savedLbl = SAVED_LABEL_POS.get(p);
    const phLabelX = savedLbl ? savedLbl.x : phAnch.x;
    const phLabelZ = savedLbl ? savedLbl.z : phAnch.z;
    const phLabelY = PHH + 0.8 + 4;
    phLabel.position.set(phLabelX, phLabelY, phLabelZ);
    phLabel.userData.baseY = PHH + 0.8;
    phLabel.userData.phase = p;
    phLabel.layers.enable(5);
    group.add(phLabel);
    labelStore.phase.push(phLabel);
    phaseLabelArr.push(phLabel);

    // Phase badge (agent count under label)
    const badge = makeTextSprite('[0 agents]', { worldHeight: 1.2, fontWeight: '400', color: '#a1a1aa' });
    badge.position.set(phLabelX, phLabelY + styleState.badgeYFromLabel, phLabelZ);
    badge.userData.baseY = PHH + 0.8;
    badge.userData.yOffsetFromLabel = styleState.badgeYFromLabel;
    group.add(badge);
    phaseBadges.set(p, badge);
    labelStore.phaseBadge.push(badge);

    for (const [sgName, sg] of ph.subgroups) {
      const sgGroup = new THREE.Group();
      const sgKey = `${p}:${sgName}`;

      // Subgroup box (optional wireframe)
      if (showSgWires) {
        const { obj: sgMesh, mat: sgMat } = edgeBox(sg.size.x, sg.size.y, sg.size.z, 0, 0xffffff);
        sgMesh.position.copy(sg.pos);
        sgGroup.add(sgMesh);
        sgMats.push(sgMat);
      }

      // Subgroup hit volume for drag
      const sgHitGeo = new THREE.BoxGeometry(sg.size.x, sg.size.y, sg.size.z);
      const sgHitMat = new THREE.MeshBasicMaterial({ visible: false });
      const sgHit = new THREE.Mesh(sgHitGeo, sgHitMat);
      sgHit.position.copy(sg.pos);
      sgHit.layers.enable(3);
      sgHit.userData.sgKey = sgKey;
      sgGroup.add(sgHit);

      // Subgroup label
      const sgLabel = makeTextSprite(sgName, { worldHeight: 1.1, fontWeight: '600', color: '#a1a1aa' });
      sgLabel.userData.box = { cx: sg.pos.x, cz: sg.pos.z, hx: sg.size.x / 2, hz: sg.size.z / 2 };
      const sgAnch = anchorXZ(styleState.anchorSg, sg.pos.x, sg.pos.z, sg.size.x / 2, sg.size.z / 2);
      sgLabel.position.set(sgAnch.x, SGH + 0.3 - 1.1, sgAnch.z);
      sgLabel.userData.baseY = SGH + 0.3;
      sgGroup.add(sgLabel);
      labelStore.sg.push(sgLabel);

      const sgRouteKeys = [];
      for (const r of sg.routes) {
        // Route box (filled or wireframe)
        let rMesh, rMat;
        if (filledRoutes) {
          const rGeo = new THREE.BoxGeometry(RW, RMIN, RD);
          rMat = new THREE.MeshBasicMaterial({ color: WIRE, transparent: true, opacity: 0.15 });
          rMesh = new THREE.Mesh(rGeo, rMat);
        } else {
          const eb = edgeBox(RW, RMIN, RD, 0.3);
          rMesh = eb.obj; rMat = eb.mat;
        }
        rMesh.position.copy(r.pos);
        sgGroup.add(rMesh);

        // Route hit volume for raycasting
        const rHitGeo = new THREE.BoxGeometry(RW, RMIN, RD);
        const rHitMat = new THREE.MeshBasicMaterial({ visible: false });
        const rHit = new THREE.Mesh(rHitGeo, rHitMat);
        rHit.position.copy(r.pos);
        rHit.layers.enable(1);
        sgGroup.add(rHit);
        routeMeshArr.push(rHit);

        // Route label
        const mbadge = MB[r.entry.method] || '?';
        const rLabel = makeTextSprite(`[${mbadge}] ${r.entry.endpoint}`, { worldHeight: 0.65, fontWeight: '400', color: '#888888' });
        rLabel.userData.box = { cx: r.pos.x, cz: r.pos.z, hx: RW / 2, hz: RD / 2 };
        rLabel.userData.phase = p;
        rLabel.userData.anchor = styleState.anchorRoute;
        rLabel.layers.enable(6);
        const rAnch = anchorXZ(styleState.anchorRoute, r.pos.x, r.pos.z, RW / 2, RD / 2);
        rLabel.position.set(rAnch.x, -0.3, rAnch.z + styleState.routeLabelZOff);
        rLabel.userData.baseY = -0.3;
        rLabel.userData.baseZ = rAnch.z;
        sgGroup.add(rLabel);
        labelStore.route.push(rLabel);
        routeLabelArr.push(rLabel);

        sgRouteKeys.push(r.entry.routeKey);
        routeHitMap.set(rHit, r.entry.routeKey);
        routeBoxes.set(r.entry.routeKey, {
          mesh: rMesh, hitMesh: rHit, label: rLabel, mat: rMat,
          pos: r.pos.clone(), entry: r.entry,
          targetH: RMIN, curH: RMIN, yBase: 0,
          stats: { activeAgents: 0, inFlight: 0, finished: 0, status2xx: 0, status4xx: 0, status5xx: 0 },
        });
      }

      group.add(sgGroup);
      sgGroups.set(sgKey, { group: sgGroup, hit: sgHit, phase: p, sgName, routes: sgRouteKeys });
    }

    scene.add(group);
  }
}

// Per-phase route label anchor override

export function applyPhaseRouteAnchor(phase, anchor) {
  for (const s of labelStore.route) {
    if (s.userData.phase !== phase) continue;
    const b = s.userData.box;
    if (!b) continue;
    const pos = anchorXZ(anchor, b.cx, b.cz, b.hx, b.hz);
    s.position.x = pos.x;
    s.position.z = pos.z;
    s.userData.anchor = anchor;
  }
}

export function flipRouteLabel(sprite) {
  const cur = sprite.userData.anchor || 'bl';
  const next = cur.includes('l') ? cur.replace('l', 'r') : cur.replace('r', 'l');
  sprite.userData.anchor = next;
  const b = sprite.userData.box;
  if (!b) return;
  const pos = anchorXZ(next, b.cx, b.cz, b.hx, b.hz);
  sprite.position.x = pos.x;
  sprite.position.z = pos.z;
}

// Animation helper — smoothly grow route boxes based on agent count

export function updateRouteBoxHeights() {
  for (const [, rb] of routeBoxes) {
    if (Math.abs(rb.curH - rb.targetH) < 0.001) continue;
    rb.curH += (rb.targetH - rb.curH) * 0.08;
    const scale = rb.curH / RMIN;
    rb.mesh.scale.y = scale;
    rb.mesh.position.y = rb.curH / 2;
    rb.hitMesh.scale.y = scale;
    rb.hitMesh.position.y = rb.curH / 2;
  }
}
