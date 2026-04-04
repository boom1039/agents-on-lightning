import { classifyDomain } from '../../monitoring_dashboards/live/classify-domain.mjs';

export const CANONICAL_SKILL_NAMES = [
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

export const ROUTE_EXCLUDED = new Set([
  'POST /api/v1/test/reset-rate-limits',
  'POST /api/v1/channels/assign',
  'DELETE /api/v1/channels/assign/:chanId',
]);

export const ROUTE_ALIASES = new Map([
  ['GET /api/v1/agents/me/referral', 'GET /api/v1/agents/me/referral-code'],
  ['POST /api/v1/messages/send', 'POST /api/v1/messages'],
  ['POST /api/v1/alliances/propose', 'POST /api/v1/alliances'],
  ['GET /api/v1/analysis/profile-node/:pubkey', 'GET /api/v1/analysis/node/:pubkey'],
  ['GET /api/v1/analysis/node-profile/:pubkey', 'GET /api/v1/analysis/node/:pubkey'],
]);

const SKILL_NAMES = CANONICAL_SKILL_NAMES;

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

function splitRouteKey(route) {
  const [method, ...pathParts] = route.split(' ');
  return {
    key: route,
    method,
    path: pathParts.join(' '),
  };
}

/**
 * Walk a live Express app's router stack and extract all registered routes.
 * Call this AFTER all routes are mounted.
 */
export function extractRoutesFromApp(app) {
  const routes = new Set();
  function walk(stack) {
    for (const layer of stack) {
      if (layer.route) {
        const paths = Array.isArray(layer.route.path) ? layer.route.path : [layer.route.path];
        for (const routePath of paths) {
          if (typeof routePath !== 'string') continue;
          for (const method of Object.keys(layer.route.methods)) {
            const key = `${method.toUpperCase()} ${routePath}`;
            if (ROUTE_EXCLUDED.has(key) || routePath.startsWith('/dashboard')) continue;
            routes.add(ROUTE_ALIASES.get(key) || key);
          }
        }
      } else if (layer.name === 'router' && layer.handle?.stack) {
        walk(layer.handle.stack);
      }
    }
  }
  if (app._router?.stack) walk(app._router.stack);
  return [...routes].sort();
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

// Populated at startup by registerApp() — empty until then.
export const ROUTE_CATALOG = [];
let ROUTE_BY_KEY = new Map();

function buildCatalogEntry(routeKey) {
  const { method, path } = splitRouteKey(routeKey);
  return {
    key: routeKey,
    method,
    path,
    domain: classifyDomain(path) || 'other',
    regex: pathPatternToRegex(path),
  };
}

function hasParam(path) { return path.includes(':'); }

function sortCatalog(catalog) {
  return catalog.sort((a, b) => {
    const domainDelta = DOMAIN_ORDER.indexOf(a.domain) - DOMAIN_ORDER.indexOf(b.domain);
    if (domainDelta !== 0) return domainDelta;
    // Literal paths before parameterized ones so exact matches win in linear scan
    const aParam = hasParam(a.path);
    const bParam = hasParam(b.path);
    if (aParam !== bParam) return aParam ? 1 : -1;
    if (a.path !== b.path) return a.path.localeCompare(b.path);
    return a.method.localeCompare(b.method);
  });
}

/**
 * Call once after all Express routes are mounted.
 * Walks the live router stack and populates ROUTE_CATALOG.
 */
export function registerApp(app) {
  const keys = extractRoutesFromApp(app);
  ROUTE_CATALOG.length = 0;
  for (const key of keys) ROUTE_CATALOG.push(buildCatalogEntry(key));
  sortCatalog(ROUTE_CATALOG);
  ROUTE_BY_KEY = new Map(ROUTE_CATALOG.map(route => [route.key, route]));
  return ROUTE_CATALOG;
}

const ROUTE_ALIAS_CATALOG = [...ROUTE_ALIASES.entries()].map(([aliasKey, canonicalKey]) => {
  const { method, path } = splitRouteKey(aliasKey);
  return {
    key: aliasKey,
    canonicalKey,
    method,
    path,
    regex: pathPatternToRegex(path),
  };
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
    key: 'GET /docs/skills/signing-secp256k1.txt',
    method: 'GET',
    path: '/docs/skills/signing-secp256k1.txt',
    label: '/docs/skills/signing-secp256k1.txt',
    type: 'skill-helper',
  },
  ...KNOWLEDGE_TOPICS.map(topic => ({
    key: `GET /api/v1/knowledge/${topic}`,
    method: 'GET',
    path: `/api/v1/knowledge/${topic}`,
    label: `/api/v1/knowledge/${topic}`,
    type: 'knowledge',
  })),
];

const DOC_BY_KEY = new Map(DOC_CATALOG.map(doc => [doc.key, doc]));

const DOC_ALIASES = [
  ['GET /api/v1/skills/channels-signed', 'GET /api/v1/skills/channels'],
  ['GET /api/v1/skills/market-open-flow', 'GET /api/v1/skills/market'],
  ['GET /api/v1/skills/market-close', 'GET /api/v1/skills/market'],
  ['GET /api/v1/skills/market-swap', 'GET /api/v1/skills/market'],
  ['GET /api/v1/skills/swap-ecash-and-rebalance', 'GET /api/v1/skills/market'],
  ['GET /api/v1/skills/market-swap-ecash-and-rebalance', 'GET /api/v1/skills/market'],
  ['GET /api/v1/skills/market/open-flow.txt', 'GET /api/v1/skills/market'],
  ['GET /api/v1/skills/market/close.txt', 'GET /api/v1/skills/market'],
  ['GET /api/v1/skills/market/swap.txt', 'GET /api/v1/skills/market'],
  ['GET /api/v1/skills/channels/signed.txt', 'GET /api/v1/skills/channels'],
  ['GET /docs/skills/channels-signed.txt', 'GET /docs/skills/channels.txt'],
  ['GET /docs/skills/market-open-flow.txt', 'GET /docs/skills/market.txt'],
  ['GET /docs/skills/market-close.txt', 'GET /docs/skills/market.txt'],
  ['GET /docs/skills/market-swap.txt', 'GET /docs/skills/market.txt'],
  ['GET /docs/skills/market-swap-ecash-and-rebalance.txt', 'GET /docs/skills/market.txt'],
].map(([aliasKey, canonicalKey]) => {
  const { method, path } = splitRouteKey(aliasKey);
  return {
    key: aliasKey,
    canonicalKey,
    method,
    path,
  };
});

export function matchAgentFacingRoute(method, path) {
  const upper = method.toUpperCase();
  const canonical = ROUTE_CATALOG.find(route => route.method === upper && route.regex.test(path));
  if (canonical) return canonical;
  const alias = ROUTE_ALIAS_CATALOG.find(route => route.method === upper && route.regex.test(path));
  if (!alias) return null;
  return ROUTE_BY_KEY.get(alias.canonicalKey) || null;
}

export function matchDocSurface(event) {
  const canonical = DOC_CATALOG.find(doc => {
    if (doc.method !== event.method || doc.path !== event.path) return false;
    if (doc.docKind) return event.doc_kind === doc.docKind;
    return true;
  });
  if (canonical) return canonical;
  const alias = DOC_ALIASES.find(doc => doc.method === event.method && doc.path === event.path);
  if (!alias) return null;
  return DOC_BY_KEY.get(alias.canonicalKey) || null;
}
