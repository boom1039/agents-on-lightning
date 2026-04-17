import {
  DOC_CATALOG,
  DOMAIN_ORDER,
  ROUTE_CATALOG,
  resolveTrackedSurface,
} from '../../src/monitor/agent-surface-inventory.js';

export const JOURNEY_DOMAIN_ORDER = ['mcp', ...DOMAIN_ORDER, 'other'];
const ROUTE_BY_KEY = new Map(ROUTE_CATALOG.map((route) => [route.key, route]));
const DOC_BY_KEY = new Map(DOC_CATALOG.map((doc) => [doc.key, doc]));

function classifyFallbackDomain(path = '') {
  if (path.startsWith('mcp:')) return 'mcp';
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
  if (path.startsWith('/api/v1/agents/') || path.startsWith('/api/v1/node/')) return 'identity';
  if (path.startsWith('/api/v1/wallet/') || path === '/api/v1/ledger') return 'wallet';
  if (path.startsWith('/api/v1/analysis/')) return 'analysis';
  if (
    path.startsWith('/api/v1/messages')
    || path.startsWith('/api/v1/leaderboard')
    || path.startsWith('/api/v1/bounties')
  ) return 'social';
  if (path.startsWith('/api/v1/channels/')) return 'channels';
  if (path.startsWith('/api/v1/market/')) return 'market';
  if (path.startsWith('/api/v1/analytics/')) return 'analytics';
  if (path.startsWith('/api/v1/capital/') || path === '/api/v1/help') return 'capital';
  return 'other';
}

function classifyFallbackGroup(path = '') {
  if (path.startsWith('mcp:')) return 'tools';
  if (path === '/' || path === '/llms.txt' || path === '/health') return 'app';
  if (path.startsWith('/docs/')) return 'docs';
  if (!path.startsWith('/api/v1/')) return 'other';
  const parts = path.split('/').filter(Boolean);
  return parts[2] || 'root';
}

function toMcpSurface(toolName, rawPath = '') {
  const normalizedName = toolName || rawPath.replace(/^mcp:/, '') || '[unknown-tool]';
  const path = `mcp:${normalizedName}`;
  return {
    routeKey: `MCP ${path}`,
    routeLabel: normalizedName,
    routePath: path,
    rawPath: rawPath || path,
    method: 'MCP',
    domain: 'mcp',
    group: 'tools',
    surfaceType: 'mcp_tool',
    canonical: true,
    summary: 'Hosted MCP named tool call.',
    auth: null,
    security: null,
    sourceFile: null,
    sourceLine: null,
    tags: ['mcp', 'tool'],
    docId: null,
    docTitle: null,
    docKind: null,
    docIds: [],
    linkedRouteKeys: [],
    linkedDocIds: [],
  };
}

function toSurface({ kind, entry, rawPath }) {
  const path = entry.path;
  return {
    routeKey: entry.key,
    routeLabel: entry.endpoint || entry.label || path,
    routePath: path,
    rawPath: rawPath || path,
    method: entry.method,
    domain: entry.domain || classifyFallbackDomain(path),
    group: entry.group || entry.subgroup || classifyFallbackGroup(path),
    surfaceType: kind === 'doc' ? 'doc' : kind === 'route' ? 'api' : 'other',
    canonical: kind === 'doc' ? true : kind === 'route' ? entry.canonical !== false : false,
    summary: entry.summary || null,
    auth: kind === 'route' ? entry.auth || null : null,
    security: kind === 'route' && entry.security ? { ...entry.security } : null,
    sourceFile: entry.source_file || null,
    sourceLine: Number.isInteger(entry.source_line) ? entry.source_line : null,
    tags: Array.isArray(entry.tags) ? entry.tags.slice() : [],
    docId: kind === 'doc' ? entry.doc_id || null : null,
    docTitle: kind === 'doc' ? entry.title || null : null,
    docKind: kind === 'doc' ? entry.kind || entry.docKind || null : null,
    docIds: Array.isArray(entry.doc_ids) ? entry.doc_ids.slice() : [],
    linkedRouteKeys: Array.isArray(entry.route_keys) ? entry.route_keys.slice() : [],
    linkedDocIds: Array.isArray(entry.linked_doc_ids) ? entry.linked_doc_ids.slice() : [],
  };
}

export function describeJourneySurface(event) {
  const method = String(event?.method || 'GET').toUpperCase();
  const path = String(event?.path || event?.rawPath || '');
  if (event?.mcp_tool_name || path.startsWith('mcp:')) {
    return toMcpSurface(event?.mcp_tool_name || null, path);
  }
  const surfaceKey = typeof event?.surface_key === 'string' ? event.surface_key : null;
  const exactDoc = surfaceKey ? DOC_BY_KEY.get(surfaceKey) : null;
  if (exactDoc) {
    return toSurface({
      kind: 'doc',
      entry: exactDoc,
      rawPath: path,
    });
  }

  const exactRoute = surfaceKey ? ROUTE_BY_KEY.get(surfaceKey) : null;
  if (exactRoute) {
    return toSurface({
      kind: 'route',
      entry: exactRoute,
      rawPath: path,
    });
  }

  const trackedSurface = resolveTrackedSurface({
    method,
    path,
    doc_kind: event?.doc_kind || null,
  });
  if (trackedSurface) {
    return toSurface({
      kind: trackedSurface.kind,
      entry: trackedSurface.entry,
      rawPath: path,
    });
  }

  return toSurface({
    kind: 'other',
    entry: {
      key: `${method} ${path || '[unknown]'}`,
      method,
      path,
      label: path || '[unknown]',
      domain: classifyFallbackDomain(path),
    },
    rawPath: path,
  });
}

export function listKnownJourneySurfaces() {
  const apiSurfaces = ROUTE_CATALOG.map((route) => toSurface({
    kind: 'route',
    entry: route,
  }));
  const docSurfaces = DOC_CATALOG.map((doc) => toSurface({
    kind: 'doc',
    entry: doc,
  }));
  return [...apiSurfaces, ...docSurfaces];
}
