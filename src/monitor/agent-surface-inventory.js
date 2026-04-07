import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, extname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { classifyDomain } from '../../monitoring_dashboards/live/classify-domain.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..', '..');
const ROUTES_DIR = resolve(ROOT, 'src', 'routes');
const DOCS_DIR = resolve(ROOT, 'docs');
const SKILLS_DIR = resolve(DOCS_DIR, 'skills');

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

export const JOURNEY_PHASES = [
  { id: 1, key: 'app-level', name: 'App' },
  { id: 2, key: 'discovery', name: 'Discovery' },
  { id: 3, key: 'identity', name: 'Identity' },
  { id: 4, key: 'wallet', name: 'Wallet' },
  { id: 5, key: 'analysis', name: 'Analysis' },
  { id: 6, key: 'social', name: 'Social' },
  { id: 7, key: 'channels', name: 'Channels' },
  { id: 8, key: 'market', name: 'Market' },
  { id: 9, key: 'analytics', name: 'Analytics' },
  { id: 10, key: 'capital', name: 'Capital' },
];

export const ROUTE_EXCLUDED = new Set([
  'POST /api/v1/test/reset-rate-limits',
  'POST /api/v1/channels/assign',
  'DELETE /api/v1/channels/assign/:chanId',
  'GET /api/v1/knowledge/:topic',
]);

const INTERNAL_ROUTE_FILES = new Set([
  'journey-routes.js',
]);

const INTERNAL_ROUTE_SOURCE_FILES = new Set([
  'src/routes/journey-routes.js',
]);

const ROUTE_SOURCE_FILES = [
  resolve(ROOT, 'src', 'index.js'),
  ...readdirSync(ROUTES_DIR)
    .filter((file) => file.endsWith('.js') && !file.endsWith('.test.js') && !INTERNAL_ROUTE_FILES.has(file))
    .map((file) => resolve(ROUTES_DIR, file)),
];

const ROUTE_CALL_RE = /(?:app|router)\.(get|post|put|delete|patch)\(\s*(\[[^\]]+\]|'[^']*'|"[^"]*"|`[^`]*`)/g;
const COMMENT_ROUTE_META_RE = /^\/\/\s*@agent-route\s+(\{.*\})\s*$/;
const COMMENT_LINE_RE = /^\/\/\s?(.*)$/;
const DOC_ROUTE_RE = /\b(GET|POST|PUT|DELETE|PATCH)\s+`?(\/[^\s`'")\]},]*)/gi;
const NON_LIVE_ROUTE_TAG = '[not-live-route]';
const MANIFEST_EXCLUDED_ROUTE_TAG = '[manifest-excluded-route]';
const SKIPPED_DOC_ROUTE_TAGS = [
  NON_LIVE_ROUTE_TAG,
  MANIFEST_EXCLUDED_ROUTE_TAG,
];
const SECURITY_FIELDS = [
  'moves_money',
  'requires_ownership',
  'requires_signature',
  'long_running',
];
const LONG_RUNNING_ROUTE_KEYS = new Set([
  'POST /api/v1/analytics/execute',
  'POST /api/v1/help',
  'POST /api/v1/market/open',
  'POST /api/v1/market/close',
  'POST /api/v1/market/rebalance',
]);

function splitRouteKey(route) {
  const [method, ...pathParts] = route.split(' ');
  return {
    key: route,
    method,
    path: pathParts.join(' '),
  };
}

function escapeRegex(text) {
  return text.replace(/[|\\{}()[\]^$+*?.]/g, '\\$&');
}

function pathPatternToRegex(path) {
  if (path === '/') return /^\/$/;
  const parts = path.split('/').filter(Boolean).map((segment) => {
    if (segment.startsWith(':')) return '[^/]+';
    return escapeRegex(segment);
  });
  return new RegExp(`^/${parts.join('/')}\/?$`);
}

function hasParam(path) {
  return path.includes(':');
}

function sortCatalog(catalog) {
  return catalog.sort((a, b) => {
    const domainDelta = DOMAIN_ORDER.indexOf(a.domain) - DOMAIN_ORDER.indexOf(b.domain);
    if (domainDelta !== 0) return domainDelta;
    const aParam = hasParam(a.path);
    const bParam = hasParam(b.path);
    if (aParam !== bParam) return aParam ? 1 : -1;
    if (a.path !== b.path) return a.path.localeCompare(b.path);
    return a.method.localeCompare(b.method);
  });
}

function trimCommentLine(text) {
  return text
    .replace(/^[-*=#\s>]+/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function extractRouteCommentMeta(lines, routeLine) {
  const commentLines = [];
  let meta = null;

  for (let idx = routeLine - 2; idx >= 0; idx -= 1) {
    const raw = lines[idx];
    const trimmed = raw.trim();
    if (!trimmed) {
      if (commentLines.length > 0 || meta) break;
      continue;
    }
    if (COMMENT_ROUTE_META_RE.test(trimmed)) {
      const match = trimmed.match(COMMENT_ROUTE_META_RE);
      try {
        meta = JSON.parse(match[1]);
      } catch {
        meta = null;
      }
      continue;
    }
    const commentMatch = trimmed.match(COMMENT_LINE_RE);
    if (commentMatch) {
      const clean = trimCommentLine(commentMatch[1]);
      if (clean) commentLines.unshift(clean);
      continue;
    }
    if (trimmed.startsWith('/*') || trimmed.startsWith('*') || trimmed.startsWith('*/')) {
      continue;
    }
    break;
  }

  return {
    meta: meta || {},
    summary: meta?.summary || commentLines[commentLines.length - 1] || null,
  };
}

function normalizeDocRefs(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value.filter(Boolean).map((item) => `${item}`.trim()).filter(Boolean);
  return [`${value}`.trim()].filter(Boolean);
}

function compactRouteLabel(path) {
  if (path === '/') return 'root';
  const clean = path.replace(/^\/+/, '');
  if (!clean) return 'root';
  const parts = clean.split('/');
  const tail = parts[parts.length - 1];
  return tail || clean;
}

function classifyPathGroup(path = '') {
  if (path === '/' || path === '/llms.txt' || path === '/health') return 'app';
  if (path.startsWith('/docs/')) return 'docs';
  if (!path.startsWith('/api/v1/')) return 'other';
  const parts = path.split('/').filter(Boolean);
  return parts[2] || 'root';
}

function inferDomainFromTags(tags = []) {
  for (const domain of DOMAIN_ORDER) {
    if (tags.includes(domain)) return domain;
  }
  return null;
}

function normalizeOrder(value) {
  if (Number.isInteger(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number.parseInt(value.trim(), 10);
    if (Number.isInteger(parsed)) return parsed;
  }
  return null;
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function isBoolean(value) {
  return typeof value === 'boolean';
}

function normalizeSecurityMeta(value = {}) {
  return {
    moves_money: value?.moves_money === true,
    requires_ownership: value?.requires_ownership === true,
    requires_signature: value?.requires_signature === true,
    long_running: value?.long_running === true,
  };
}

function validateRouteMeta({ method, path, file, line, meta = {} }) {
  const missing = [];
  const invalid = [];

  if (!isNonEmptyString(meta.auth)) missing.push('auth');
  if (!isNonEmptyString(meta.domain)) missing.push('domain');
  else if (!DOMAIN_ORDER.includes(meta.domain.trim())) invalid.push(`domain=${meta.domain}`);
  if (!isNonEmptyString(meta.subgroup)) missing.push('subgroup');
  if (!isNonEmptyString(meta.label)) missing.push('label');
  if (!isNonEmptyString(meta.summary)) missing.push('summary');

  const order = normalizeOrder(meta.order);
  if (order == null) missing.push('order');
  else if (order < 0) invalid.push(`order=${meta.order}`);

  if (!Array.isArray(meta.tags) || meta.tags.length === 0) missing.push('tags');
  else if (!meta.tags.includes(meta.domain)) invalid.push(`tags missing domain=${meta.domain}`);

  const routeKey = `${method} ${path}`;
  const security = meta.security;
  if (!security || typeof security !== 'object' || Array.isArray(security)) {
    missing.push('security');
  } else {
    for (const field of SECURITY_FIELDS) {
      if (!Object.prototype.hasOwnProperty.call(security, field)) missing.push(`security.${field}`);
      else if (!isBoolean(security[field])) invalid.push(`security.${field}=${security[field]}`);
    }

    if (SECURITY_FIELDS.every((field) => isBoolean(security[field]))) {
      if (meta.auth === 'public' && security.moves_money) invalid.push('public route cannot move money');
      if (meta.auth === 'public' && security.requires_ownership) invalid.push('public route cannot require ownership');
      if (meta.auth === 'public' && security.requires_signature) invalid.push('public route cannot require signature');
      if (security.moves_money && meta.auth !== 'agent') invalid.push('money route must use auth=agent');
      if (security.moves_money && !security.requires_ownership) invalid.push('money route must require ownership');
      if (security.requires_signature && meta.auth !== 'agent') invalid.push('signed route must use auth=agent');
      if (security.long_running && !LONG_RUNNING_ROUTE_KEYS.has(routeKey)) {
        invalid.push(`security.long_running=true but ${routeKey} is not in the timeout inventory`);
      }
      if (!security.long_running && LONG_RUNNING_ROUTE_KEYS.has(routeKey)) {
        invalid.push(`security.long_running=false but ${routeKey} is in the timeout inventory`);
      }
    }
  }

  if (missing.length === 0 && invalid.length === 0) return;

  const parts = [];
  if (missing.length > 0) parts.push(`missing ${missing.join(', ')}`);
  if (invalid.length > 0) parts.push(`invalid ${invalid.join(', ')}`);
  throw new Error(`[agent-route] ${file}:${line} ${method} ${path} ${parts.join('; ')}; see docs/agent-route-schema.md`);
}

function titleizeSegment(text = '') {
  return `${text}`
    .split(/[-_/]+/)
    .filter(Boolean)
    .map((part) => {
      if (part.length <= 3) return part.toUpperCase();
      return `${part.charAt(0).toUpperCase()}${part.slice(1)}`;
    })
    .join(' ');
}

function deriveJourneyPhase(route) {
  const index = DOMAIN_ORDER.indexOf(route.domain);
  return index >= 0 ? index + 1 : JOURNEY_PHASES.length;
}

function deriveJourneySubgroup(route, phase) {
  const path = `${route.path || ''}`;
  const explicit = `${route.group || ''}`.trim();
  if (explicit) return explicit;
  const group = `${route.path_group || ''}`;

  switch (route.domain) {
    case 'app-level':
      return 'App';
    case 'discovery':
      if (group === 'root') return 'Root';
      return titleizeSegment(group) || 'Discovery';
    case 'identity':
      return titleizeSegment(group) || 'Identity';
    case 'wallet':
      if (
        path.includes('/wallet/mint')
        || path.includes('/wallet/deposit')
      ) {
        return 'Deposit';
      }
      if (path.includes('/wallet/balance') || path.includes('/wallet/history')) return 'Balance';
      if (path.includes('/wallet/restore') || path.includes('/wallet/reclaim-pending')) return 'Recovery';
      if (
        path.includes('/wallet/send')
        || path.includes('/wallet/receive')
        || path.includes('/wallet/melt')
        || path.includes('/wallet/withdraw')
      ) {
        return 'Spending';
      }
      return titleizeSegment(group) || 'Wallet';
    case 'analysis':
      if (path.includes('/network-health')) return 'Network';
      if (path.includes('/suggest-peers/')) return 'Peers';
      return 'Profiling';
    case 'social':
      if (path.includes('/leaderboard') || path.includes('/tournaments')) return 'Leaderboard';
      if (path.includes('/messages')) return 'Messaging';
      if (path.includes('/alliances')) return 'Alliances';
      if (path.startsWith('/api/v1/agents/:id')) return 'Profiles';
      return titleizeSegment(group) || 'Social';
    case 'channels':
      if (path.includes('/channels/audit')) return 'Audit';
      if (path.includes('/channels/verify')) return 'Verify';
      if (path.includes('/channels/status') || path.includes('/channels/violations')) return 'Status';
      return 'Signed';
    case 'market':
      if (path.includes('/market/close') || path.includes('/market/closes')) return 'Close Flow';
      if (
        path.includes('/market/preview')
        || path.includes('/market/open')
        || path.includes('/market/pending')
      ) {
        return 'Open Flow';
      }
      if (path.includes('/market/revenue')) return 'Revenue';
      if (path.includes('/market/performance')) return 'Performance';
      if (path.includes('/fund-from-ecash')) return 'Ecash Funding';
      if (path.includes('/rebalance')) return 'Rebalancing';
      if (path.includes('/swap/')) return 'Swaps';
      return 'Market Reads';
    case 'analytics':
      return 'Analytics';
    case 'capital':
      return path === '/api/v1/help' ? 'Help' : 'Capital';
    default:
      return titleizeSegment(group) || `Phase ${phase}`;
  }
}

function deriveJourneyEndpoint(route) {
  const label = `${route.label || ''}`.trim();
  if (label && !label.startsWith(':')) return label;

  const parts = `${route.path || ''}`.split('/').filter(Boolean);
  if (parts.length >= 2 && parts[parts.length - 1].startsWith(':')) {
    return `${parts[parts.length - 2]}/${parts[parts.length - 1]}`;
  }
  return label || compactRouteLabel(route.path);
}

function buildJourneyMeta(route) {
  const phase = deriveJourneyPhase(route);
  const phaseInfo = JOURNEY_PHASES.find((entry) => entry.id === phase) || JOURNEY_PHASES[JOURNEY_PHASES.length - 1];

  return {
    phase,
    phase_key: phaseInfo.key,
    phase_name: phaseInfo.name,
    subgroup: deriveJourneySubgroup(route, phase),
    endpoint: deriveJourneyEndpoint(route),
    order: normalizeOrder(route.order),
  };
}

export function shouldIgnoreAgentSurfacePath(path = '') {
  return (
    path.startsWith('/local/reports/')
    || path.startsWith('/local/reports')
    || path.startsWith('/dashboard')
    || path.startsWith('/journey')
    || path.startsWith('/api/journey')
    || path.startsWith('/api/analytics')
    || path.startsWith('/api/demo/')
    || path === '/docs/llms.txt'
    || path.startsWith('/api/v1/knowledge/')
  );
}

export function isInternalAgentSurfaceRoute(route = {}) {
  return INTERNAL_ROUTE_SOURCE_FILES.has(`${route.source_file || ''}`);
}

function routeShouldBeExcluded(key, path) {
  return ROUTE_EXCLUDED.has(key) || shouldIgnoreAgentSurfacePath(path);
}

function parsePathsFromArg(rawArg) {
  const paths = [];
  if (rawArg.startsWith('[')) {
    const pathStrRe = /['"`]([^'"`]+)['"`]/g;
    let pm;
    while ((pm = pathStrRe.exec(rawArg)) !== null) {
      paths.push(pm[1]);
    }
    return paths;
  }

  const pathMatch = rawArg.match(/['"`]([^'"`]+)['"`]/);
  if (pathMatch) paths.push(pathMatch[1]);
  return paths;
}

function buildCatalogEntry({
  method,
  path,
  file,
  line,
  meta = {},
  summary = null,
  canonicalPath = null,
}) {
  validateRouteMeta({ method, path, file, line, meta });
  const key = `${method} ${path}`;
  const canonicalKey = `${method} ${canonicalPath || path}`;
  const tags = Array.isArray(meta.tags) ? meta.tags.map((tag) => `${tag}`) : [];
  const pathGroup = classifyPathGroup(path);
  const domain = meta.domain.trim();
  const security = normalizeSecurityMeta(meta.security);
  return {
    key,
    method,
    path,
    domain,
    path_group: pathGroup,
    group: meta.subgroup.trim(),
    regex: pathPatternToRegex(path),
    source_file: file,
    source_line: line,
    summary: meta.summary.trim(),
    auth: typeof meta.auth === 'string' ? meta.auth : null,
    doc_refs: normalizeDocRefs(meta.docs || meta.doc),
    tags,
    label: meta.label.trim(),
    order: normalizeOrder(meta.order),
    security,
    canonical: key === canonicalKey,
    canonical_key: canonicalKey,
    alias_of: key === canonicalKey ? null : canonicalKey,
  };
}

function buildManifestRoute(route) {
  return {
    ...route,
    journey: route.journey ? { ...route.journey } : null,
    security: route.security ? { ...route.security } : null,
  };
}

function parseTaggedRoutesFromSource() {
  const entries = [];

  for (const filepath of ROUTE_SOURCE_FILES) {
    const source = readFileSync(filepath, 'utf8');
    const lines = source.split('\n');
    let match;

    while ((match = ROUTE_CALL_RE.exec(source)) !== null) {
      const method = match[1].toUpperCase();
      const rawArg = match[2];
      const line = source.slice(0, match.index).split('\n').length;
      const paths = parsePathsFromArg(rawArg);
      const { meta, summary } = extractRouteCommentMeta(lines, line);
      const canonicalPath = typeof meta.canonicalPath === 'string'
        ? meta.canonicalPath
        : (paths[0] || null);

      for (const path of paths) {
        if (!path) continue;
        const key = `${method} ${path}`;
        if (routeShouldBeExcluded(key, path)) continue;
        entries.push(buildCatalogEntry({
          method,
          path,
          file: relative(ROOT, filepath),
          line,
          meta,
          summary,
          canonicalPath,
        }));
      }
    }
  }

  return sortCatalog(entries);
}

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
            if (routeShouldBeExcluded(key, routePath)) continue;
            routes.add(key);
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

function routeMatchesPath(routePath, candidatePath) {
  const routeRegex = pathPatternToRegex(routePath);
  return routeRegex.test(candidatePath);
}

function classifyDocDomain(path) {
  if (path === '/llms.txt' || path.startsWith('/docs/')) return 'app-level';
  if (path === '/api/v1/skills') return 'discovery';
  return classifyDomain(path) || 'other';
}

function docKindForFile(filename) {
  if (filename === 'llms.txt') return 'root';
  if (CANONICAL_SKILL_NAMES.includes(filename.replace(/\.txt$/, ''))) return 'skill-map';
  if (filename === 'signing-secp256k1.txt') return 'skill-helper';
  if (filename.includes('signed') || filename.includes('compatibility') || filename.includes('market-swap') || filename.includes('market-close')) {
    return 'skill-group';
  }
  return 'skill-group';
}

function deriveLegacySkillApiPaths(filename) {
  const base = filename.replace(/\.txt$/, '');
  if (base === 'signing-secp256k1') {
    return [`/api/v1/skills/${base}`];
  }
  if (CANONICAL_SKILL_NAMES.includes(base)) {
    return [`/api/v1/skills/${base}`];
  }
  const [group, ...rest] = base.split('-');
  if (CANONICAL_SKILL_NAMES.includes(group) && rest.length > 0) {
    return [
      `/api/v1/skills/${group}/${rest.join('-')}.txt`,
      `/api/v1/skills/${base}`,
    ];
  }
  return [`/api/v1/skills/${base}`];
}

function extractDocTitle(text, fallback) {
  const titleMatch = text.match(/^#\s+(.+)$/m);
  return titleMatch ? titleMatch[1].trim() : fallback;
}

function extractDocSummary(text) {
  const lines = text.split('\n');
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || line.startsWith('```')) continue;
    if (line.startsWith('- ') || line.startsWith('* ') || /^\d+\./.test(line)) continue;
    return line;
  }
  return null;
}

function normalizeMentionPath(path) {
  return path
    .replace(/\?.*$/, '')
    .replace(/[.,;:!?)\]}]+$/g, '')
    .replace(/<[^>]+>/g, ':id')
    .replace(/\{([^}]+)\}/g, ':$1');
}

function shouldIgnoreMention(path) {
  return path.startsWith('/api/v1/knowledge/');
}

function extractDocMentions(text) {
  const mentions = [];
  for (const rawLine of text.split('\n')) {
    if (SKIPPED_DOC_ROUTE_TAGS.some((tag) => rawLine.includes(tag))) continue;
    for (const match of rawLine.matchAll(DOC_ROUTE_RE)) {
      mentions.push({
        method: match[1].toUpperCase(),
        path: normalizeMentionPath(match[2]),
      });
    }
  }
  return mentions;
}

function buildInitialDocNodes() {
  const docs = [];
  const skillsIndexDoc = {
    doc_id: 'skills-index',
    title: 'Skills Index',
    summary: 'List of canonical skill files agents can open.',
    kind: 'skill-index',
    source_file: 'src/routes/agent-discovery-routes.js',
    source_path: null,
    text: '',
    surfaces: [
      {
        key: 'GET /api/v1/skills',
        method: 'GET',
        path: '/api/v1/skills',
        label: '/api/v1/skills',
        type: 'skill-index',
      },
    ],
    route_keys: [],
    linked_doc_ids: CANONICAL_SKILL_NAMES.map((name) => `skills/${name}.txt`),
  };
  docs.push(skillsIndexDoc);

  const llmsPath = resolve(DOCS_DIR, 'llms.txt');
  if (existsSync(llmsPath)) {
    const text = readFileSync(llmsPath, 'utf8');
    docs.push({
      doc_id: 'llms.txt',
      title: extractDocTitle(text, 'llms.txt'),
      summary: extractDocSummary(text),
      kind: 'root',
      source_file: 'docs/llms.txt',
      source_path: llmsPath,
      text,
      surfaces: [
        { key: 'GET /llms.txt', method: 'GET', path: '/llms.txt', label: '/llms.txt', type: 'root' },
      ],
      route_keys: [],
      linked_doc_ids: [],
    });
  }

  if (!existsSync(SKILLS_DIR)) return docs;

  const files = readdirSync(SKILLS_DIR).filter((file) => extname(file) === '.txt').sort();
  for (const filename of files) {
    const filepath = resolve(SKILLS_DIR, filename);
    const text = readFileSync(filepath, 'utf8');
    const docId = `skills/${filename}`;
    const surfaces = [
      {
        key: `GET /docs/skills/${filename}`,
        method: 'GET',
        path: `/docs/skills/${filename}`,
        label: `/docs/skills/${filename}`,
        type: 'skill-static',
      },
    ];

    docs.push({
      doc_id: docId,
      title: extractDocTitle(text, filename),
      summary: extractDocSummary(text),
      kind: docKindForFile(filename),
      source_file: relative(ROOT, filepath),
      source_path: filepath,
      text,
      surfaces,
      route_keys: [],
      linked_doc_ids: [],
    });
  }

  return docs;
}

function buildDocCatalog(routeCatalog) {
  const docNodes = buildInitialDocNodes();
  const docSurfaces = [];
  const docSurfaceByKey = new Map();

  for (const doc of docNodes) {
    for (const surface of doc.surfaces) {
      const entry = {
        ...surface,
        doc_id: doc.doc_id,
        title: doc.title,
        summary: doc.summary,
        kind: doc.kind,
        source_file: doc.source_file,
        route_keys: doc.route_keys,
        linked_doc_ids: doc.linked_doc_ids,
        domain: classifyDocDomain(surface.path),
      };
      docSurfaces.push(entry);
      docSurfaceByKey.set(entry.key, entry);
    }
  }

  const routeByMethod = new Map();
  for (const route of routeCatalog) {
    const list = routeByMethod.get(route.method) || [];
    list.push(route);
    routeByMethod.set(route.method, list);
  }

  function matchRouteMention(method, path) {
    const candidates = routeByMethod.get(method) || [];
    return candidates.find((route) => routeMatchesPath(route.path, path)) || null;
  }

  function matchDocMention(method, path) {
    return docSurfaces.find((doc) => doc.method === method && doc.path === path) || null;
  }

  for (const doc of docNodes) {
    const routeKeys = new Set();
    const linkedDocIds = new Set(doc.linked_doc_ids);

    for (const match of extractDocMentions(doc.text)) {
      const { method, path: mentionPath } = match;
      if (!mentionPath || shouldIgnoreMention(mentionPath)) continue;

      const matchedDoc = matchDocMention(method, mentionPath);
      if (matchedDoc && matchedDoc.doc_id !== doc.doc_id) {
        linkedDocIds.add(matchedDoc.doc_id);
        continue;
      }

      const matchedRoute = matchRouteMention(method, mentionPath);
      if (matchedRoute) routeKeys.add(matchedRoute.key);
    }

    doc.route_keys = [...routeKeys].sort();
    doc.linked_doc_ids = [...linkedDocIds].sort();
  }

  docSurfaces.length = 0;
  for (const doc of docNodes) {
    for (const surface of doc.surfaces) {
      docSurfaces.push({
        ...surface,
        doc_id: doc.doc_id,
        title: doc.title,
        summary: doc.summary,
        kind: doc.kind,
        source_file: doc.source_file,
        route_keys: doc.route_keys,
        linked_doc_ids: doc.linked_doc_ids,
        domain: classifyDocDomain(surface.path),
      });
    }
  }

  return {
    docNodes,
    docSurfaces,
  };
}

function enrichRoutesWithDocs(routeCatalog, docNodes) {
  const docIdsByRoute = new Map();
  const docById = new Map(docNodes.map((doc) => [doc.doc_id, doc]));
  const docIdBySurface = new Map();

  for (const doc of docNodes) {
    for (const surface of doc.surfaces) {
      docIdBySurface.set(surface.key, doc.doc_id);
    }
    for (const routeKey of doc.route_keys) {
      const list = docIdsByRoute.get(routeKey) || [];
      list.push(doc.doc_id);
      docIdsByRoute.set(routeKey, list);
    }
  }

  for (const route of routeCatalog) {
    const docIds = new Set(docIdsByRoute.get(route.key) || []);
    for (const docRef of route.doc_refs) {
      const parsed = splitRouteKey(docRef);
      const surfaceKey = `${parsed.method || 'GET'} ${parsed.path}`;
      const docId = docIdBySurface.get(surfaceKey);
      if (docId) docIds.add(docId);
      else if (docById.has(docRef)) docIds.add(docRef);
    }
    route.doc_ids = [...docIds].sort();
  }
}

function buildRouteDocEdges(routeCatalog, docNodes) {
  const edges = [];

  for (const route of routeCatalog) {
    for (const docId of route.doc_ids || []) {
      edges.push({
        from: route.key,
        to: docId,
        type: 'route-doc',
      });
    }
  }

  for (const doc of docNodes) {
    for (const routeKey of doc.route_keys || []) {
      edges.push({
        from: doc.doc_id,
        to: routeKey,
        type: 'doc-route',
      });
    }
    for (const linkedDocId of doc.linked_doc_ids || []) {
      edges.push({
        from: doc.doc_id,
        to: linkedDocId,
        type: 'doc-doc',
      });
    }
  }

  return edges;
}

function buildSurfaceData() {
  const routeCatalog = parseTaggedRoutesFromSource();
  const { docNodes, docSurfaces } = buildDocCatalog(routeCatalog);
  enrichRoutesWithDocs(routeCatalog, docNodes);
  for (const route of routeCatalog) {
    route.journey = buildJourneyMeta(route);
    route.phase = route.journey.phase;
    route.phase_name = route.journey.phase_name;
    route.group = route.journey.subgroup;
    route.subgroup = route.journey.subgroup;
    route.endpoint = route.journey.endpoint;
    route.order = route.journey.order;
  }
  const edges = buildRouteDocEdges(routeCatalog, docNodes);

  return {
    routeCatalog,
    docNodes,
    docSurfaces,
    edges,
  };
}

const SURFACE_DATA = buildSurfaceData();

export const ROUTE_CATALOG = SURFACE_DATA.routeCatalog;
export const DOC_CATALOG = SURFACE_DATA.docSurfaces;
export const DOC_NODES = SURFACE_DATA.docNodes;
export const ROUTE_DOC_EDGES = SURFACE_DATA.edges;

let ROUTE_BY_KEY = new Map(ROUTE_CATALOG.map((route) => [route.key, route]));
let DOC_BY_KEY = new Map(DOC_CATALOG.map((doc) => [doc.key, doc]));
let DOC_BY_ID = new Map(DOC_NODES.map((doc) => [doc.doc_id, doc]));
const LEGACY_DOC_ALIASES = (() => {
  const aliases = [];

  for (const doc of DOC_NODES) {
    if (doc.doc_id === 'llms.txt') {
      aliases.push({
        method: 'GET',
        path: '/docs/llms.txt',
        docKind: null,
        canonicalKey: 'GET /llms.txt',
      });
      aliases.push({
        method: 'GET',
        path: '/',
        docKind: 'root-markdown',
        canonicalKey: 'GET /llms.txt',
      });
      continue;
    }

    if (!doc.doc_id.startsWith('skills/')) continue;
    const filename = doc.doc_id.replace(/^skills\//, '');
    for (const path of deriveLegacySkillApiPaths(filename)) {
      aliases.push({
        method: 'GET',
        path,
        docKind: null,
        canonicalKey: `GET /docs/skills/${filename}`,
      });
    }
  }

  return aliases;
})();

export function registerApp(app) {
  if (!app) return ROUTE_CATALOG;

  const liveRoutes = extractRoutesFromApp(app);
  const missingFromSource = liveRoutes.filter((key) => !ROUTE_BY_KEY.has(key));
  if (missingFromSource.length > 0) {
    console.warn(`[agent-surface-inventory] ${missingFromSource.length} live route(s) missing source metadata`);
  }
  return ROUTE_CATALOG;
}

export function matchAgentFacingRoute(method, path) {
  const upper = `${method}`.toUpperCase();
  const matched = ROUTE_CATALOG.find((route) => route.method === upper && route.regex.test(path)) || null;
  if (!matched) return null;
  if (matched.alias_of) return ROUTE_BY_KEY.get(matched.alias_of) || matched;
  return matched;
}

export function matchDocSurface(event) {
  const upper = `${event?.method || 'GET'}`.toUpperCase();
  const path = `${event?.path || ''}`;
  const docKind = event?.doc_kind || null;

  const direct = DOC_CATALOG.find((doc) => {
    if (doc.method !== upper || doc.path !== path) return false;
    if (doc.docKind) return doc.docKind === docKind;
    return true;
  }) || null;
  if (direct) return direct;

  const legacy = LEGACY_DOC_ALIASES.find((alias) => {
    if (alias.method !== upper || alias.path !== path) return false;
    if (alias.docKind) return alias.docKind === docKind;
    return true;
  });
  if (!legacy) return null;
  return DOC_BY_KEY.get(legacy.canonicalKey) || null;
}

export function resolveTrackedSurface({ method, path, doc_kind = null }) {
  const doc = matchDocSurface({ method, path, doc_kind });
  if (doc) {
    return {
      kind: 'doc',
      key: doc.key,
      entry: doc,
    };
  }

  const route = matchAgentFacingRoute(method, path);
  if (route) {
    return {
      kind: 'route',
      key: route.key,
      entry: route,
    };
  }

  return null;
}

export function getAgentSurfaceManifest() {
  const routes = ROUTE_CATALOG.map((route) => buildManifestRoute(route));
  return {
    built_at: Date.now(),
    journey_phases: JOURNEY_PHASES.map((phase) => ({ ...phase })),
    routes,
    route_lookup: Object.fromEntries(routes.map((route) => [route.key, route])),
    docs: DOC_NODES.map((doc) => ({
      doc_id: doc.doc_id,
      title: doc.title,
      summary: doc.summary,
      kind: doc.kind,
      source_file: doc.source_file,
      surfaces: doc.surfaces.map((surface) => ({
        key: surface.key,
        method: surface.method,
        path: surface.path,
        label: surface.label,
        type: surface.type,
        docKind: surface.docKind || null,
      })),
      route_keys: [...doc.route_keys],
      linked_doc_ids: [...doc.linked_doc_ids],
    })),
    edges: ROUTE_DOC_EDGES.map((edge) => ({ ...edge })),
  };
}

export function getCanonicalJourneyRouteCatalog() {
  return ROUTE_CATALOG
    .filter((route) => route.canonical !== false && !isInternalAgentSurfaceRoute(route))
    .map((route) => ({ ...route }));
}

export function getAgentSurfaceSummary() {
  const canonicalRoutes = ROUTE_CATALOG.filter((route) => route.canonical !== false);
  const endpointRoutes = ROUTE_CATALOG.filter((route) => !isInternalAgentSurfaceRoute(route));
  const canonicalEndpointRoutes = getCanonicalJourneyRouteCatalog();
  const internalRoutes = ROUTE_CATALOG.filter((route) => isInternalAgentSurfaceRoute(route));
  const canonicalInternalRoutes = canonicalRoutes.filter((route) => isInternalAgentSurfaceRoute(route));

  return {
    endpoint_routes_total: endpointRoutes.length,
    endpoint_routes_canonical: canonicalEndpointRoutes.length,
    internal_routes_total: internalRoutes.length,
    internal_routes_canonical: canonicalInternalRoutes.length,
    doc_surfaces_total: DOC_CATALOG.length,
    doc_nodes_total: DOC_NODES.length,
    edges_total: ROUTE_DOC_EDGES.length,
  };
}
