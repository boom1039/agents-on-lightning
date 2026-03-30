import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..', '..');

const ROUTE_FILES = [
  'src/index.js',
  'src/routes/agent-discovery-routes.js',
  'src/routes/agent-identity-routes.js',
  'src/routes/agent-wallet-routes.js',
  'src/routes/agent-analysis-routes.js',
  'src/routes/agent-social-routes.js',
  'src/routes/channel-accountability-routes.js',
  'src/routes/agent-paid-services-routes.js',
  'src/routes/channel-market-routes.js',
];

const EXCLUDED = new Set([
  'POST /api/v1/test/reset-rate-limits',
  'POST /api/v1/channels/assign',
  'DELETE /api/v1/channels/assign/:chanId',
]);

const SKILL_NAMES = [
  'discovery',
  'identity',
  'wallet',
  'analysis',
  'social',
  'channels',
  'market',
  'analytics',
  'capital',
];

const KNOWLEDGE_TOPICS = [
  'strategy',
  'protocol',
  'rebalancing',
  'operator-wisdom',
  'onboarding',
];

export const DOMAIN_ORDER = [
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
];

function normalizeRoute(method, path) {
  return `${method.toUpperCase()} ${path}`;
}

function extractRoutesFromSource(source) {
  const routes = [];
  const routePattern = /\b(?:router|app)\.(get|post|put|delete|patch)\s*\(\s*(\[[\s\S]*?\]|'[^']+'|"[^"]+")/g;
  let match;
  while ((match = routePattern.exec(source)) !== null) {
    const method = match[1].toUpperCase();
    const raw = match[2].trim();
    const paths = [];
    if (raw.startsWith('[')) {
      for (const item of raw.matchAll(/['"]([^'"]+)['"]/g)) {
        paths.push(item[1]);
      }
    } else {
      paths.push(raw.slice(1, -1));
    }
    for (const path of paths) {
      if (path.startsWith('/')) routes.push(normalizeRoute(method, path));
    }
  }
  return routes;
}

export function collectAgentFacingRoutes() {
  const routes = new Set();
  for (const relativePath of ROUTE_FILES) {
    const source = readFileSync(resolve(ROOT, relativePath), 'utf8');
    for (const route of extractRoutesFromSource(source)) {
      if (!EXCLUDED.has(route) && !route.startsWith('GET /dashboard')) {
        routes.add(route);
      }
    }
  }
  return [...routes].sort();
}

function classifyRouteDomain(path) {
  if (path === '/' || path === '/llms.txt' || path === '/health') return 'app-level';
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
  ) return 'social';
  if (path.startsWith('/api/v1/channels/')) return 'channels';
  if (path.startsWith('/api/v1/market/')) return 'market';
  if (path.startsWith('/api/v1/analytics/')) return 'analytics';
  if (path.startsWith('/api/v1/capital/') || path === '/api/v1/help') return 'capital';
  return 'other';
}

function escapeRegex(text) {
  return text.replace(/[|\\{}()[\]^$+*?.]/g, '\\$&');
}

function pathPatternToRegex(path) {
  if (path === '/') return /^\/$/;
  const parts = path.split('/').filter(Boolean).map(segment => {
    if (segment.startsWith(':')) return '[^/]+';
    return escapeRegex(segment);
  });
  return new RegExp(`^/${parts.join('/')}$`);
}

export const ROUTE_CATALOG = collectAgentFacingRoutes().map(route => {
  const [method, ...pathParts] = route.split(' ');
  const path = pathParts.join(' ');
  return {
    key: route,
    method,
    path,
    domain: classifyRouteDomain(path),
    regex: pathPatternToRegex(path),
  };
}).sort((a, b) => {
  const domainDelta = DOMAIN_ORDER.indexOf(a.domain) - DOMAIN_ORDER.indexOf(b.domain);
  if (domainDelta !== 0) return domainDelta;
  if (a.path !== b.path) return a.path.localeCompare(b.path);
  return a.method.localeCompare(b.method);
});

export const DOC_CATALOG = [
  { key: 'GET /llms.txt', method: 'GET', path: '/llms.txt', label: '/llms.txt', type: 'root' },
  { key: 'GET /docs/llms.txt', method: 'GET', path: '/docs/llms.txt', label: '/docs/llms.txt', type: 'root' },
  { key: 'GET / [root-markdown]', method: 'GET', path: '/', label: '/ (Accept: text/markdown)', type: 'root', docKind: 'root-markdown' },
  { key: 'GET /api/v1/skills', method: 'GET', path: '/api/v1/skills', label: '/api/v1/skills', type: 'skill-api' },
  ...SKILL_NAMES.map(name => ({
    key: `GET /api/v1/skills/${name}`,
    method: 'GET',
    path: `/api/v1/skills/${name}`,
    label: `/api/v1/skills/${name}`,
    type: 'skill-api',
  })),
  ...SKILL_NAMES.map(name => ({
    key: `GET /docs/skills/${name}.txt`,
    method: 'GET',
    path: `/docs/skills/${name}.txt`,
    label: `/docs/skills/${name}.txt`,
    type: 'skill-static',
  })),
  {
    key: 'GET /docs/skills/channels-signed.txt',
    method: 'GET',
    path: '/docs/skills/channels-signed.txt',
    label: '/docs/skills/channels-signed.txt',
    type: 'skill-static',
  },
  {
    key: 'GET /docs/skills/market-close.txt',
    method: 'GET',
    path: '/docs/skills/market-close.txt',
    label: '/docs/skills/market-close.txt',
    type: 'skill-static',
  },
  {
    key: 'GET /docs/skills/market-swap.txt',
    method: 'GET',
    path: '/docs/skills/market-swap.txt',
    label: '/docs/skills/market-swap.txt',
    type: 'skill-static',
  },
  ...KNOWLEDGE_TOPICS.map(topic => ({
    key: `GET /api/v1/knowledge/${topic}`,
    method: 'GET',
    path: `/api/v1/knowledge/${topic}`,
    label: `/api/v1/knowledge/${topic}`,
    type: 'knowledge',
  })),
];

export function matchAgentFacingRoute(method, path) {
  const upper = method.toUpperCase();
  return ROUTE_CATALOG.find(route => route.method === upper && route.regex.test(path)) || null;
}

export function matchDocSurface(event) {
  return DOC_CATALOG.find(doc => {
    if (doc.method !== event.method || doc.path !== event.path) return false;
    if (doc.docKind) return event.doc_kind === doc.docKind;
    return true;
  }) || null;
}
