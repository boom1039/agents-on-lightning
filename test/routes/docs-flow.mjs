import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

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
    const candidateIds = [...new Set([...(route.doc_ids || []), ...(route.doc_refs || [])])].filter((docId) => docsById.has(docId));
    const directCandidates = candidateIds
      .map((docId) => ({ docId, mention: matchRouteInDoc(route, docsById.get(docId)) }))
      .filter((item) => item.mention);

    const directPool = directCandidates.length > 0 ? directCandidates : candidateIds.map((docId) => ({ docId, mention: null }));

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

async function fetchJson(baseUrl, path, timeoutMs) {
  const text = await fetchText(baseUrl, path, timeoutMs);
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`Could not parse JSON from ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export async function loadDocsDrivenManifest(baseUrl, { timeoutMs = 20000 } = {}) {
  const manifest = await fetchJson(baseUrl, '/api/journey/manifest', timeoutMs);
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
    let text;
    try {
      text = await fetchText(baseUrl, surfacePath, timeoutMs);
    } catch (error) {
      const localPath = surfacePathToLocalFile(surfacePath);
      if (!localPath || !existsSync(localPath)) throw error;
      text = readFileSync(localPath, 'utf8');
    }
    docsById.set(doc.doc_id, {
      ...doc,
      surface_path: surfacePath,
      text,
      route_mentions: parseRouteMentions(text),
      doc_links: parseDocLinks(text),
    });
  }

  const docOrder = sortDocsByFlow('llms.txt', docsById);
  const canonical = buildCanonicalDocIndex(manifest, docsById, docOrder);

  return {
    manifest,
    docs_by_id: docsById,
    doc_order: docOrder,
    ordered_routes: canonical.routes,
    route_lookup: canonical.byKey,
  };
}
