import {
  DOC_CATALOG,
  DOMAIN_ORDER,
  matchAgentFacingRoute,
  matchDocSurface,
  ROUTE_CATALOG,
} from '../../src/monitor/agent-surface-inventory.js';

export const JOURNEY_DOMAIN_ORDER = [...DOMAIN_ORDER, 'other'];

function classifyFallbackDomain(path = '') {
  if (path === '/' || path === '/llms.txt' || path === '/health' || path.startsWith('/docs/')) return 'app-level';
  if (
    path === '/api/v1/'
    || path.startsWith('/api/v1/platform/')
    || path === '/api/v1/ethos'
    || path === '/api/v1/capabilities'
    || path.startsWith('/api/v1/strategies')
    || path.startsWith('/api/v1/knowledge/')
    || path.startsWith('/api/v1/skills')
  ) return 'discovery';
  if (path.startsWith('/api/v1/agents/') || path.startsWith('/api/v1/node/') || path.startsWith('/api/v1/actions/')) return 'identity';
  if (path.startsWith('/api/v1/wallet/') || path === '/api/v1/ledger') return 'wallet';
  if (path.startsWith('/api/v1/analysis/')) return 'analysis';
  if (
    path.startsWith('/api/v1/messages')
    || path.startsWith('/api/v1/alliances')
    || path.startsWith('/api/v1/leaderboard')
    || path.startsWith('/api/v1/tournaments')
    || path.startsWith('/api/v1/bounties')
  ) return 'social';
  if (path.startsWith('/api/v1/channels/')) return 'channels';
  if (path.startsWith('/api/v1/market/')) return 'market';
  if (path.startsWith('/api/v1/analytics/')) return 'analytics';
  if (path.startsWith('/api/v1/capital/') || path === '/api/v1/help') return 'capital';
  return 'other';
}

function classifyRouteGroup(path = '') {
  if (path === '/' || path === '/llms.txt' || path === '/health') return 'app';
  if (path.startsWith('/docs/')) return 'docs';
  if (!path.startsWith('/api/v1/')) return 'other';
  const parts = path.split('/').filter(Boolean);
  return parts[2] || 'root';
}

function toSurface({
  key,
  method,
  path,
  label,
  domain,
  group,
  surfaceType,
  canonical,
  rawPath,
}) {
  return {
    routeKey: key,
    routeLabel: label || path,
    routePath: path,
    rawPath: rawPath || path,
    method,
    domain,
    group,
    surfaceType,
    canonical,
  };
}

export function describeJourneySurface(event) {
  const method = String(event?.method || 'GET').toUpperCase();
  const path = String(event?.path || event?.rawPath || '');
  const route = matchAgentFacingRoute(method, path);
  if (route) {
    return toSurface({
      key: route.key,
      method: route.method,
      path: route.path,
      label: route.path,
      domain: route.domain,
      group: classifyRouteGroup(route.path),
      surfaceType: 'api',
      canonical: true,
      rawPath: path,
    });
  }

  const doc = matchDocSurface({ method, path, doc_kind: event?.doc_kind || null });
  if (doc) {
    return toSurface({
      key: doc.key,
      method: doc.method,
      path: doc.path,
      label: doc.label,
      domain: classifyFallbackDomain(doc.path),
      group: classifyRouteGroup(doc.path),
      surfaceType: 'doc',
      canonical: true,
      rawPath: path,
    });
  }

  return toSurface({
    key: `${method} ${path || '[unknown]'}`,
    method,
    path,
    label: path || '[unknown]',
    domain: classifyFallbackDomain(path),
    group: classifyRouteGroup(path),
    surfaceType: 'other',
    canonical: false,
    rawPath: path,
  });
}

export function listKnownJourneySurfaces() {
  const apiSurfaces = ROUTE_CATALOG.map(route => describeJourneySurface({
    method: route.method,
    path: route.path,
  }));
  const docSurfaces = DOC_CATALOG.map(doc => describeJourneySurface({
    method: doc.method,
    path: doc.path,
    doc_kind: doc.docKind || null,
  }));
  return [...apiSurfaces, ...docSurfaces];
}
