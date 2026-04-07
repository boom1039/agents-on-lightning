import { existsSync, readFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';

const ROUTE_RE = /\b(GET|POST|PUT|DELETE|PATCH)\s+`?(\/[^\s`'")\]},]*)/gi;
const DOC_SURFACE_RE = /\/docs\/skills\/[A-Za-z0-9._-]+\.txt|\/llms\.txt|\/api\/v1\/skills/g;
const SKIP_LINE_TAGS = ['[not-live-route]', '[manifest-excluded-route]'];

function escapeHtml(text) {
  return `${text}`
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

function trim(value) {
  return `${value || ''}`.trim();
}

function docIdToSurfacePath(docId) {
  if (docId === 'llms.txt') return '/llms.txt';
  if (docId === 'skills-index') return '/api/v1/skills';
  if (docId.startsWith('skills/')) return `/docs/${docId}`;
  return null;
}

function surfacePathToDocId(path) {
  if (path === '/llms.txt' || path === '/docs/llms.txt') return 'llms.txt';
  if (path === '/api/v1/skills') return 'skills-index';
  if (path.startsWith('/docs/skills/')) return `skills/${basename(path)}`;
  return path;
}

function surfacePathToLocalFile(path) {
  if (path === '/llms.txt' || path === '/docs/llms.txt') {
    return resolve(process.cwd(), 'docs', 'llms.txt');
  }
  if (path.startsWith('/docs/skills/')) {
    return resolve(process.cwd(), 'docs', path.replace(/^\/docs\//, ''));
  }
  return null;
}

function normalizeMentionPath(path) {
  return `${path}`
    .replace(/\?.*$/, '')
    .replace(/[.,;:!?)\]}]+$/g, '')
    .replace(/<[^>]+>/g, ':id')
    .replace(/\{([^}]+)\}/g, ':$1')
    .replace(/\/+$/, '') || '/';
}

function pathPatternToRegex(path) {
  if (path === '/') return /^\/$/;
  const parts = `${path}`.split('/').filter(Boolean).map((segment) => {
    if (segment.startsWith(':')) return '[^/]+';
    return segment.replace(/[|\\{}()[\]^$+*?.]/g, '\\$&');
  });
  return new RegExp(`^/${parts.join('/')}/?$`);
}

function parseRouteMentions(text) {
  const mentions = [];
  const lines = `${text}`.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (SKIP_LINE_TAGS.some((tag) => line.includes(tag))) continue;
    ROUTE_RE.lastIndex = 0;
    let match;
    while ((match = ROUTE_RE.exec(line))) {
      mentions.push({
        method: match[1].toUpperCase(),
        path: normalizeMentionPath(match[2]),
        line: index + 1,
      });
    }
  }
  return mentions;
}

function parseDocLinks(text) {
  const links = [];
  const lines = `${text}`.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (SKIP_LINE_TAGS.some((tag) => line.includes(tag))) continue;
    DOC_SURFACE_RE.lastIndex = 0;
    let match;
    while ((match = DOC_SURFACE_RE.exec(line))) {
      links.push({
        path: normalizeMentionPath(match[0]),
        line: index + 1,
      });
    }
  }
  return links;
}

function extractDocTitle(text, fallback) {
  const titleMatch = `${text}`.match(/^#\s+(.+)$/m);
  return titleMatch ? titleMatch[1].trim() : fallback;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function sortDocsByFlow(llmsDocId, docsById) {
  const seen = new Set();
  const ordered = [];

  function visit(docId) {
    if (!docId || seen.has(docId) || !docsById.has(docId)) return;
    seen.add(docId);
    ordered.push(docId);
    const doc = docsById.get(docId);
    for (const link of doc.doc_links) {
      const linked = [...docsById.values()].find((candidate) => candidate.surface_path === link.path);
      if (linked) visit(linked.doc_id);
    }
  }

  visit(llmsDocId);
  for (const docId of [...docsById.keys()].sort()) visit(docId);
  return ordered;
}

function rankCanonicalDoc(route, doc) {
  const routeDomainSkill = `skills/${route.domain}.txt`;
  const prefix = `skills/${route.domain}-`;
  if (route.key === 'GET /llms.txt' || route.key === 'GET /') {
    if (doc.doc_id === 'llms.txt') return 0;
  }
  if (doc.doc_id.startsWith(prefix)) return 0;
  if (doc.doc_id === routeDomainSkill) return 1;
  if (doc.doc_id === 'llms.txt') return 8;
  if (doc.doc_id === 'skills-index') return 9;
  if (doc.doc_id.startsWith('skills/')) return 4;
  return 10;
}

function matchRouteInDoc(route, doc) {
  const regex = pathPatternToRegex(route.path);
  return doc.route_mentions.find((mention) => mention.method === route.method && regex.test(mention.path)) || null;
}

function buildCanonicalDocIndex(manifest, docsById, docOrder) {
  const orderLookup = new Map(docOrder.map((docId, index) => [docId, index]));
  const docSurfaceLookup = new Map([...docsById.values()].map((doc) => [doc.doc_id, doc.surface_path]));
  const routes = manifest.routes.map((route, routeIndex) => {
    const directCandidates = [...docsById.values()]
      .map((doc) => ({ docId: doc.doc_id, mention: matchRouteInDoc(route, doc) }))
      .filter((item) => item.mention);
    const refCandidates = [...new Set([...(route.doc_ids || []), ...(route.doc_refs || [])])]
      .filter((docId) => docsById.has(docId))
      .map((docId) => ({ docId, mention: null }));
    const directPool = directCandidates.length > 0 ? directCandidates : refCandidates;

    directPool.sort((a, b) => {
      const aDoc = docsById.get(a.docId);
      const bDoc = docsById.get(b.docId);
      const rankDelta = rankCanonicalDoc(route, aDoc) - rankCanonicalDoc(route, bDoc);
      if (rankDelta !== 0) return rankDelta;
      const docOrderDelta = (orderLookup.get(a.docId) ?? Number.MAX_SAFE_INTEGER) - (orderLookup.get(b.docId) ?? Number.MAX_SAFE_INTEGER);
      if (docOrderDelta !== 0) return docOrderDelta;
      const lineDelta = (a.mention?.line ?? Number.MAX_SAFE_INTEGER) - (b.mention?.line ?? Number.MAX_SAFE_INTEGER);
      if (lineDelta !== 0) return lineDelta;
      return a.docId.localeCompare(b.docId);
    });

    const chosen = directPool[0] || null;
    const canonicalDocId = chosen?.docId || null;
    const canonicalDoc = canonicalDocId ? docsById.get(canonicalDocId) : null;
    const mentionLine = chosen?.mention?.line || null;

    return {
      ...route,
      route_index: routeIndex,
      canonical_doc_id: canonicalDocId,
      canonical_doc_path: canonicalDoc ? docSurfaceLookup.get(canonicalDocId) : null,
      canonical_doc_title: canonicalDoc?.title || null,
      doc_step: canonicalDoc && mentionLine
        ? `${canonicalDoc.title} line ${mentionLine}`
        : (canonicalDoc?.title || 'missing doc path'),
      doc_order: canonicalDocId ? (orderLookup.get(canonicalDocId) ?? Number.MAX_SAFE_INTEGER) : Number.MAX_SAFE_INTEGER,
      doc_line: mentionLine ?? Number.MAX_SAFE_INTEGER,
      doc_direct: Boolean(chosen?.mention),
      learned_from_docs: directCandidates.length > 0,
    };
  });

  routes.sort((a, b) => {
    const orderDelta = a.doc_order - b.doc_order;
    if (orderDelta !== 0) return orderDelta;
    const lineDelta = a.doc_line - b.doc_line;
    if (lineDelta !== 0) return lineDelta;
    const routeOrderDelta = (a.order ?? Number.MAX_SAFE_INTEGER) - (b.order ?? Number.MAX_SAFE_INTEGER);
    if (routeOrderDelta !== 0) return routeOrderDelta;
    return a.route_index - b.route_index;
  });

  return {
    routes,
    byKey: new Map(routes.map((route) => [route.key, route])),
  };
}

async function fetchText(baseUrl, path, timeoutMs) {
  let lastError = null;
  for (const waitMs of [0, 250, 800]) {
    if (waitMs > 0) await new Promise((resolve) => setTimeout(resolve, waitMs));
    const response = await fetch(new URL(path, `${baseUrl}/`), {
      redirect: 'follow',
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await response.text();
    if (response.ok) return text;
    lastError = `Could not fetch ${path}: ${response.status} ${escapeHtml(text.slice(0, 200))}`;
    if (response.status < 500) break;
  }
  throw new Error(lastError || `Could not fetch ${path}`);
}

async function fetchDocSurface(baseUrl, path, { timeoutMs, allowLocalFallback }) {
  try {
    return await fetchText(baseUrl, path, timeoutMs);
  } catch (error) {
    if (!allowLocalFallback) throw error;
    const localPath = surfacePathToLocalFile(path);
    if (!localPath || !existsSync(localPath)) throw error;
    return readFileSync(localPath, 'utf8');
  }
}

async function fetchJson(baseUrl, path, timeoutMs) {
  const text = await fetchText(baseUrl, path, timeoutMs);
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`Could not parse JSON from ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function loadDocsByManifest(manifest, baseUrl, { timeoutMs, allowLocalFallback }) {
  const docsById = new Map();

  for (const doc of (manifest.docs || [])) {
    const surfacePath = doc.surfaces?.[0]?.path || docIdToSurfacePath(doc.doc_id);
    if (!surfacePath) {
      docsById.set(doc.doc_id, {
        ...doc,
        surface_path: null,
        text: '',
        route_mentions: [],
        doc_links: [],
      });
      continue;
    }
    const text = await fetchDocSurface(baseUrl, surfacePath, { timeoutMs, allowLocalFallback });
    docsById.set(doc.doc_id, {
      ...doc,
      surface_path: surfacePath,
      text,
      route_mentions: parseRouteMentions(text),
      doc_links: parseDocLinks(text),
    });
  }

  return docsById;
}

async function crawlDocsFromLlms(baseUrl, { timeoutMs, allowLocalFallback, requestGapMs = 0 }) {
  const docsById = new Map();
  const queue = ['/llms.txt'];
  const seenPaths = new Set();
  const errors = [];
  let firstFetch = true;

  while (queue.length > 0) {
    const surfacePath = normalizeMentionPath(queue.shift());
    if (!surfacePath || seenPaths.has(surfacePath)) continue;
    seenPaths.add(surfacePath);
    if (!firstFetch && requestGapMs > 0) {
      await sleep(requestGapMs);
    }
    firstFetch = false;

    const docId = surfacePathToDocId(surfacePath);
    try {
      const text = await fetchDocSurface(baseUrl, surfacePath, { timeoutMs, allowLocalFallback });
      const routeMentions = parseRouteMentions(text);
      const docLinks = parseDocLinks(text);
      docsById.set(docId, {
        doc_id: docId,
        surface_path: surfacePath,
        title: extractDocTitle(text, docId),
        text,
        route_mentions: routeMentions,
        doc_links: docLinks,
        surfaces: [{ path: surfacePath }],
      });

      for (const link of docLinks) {
        if (!seenPaths.has(link.path)) {
          queue.push(link.path);
        }
      }
    } catch (error) {
      errors.push({
        doc_id: docId,
        surface_path: surfacePath,
        error: error instanceof Error ? error.message : String(error),
      });
      docsById.set(docId, {
        doc_id: docId,
        surface_path: surfacePath,
        title: docId,
        text: '',
        route_mentions: [],
        doc_links: [],
        surfaces: [{ path: surfacePath }],
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return { docsById, errors };
}

export async function loadDocsDrivenManifest(baseUrl, {
  timeoutMs = 20000,
  mode = 'full_audit',
} = {}) {
  const manifest = await fetchJson(baseUrl, '/api/journey/manifest', timeoutMs);
  const allowLocalFallback = mode !== 'pure_prod';
  const crawled = mode === 'pure_prod'
    ? await crawlDocsFromLlms(baseUrl, { timeoutMs, allowLocalFallback, requestGapMs: 2100 })
    : null;
  const docsById = crawled?.docsById
    || await loadDocsByManifest(manifest, baseUrl, { timeoutMs, allowLocalFallback });

  const docOrder = sortDocsByFlow('llms.txt', docsById);
  const canonical = buildCanonicalDocIndex(manifest, docsById, docOrder);

  return {
    mode,
    manifest,
    docs_by_id: docsById,
    doc_order: docOrder,
    ordered_routes: canonical.routes,
    route_lookup: canonical.byKey,
    crawl_errors: crawled?.errors || [],
  };
}
