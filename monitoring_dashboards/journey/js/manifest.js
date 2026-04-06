export const MANIFEST = [];
export const routeKeyMap = new Map();
export const PHASES = [];
export let TOTAL_ROUTES = 0;

let manifestLoaded = false;

function routeSort(a, b) {
  const phaseDelta = (a.phase || 0) - (b.phase || 0);
  if (phaseDelta !== 0) return phaseDelta;
  const orderA = Number.isInteger(a.order) ? a.order : Number.MAX_SAFE_INTEGER;
  const orderB = Number.isInteger(b.order) ? b.order : Number.MAX_SAFE_INTEGER;
  if (orderA !== orderB) return orderA - orderB;
  const subgroupDelta = String(a.subgroup || '').localeCompare(String(b.subgroup || ''));
  if (subgroupDelta !== 0) return subgroupDelta;
  const pathDelta = String(a.path || '').localeCompare(String(b.path || ''));
  if (pathDelta !== 0) return pathDelta;
  return String(a.method || 'GET').localeCompare(String(b.method || 'GET'));
}

function normalizeRoute(route = {}) {
  const journey = route.journey || {};
  const phase = Number.isInteger(route.phase) ? route.phase : journey.phase;
  const phaseName = route.phase_name || journey.phase_name || `Group ${phase || '?'}`;
  return {
    routeKey: route.key,
    method: route.method,
    path: route.path,
    phase,
    phaseName,
    subgroup: route.group || route.subgroup || journey.subgroup || 'Other',
    endpoint: route.endpoint || journey.endpoint || route.label || route.path,
    order: Number.isInteger(route.order) ? route.order : (Number.isInteger(journey.order) ? journey.order : null),
    domain: route.domain || journey.phase_key || 'other',
    summary: route.summary || null,
    auth: route.auth || null,
    tags: Array.isArray(route.tags) ? route.tags.slice() : [],
    security: route.security ? { ...route.security } : null,
    sourceFile: route.source_file || null,
    sourceLine: Number.isInteger(route.source_line) ? route.source_line : null,
  };
}

function replaceList(target, values) {
  target.length = 0;
  target.push(...values);
}

export function getPhaseName(phase) {
  return PHASES.find((entry) => entry.id === phase)?.name || `Group ${phase}`;
}

function resolveManifestUrl(baseUrl = null) {
  if (baseUrl) return new URL('/api/journey/manifest', baseUrl).toString();
  if (typeof window !== 'undefined' && window.location?.origin) {
    return new URL('/api/journey/manifest', window.location.origin).toString();
  }
  return '/api/journey/manifest';
}

export async function loadManifest(baseUrl = null) {
  if (manifestLoaded) return MANIFEST;

  const response = await fetch(resolveManifestUrl(baseUrl), { cache: 'no-store' });
  if (!response.ok) throw new Error(`manifest load failed: ${response.status}`);
  const payload = await response.json();

  const phases = Array.isArray(payload.journey_phases)
    ? payload.journey_phases.map((phase) => ({ ...phase }))
    : [];
  const routes = Array.isArray(payload.routes)
    ? payload.routes
      .filter((route) => route.canonical !== false)
      .map(normalizeRoute)
      .sort(routeSort)
    : [];

  replaceList(PHASES, phases);
  replaceList(MANIFEST, routes);
  routeKeyMap.clear();
  for (const route of MANIFEST) routeKeyMap.set(route.routeKey, route);
  TOTAL_ROUTES = MANIFEST.length;
  manifestLoaded = true;
  return MANIFEST;
}
