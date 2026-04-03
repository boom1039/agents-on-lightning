export const ATLAS_LEFT_DOMAINS = ['app-level', 'discovery', 'identity', 'wallet', 'analysis'];
export const ATLAS_RIGHT_DOMAINS = ['social', 'channels', 'market', 'analytics', 'capital', 'other'];
export const ATLAS_DOMAIN_ORDER = [...ATLAS_LEFT_DOMAINS, ...ATLAS_RIGHT_DOMAINS];

export const ATLAS_WORLD = {
  width: 122,
  depth: 76,
  margin: 4,
  gutter: 4,
  labelBand: 7.5,
  rowGap: 1.5,
  colGap: 1.5,
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

export function buildAtlasLayout(routes = [], options = {}) {
  const world = {
    ...ATLAS_WORLD,
    ...options,
  };
  const board = {
    x: 0,
    z: 0,
    width: world.width,
    depth: world.depth,
  };

  const leftWeight = ATLAS_LEFT_DOMAINS.reduce((sum, domain) => {
    const count = routes.filter((route) => route.domain === domain).length;
    return sum + 1 + Math.sqrt(Math.max(1, count));
  }, 0);
  const rightWeight = ATLAS_RIGHT_DOMAINS.reduce((sum, domain) => {
    const count = routes.filter((route) => route.domain === domain).length;
    return sum + 1 + Math.sqrt(Math.max(1, count));
  }, 0);

  const usableWidth = world.width - (world.margin * 2) - world.gutter;
  const leftWidth = usableWidth * (leftWeight / Math.max(1, leftWeight + rightWeight));
  const rightWidth = usableWidth - leftWidth;
  const topZ = -world.depth / 2 + world.margin;
  const leftX = -world.width / 2 + world.margin + leftWidth / 2;
  const rightX = leftX + leftWidth / 2 + world.gutter + rightWidth / 2;
  const usableDepth = world.depth - (world.margin * 2);

  const domains = new Map();
  const routeAnchors = new Map();

  for (const column of [
    { domains: ATLAS_LEFT_DOMAINS, x: leftX, width: leftWidth },
    { domains: ATLAS_RIGHT_DOMAINS, x: rightX, width: rightWidth },
  ]) {
    const weights = column.domains.map((domain) => {
      const count = routes.filter((route) => route.domain === domain).length;
      return 1 + Math.sqrt(Math.max(1, count));
    });
    const totalWeight = weights.reduce((sum, value) => sum + value, 0) || 1;
    let cursorZ = topZ;

    for (let i = 0; i < column.domains.length; i += 1) {
      const domain = column.domains[i];
      const height = usableDepth * (weights[i] / totalWeight);
      const domainRoutes = sortAtlasRoutes(routes.filter((route) => route.domain === domain));
      const panel = {
        domain,
        x: column.x,
        z: cursorZ + height / 2,
        width: column.width,
        depth: height,
        innerX: column.x + (world.labelBand / 2),
        innerWidth: Math.max(8, column.width - world.labelBand - world.colGap),
        innerDepth: Math.max(8, height - world.rowGap * 2),
        routeCount: domainRoutes.length,
      };
      domains.set(domain, panel);
      cursorZ += height;

      if (domainRoutes.length === 0) continue;

      const innerLeft = panel.x - (panel.width / 2) + world.labelBand;
      const innerTop = panel.z - (panel.depth / 2) + world.rowGap;
      const innerWidth = panel.width - world.labelBand - world.colGap;
      const innerDepth = panel.depth - (world.rowGap * 2);
      const cols = Math.max(1, Math.ceil(Math.sqrt(domainRoutes.length * (innerWidth / Math.max(innerDepth, 1)))));
      const rows = Math.max(1, Math.ceil(domainRoutes.length / cols));
      const cellWidth = innerWidth / cols;
      const cellDepth = innerDepth / rows;

      for (let idx = 0; idx < domainRoutes.length; idx += 1) {
        const route = domainRoutes[idx];
        const col = idx % cols;
        const row = Math.floor(idx / cols);
        const cell = {
          routeKey: route.routeKey,
          route,
          x: innerLeft + col * cellWidth + cellWidth / 2,
          z: innerTop + row * cellDepth + cellDepth / 2,
          width: Math.max(1.6, cellWidth - world.colGap),
          depth: Math.max(1.6, cellDepth - world.rowGap),
          domain,
          row,
          col,
        };
        routeAnchors.set(route.routeKey, cell);
      }
    }
  }

  return {
    board,
    domains,
    routeAnchors,
  };
}

export function computeRouteVisual(cell, occupancy = 0, inFlight = 0, options = {}) {
  const dotDiameter = options.dotDiameter || 0.44;
  const dotGap = options.dotGap || 0.12;
  const baseHeight = options.baseHeight || 0.2;
  const maxScale = options.maxScale || 1.35;
  const livePressure = Math.max(0, occupancy + (inFlight * 0.35));
  const growth = livePressure <= 1 ? 1 : 1 + Math.min(maxScale - 1, Math.log2(livePressure + 1) * 0.15);
  const maxWidth = cell.width * 0.94;
  const maxDepth = cell.depth * 0.94;
  const width = clamp(cell.width * 0.68 * growth, Math.min(1.4, cell.width * 0.55), maxWidth);
  const depth = clamp(cell.depth * 0.62 * growth, Math.min(1.2, cell.depth * 0.5), maxDepth);
  const cols = Math.max(1, Math.floor((width - 0.35) / (dotDiameter + dotGap)));
  const rows = Math.max(1, Math.floor((depth - 0.55) / (dotDiameter + dotGap)));
  const trayCapacity = Math.max(1, cols * rows);
  const trayCount = Math.max(1, Math.ceil(Math.max(1, occupancy) / trayCapacity));
  const height = baseHeight + Math.min(0.3, (trayCount - 1) * 0.06) + Math.min(0.18, Math.log2(livePressure + 1) * 0.05);
  return {
    width,
    depth,
    height,
    trayCount,
    trayCapacity,
    cols,
    rows,
    dotDiameter,
    dotGap,
    topY: height / 2,
    envelopeWidth: maxWidth,
    envelopeDepth: maxDepth,
  };
}

export function computeSlotPosition(slotIndex, cell, visual) {
  const safeIndex = Math.max(0, slotIndex);
  const trayIndex = Math.floor(safeIndex / visual.trayCapacity);
  const traySlot = safeIndex % visual.trayCapacity;
  const col = traySlot % visual.cols;
  const row = Math.floor(traySlot / visual.cols);
  const spacingX = visual.cols <= 1 ? 0 : visual.width / visual.cols;
  const spacingZ = visual.rows <= 1 ? 0 : visual.depth / visual.rows;
  const x = cell.x - visual.width / 2 + spacingX * (col + 0.5);
  const z = cell.z - visual.depth / 2 + spacingZ * (row + 0.5);
  const y = visual.topY + 0.16 + trayIndex * 0.38;
  return {
    x,
    y,
    z,
    trayIndex,
  };
}

export function buildAtlasRouteSignature(routes = []) {
  return sortAtlasRoutes(routes)
    .map((route) => `${route.routeKey}|${route.domain}|${route.group}|${route.method}|${route.routePath || route.routeLabel || ''}`)
    .join(';');
}
