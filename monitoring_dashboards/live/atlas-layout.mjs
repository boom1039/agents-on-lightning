export const ATLAS_DOMAIN_ORDER = [
  'app-level',
  'discovery',
  'identity',
  'wallet',
  'analysis',
  'social',
  'channels',
  'market',
  'analytics',
  'capital',
  'other',
];

export const ATLAS_DOMAIN_LABELS = {
  'app-level': 'App / Docs',
  discovery: 'Discovery',
  identity: 'Identity',
  wallet: 'Wallet',
  analysis: 'Analysis',
  social: 'Social',
  channels: 'Channels',
  market: 'Market',
  analytics: 'Analytics',
  capital: 'Capital',
  other: 'Other',
};

export const ATLAS_WORLD = {
  width: 160,
  depth: 104,
  boardHeight: 0.72,
};

export const ATLAS_DOMAIN_LAYOUT = {
  'app-level': {
    x: -46,
    z: -35,
    width: 28,
    depth: 12,
    islandHeight: 0.56,
    paddingX: 2.4,
    paddingZ: 2.1,
    minPitch: 2.5,
  },
  discovery: {
    x: -10,
    z: -33,
    width: 36,
    depth: 14,
    islandHeight: 0.58,
    paddingX: 2.6,
    paddingZ: 2.2,
    minPitch: 2.8,
  },
  identity: {
    x: -44,
    z: -3,
    width: 32,
    depth: 22,
    islandHeight: 0.76,
    paddingX: 2.8,
    paddingZ: 2.4,
    minPitch: 3.2,
  },
  wallet: {
    x: -44,
    z: 25,
    width: 30,
    depth: 16,
    islandHeight: 0.68,
    paddingX: 2.5,
    paddingZ: 2.2,
    minPitch: 3.0,
  },
  analysis: {
    x: -45,
    z: 42,
    width: 24,
    depth: 10,
    islandHeight: 0.62,
    paddingX: 2.1,
    paddingZ: 2.0,
    minPitch: 3.2,
  },
  social: {
    x: 44,
    z: -34,
    width: 28,
    depth: 12,
    islandHeight: 0.62,
    paddingX: 2.4,
    paddingZ: 2.1,
    minPitch: 2.8,
  },
  channels: {
    x: 46,
    z: -18,
    width: 26,
    depth: 9,
    islandHeight: 0.58,
    paddingX: 2.3,
    paddingZ: 1.8,
    minPitch: 2.8,
  },
  market: {
    x: 20,
    z: 2,
    width: 62,
    depth: 30,
    islandHeight: 0.9,
    paddingX: 3.4,
    paddingZ: 2.8,
    minPitch: 2.4,
  },
  analytics: {
    x: 6,
    z: 31,
    width: 22,
    depth: 10,
    islandHeight: 0.66,
    paddingX: 2.1,
    paddingZ: 1.9,
    minPitch: 3.0,
  },
  capital: {
    x: 33,
    z: 31,
    width: 24,
    depth: 10,
    islandHeight: 0.66,
    paddingX: 2.1,
    paddingZ: 1.9,
    minPitch: 3.0,
  },
  other: {
    x: 46,
    z: 44,
    width: 30,
    depth: 12,
    islandHeight: 0.58,
    paddingX: 2.4,
    paddingZ: 2.1,
    minPitch: 2.8,
  },
};

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function routeSortKey(route) {
  return [
    String(route.group || ''),
    String(route.routePath || route.routeLabel || ''),
    String(route.method || 'GET'),
  ].join('|');
}

export function sortAtlasRoutes(routes = []) {
  return [...routes].sort((a, b) => routeSortKey(a).localeCompare(routeSortKey(b)));
}

export function compactAtlasPath(path = '') {
  return String(path || '')
    .replace(/^\/api\/v1\//, '')
    .replace(/^\/docs\//, 'docs/')
    .replace(/^\/+/, '');
}

export function shortRouteLabel(route = {}) {
  const raw = compactAtlasPath(route.routePath || route.routeLabel || '');
  if (!raw) return `${String(route.method || 'GET').slice(0, 3)} home`;
  const parts = raw.split('/').filter(Boolean);
  let compact = raw;
  if (parts.length > 3) {
    compact = `${parts[0]}/${parts[1]}/${parts[parts.length - 1]}`;
  }
  if (compact.length > 24) compact = `${compact.slice(0, 21)}…`;
  return `${String(route.method || 'GET').slice(0, 3)} ${compact}`;
}

function layoutDomainAnchors(domain, routes) {
  const spec = ATLAS_DOMAIN_LAYOUT[domain];
  if (!spec) return [];

  const innerWidth = Math.max(4, spec.width - (spec.paddingX * 2));
  const innerDepth = Math.max(4, spec.depth - (spec.paddingZ * 2));
  const sortedRoutes = sortAtlasRoutes(routes);
  const groups = [];
  const groupMap = new Map();

  for (const route of sortedRoutes) {
    const key = String(route.group || 'other');
    if (!groupMap.has(key)) {
      const bucket = [];
      groupMap.set(key, bucket);
      groups.push([key, bucket]);
    }
    groupMap.get(key).push(route);
  }

  const count = Math.max(1, sortedRoutes.length);
  const maxCols = Math.max(1, Math.floor(innerWidth / spec.minPitch));
  const cols = clamp(
    Math.round(Math.sqrt(count * (innerWidth / Math.max(innerDepth, 1)))),
    1,
    maxCols,
  );
  const totalRows = groups.reduce((sum, [, bucket]) => sum + Math.max(1, Math.ceil(bucket.length / cols)), 0)
    + Math.max(0, groups.length - 1);
  const pitchX = innerWidth / cols;
  const pitchZ = innerDepth / Math.max(1, totalRows);
  const left = spec.x - (spec.width / 2) + spec.paddingX;
  const top = spec.z - (spec.depth / 2) + spec.paddingZ;
  const anchors = [];
  let rowCursor = 0;

  for (const [groupName, bucket] of groups) {
    const rowsForGroup = Math.max(1, Math.ceil(bucket.length / cols));
    for (let idx = 0; idx < bucket.length; idx += 1) {
      const route = bucket[idx];
      const localRow = Math.floor(idx / cols);
      const row = rowCursor + localRow;
      const col = idx % cols;
      const rowOffset = row % 2 === 1 ? 0.2 : 0;
      const x = clamp(
        left + pitchX * (col + 0.5 + rowOffset),
        spec.x - spec.width / 2 + spec.paddingX + pitchX * 0.5,
        spec.x + spec.width / 2 - spec.paddingX - pitchX * 0.5,
      );
      const z = top + pitchZ * (row + 0.5);
      anchors.push({
        routeKey: route.routeKey,
        route,
        domain,
        group: groupName,
        x,
        z,
        baseY: spec.islandHeight,
        envelopeWidth: clamp(pitchX * 0.82, 1.45, 4.8),
        envelopeDepth: clamp(pitchZ * 0.8, 1.25, 3.4),
        pegRadius: clamp(Math.min(pitchX, pitchZ) * 0.085, 0.09, 0.18),
        pitchX,
        pitchZ,
        row,
        col,
      });
    }
    rowCursor += rowsForGroup + 1;
  }

  return anchors;
}

export function buildAtlasLayout(routes = []) {
  const board = {
    x: 0,
    z: 0,
    width: ATLAS_WORLD.width,
    depth: ATLAS_WORLD.depth,
    height: ATLAS_WORLD.boardHeight,
  };

  const domains = new Map();
  for (const domain of ATLAS_DOMAIN_ORDER) {
    const spec = ATLAS_DOMAIN_LAYOUT[domain];
    domains.set(domain, {
      domain,
      label: ATLAS_DOMAIN_LABELS[domain] || domain,
      x: spec.x,
      z: spec.z,
      width: spec.width,
      depth: spec.depth,
      islandHeight: spec.islandHeight,
      paddingX: spec.paddingX,
      paddingZ: spec.paddingZ,
    });
  }

  const routesByDomain = new Map();
  for (const domain of ATLAS_DOMAIN_ORDER) routesByDomain.set(domain, []);
  for (const route of routes) {
    const domain = ATLAS_DOMAIN_LAYOUT[route.domain] ? route.domain : 'other';
    routesByDomain.get(domain).push(route);
  }

  const routeAnchors = new Map();
  for (const domain of ATLAS_DOMAIN_ORDER) {
    for (const anchor of layoutDomainAnchors(domain, routesByDomain.get(domain) || [])) {
      routeAnchors.set(anchor.routeKey, anchor);
    }
  }

  return {
    board,
    domains,
    routeAnchors,
  };
}

export function buildAtlasRouteSignature(routes = []) {
  return sortAtlasRoutes(routes)
    .map((route) => `${route.routeKey}|${route.domain}|${route.group}|${route.method}|${route.routePath || route.routeLabel || ''}`)
    .join(';');
}
