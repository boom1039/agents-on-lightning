/**
 * Live Agent Docs Graph Server
 *
 * Scans docs/ for cross-references, serves the graph visualization,
 * and pushes real-time updates via SSE when files change.
 *
 * Run:  node docs/graph/live-agent-docs-graph-server-scans-crossrefs-pushes-sse-updates.mjs
 * View: http://localhost:3307
 *
 * Zero new dependencies — uses Express (already installed) + Node built-ins.
 */

import express from 'express';
import { readFile, readdir } from 'node:fs/promises';
import { watch, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(__dirname, '..', '..');
const docsDir = join(projectRoot, 'docs');
const skillsDir = join(docsDir, 'skills');
const knowledgeDir = join(docsDir, 'knowledge');

// ── Route→file maps (source: src/routes/agent-discovery-routes.js lines 17-60) ──

const KNOWLEDGE_TOPICS = {
  'strategy': 'lnbook_MEMORY_CONDENSED.md',
  'protocol': 'bolts_MEMORY_CONDENSED.md',
  'rebalancing': 'balanceofsatoshis_MEMORY_CONDENSED.md',
  'operator-wisdom': 'alex_bosworth_writings_MEMORY_CONDENSED.md',
  'onboarding': 'agent_onboarding_guide.md',
};

const SKILL_TOPICS = {
  // Canonical (lines 26-36)
  'discovery': 'discovery.txt',
  'identity': 'identity.txt',
  'wallet': 'wallet.txt',
  'analysis': 'analysis.txt',
  'social': 'social.txt',
  'channels': 'channels.txt',
  'market': 'market.txt',
  'capital': 'capital.txt',
  'analytics': 'analytics.txt',
  // Aliases (lines 39-60)
  'analytics-catalog-and-quote': 'analytics-catalog-and-quote.txt',
  'analytics-execute-and-history': 'analytics-execute-and-history.txt',
  'capital-balance-and-activity': 'capital-balance-and-activity.txt',
  'capital-deposit-and-status': 'capital-deposit-and-status.txt',
  'capital-withdraw-and-help': 'capital-withdraw-and-help.txt',
  'channels-audit-and-monitoring': 'channels-audit-and-monitoring.txt',
  'channels-signed-channel-lifecycle': 'channels-signed-channel-lifecycle.txt',
  'channels-signed': 'channels-signed.txt',
  'social-messaging': 'social-messaging.txt',
  'social-alliances': 'social-alliances.txt',
  'social-leaderboard-and-tournaments': 'social-leaderboard-and-tournaments.txt',
  'market-public-market-read': 'market-public-market-read.txt',
  'market-teaching-surfaces': 'market-teaching-surfaces.txt',
  'market-open-flow': 'market-open-flow.txt',
  'market-close': 'market-close.txt',
  'market-close-revenue-performance': 'market-close.txt',
  'market-swap': 'market-swap-ecash-and-rebalance.txt',
  'swap-ecash-and-rebalance': 'market-swap-ecash-and-rebalance.txt',
  'market-swap-ecash-and-rebalance': 'market-swap-ecash-and-rebalance.txt',
  'signing-secp256k1': 'signing-secp256k1.txt',
};

// Reverse: filename → node ID (use filename-based IDs to avoid alias collisions)
const fileToNodeId = {};
for (const file of new Set(Object.values(SKILL_TOPICS))) {
  fileToNodeId[file] = file.replace(/\.txt$/, '');
}

// ── Reference resolution (replicates agent-discovery-routes.js:422-475) ──

function resolveSkillRoute(routePath) {
  // routePath like "wallet" or "social/messaging.txt"
  const parts = routePath.split('/');
  let name;
  if (parts.length === 1) {
    name = (parts[0].endsWith('.txt') ? parts[0].slice(0, -4) : parts[0]).replace(/:/g, '-');
  } else {
    const group = parts[0].replace(/:/g, '-');
    const helper = (parts[1].endsWith('.txt') ? parts[1].slice(0, -4) : parts[1]).replace(/:/g, '-');
    name = `${group}-${helper}`;
  }
  const filename = SKILL_TOPICS[name];
  return filename ? fileToNodeId[filename] : null;
}

function resolveKnowledgeRoute(topic) {
  return KNOWLEDGE_TOPICS[topic] ? `knowledge/${topic}` : null;
}

function resolveDirectFileRef(filename) {
  return fileToNodeId[filename] || null;
}

// ── Node metadata ──

function detectRole(filename, content) {
  if (filename === 'llms.txt') return 'entry';
  if (/^#\s*Compatibility Pointer/m.test(content)) return 'pointer';
  if (/Use this file as an?\s+(map|.*index) only/i.test(content)) return 'map';
  if (filename === 'signing-secp256k1.txt') return 'helper';
  return 'group';
}

function detectDomain(nodeId) {
  if (nodeId === 'llms.txt') return 'entry';
  if (nodeId.startsWith('knowledge/')) return 'knowledge';
  if (nodeId === 'signing-secp256k1') return 'signing';
  const prefix = nodeId.split('-')[0];
  const map = { discovery: 'discovery', identity: 'identity', wallet: 'wallet', analysis: 'analysis',
    social: 'social', channels: 'channels', market: 'market', analytics: 'analytics', capital: 'capital' };
  return map[prefix] || 'discovery';
}

function detectStage(domain) {
  if (['entry', 'discovery', 'knowledge'].includes(domain)) return 'discover';
  if (domain === 'identity') return 'register';
  if (['wallet', 'capital'].includes(domain)) return 'fund';
  return 'act';
}

function makeLabel(nodeId) {
  if (nodeId.startsWith('knowledge/')) return nodeId;
  const parts = nodeId.split('-');
  if (parts.length > 1) return `${parts[0]}/${parts.slice(1).join('-')}`;
  return nodeId;
}

function extractDesc(content) {
  // Use first blockquote or subtitle after the heading
  const bq = content.match(/^>\s*(.+)/m);
  if (bq) return bq[1].trim();
  const sub = content.match(/^#[^#\n]+\n+([^#\n][^\n]{10,80})/m);
  if (sub) return sub[1].trim();
  return '';
}

// ── Scanner ──

async function scanDocs() {
  const nodes = [];
  const edges = [];
  const nodeSet = new Set();

  // Collect all doc files
  const files = [];

  // llms.txt
  const llmsPath = join(docsDir, 'llms.txt');
  if (existsSync(llmsPath)) files.push({ path: llmsPath, filename: 'llms.txt', dir: 'root' });

  // skills/
  try {
    const skillFiles = await readdir(skillsDir);
    for (const f of skillFiles) {
      if (f.endsWith('.txt')) files.push({ path: join(skillsDir, f), filename: f, dir: 'skills' });
    }
  } catch {}

  // knowledge/
  try {
    const kFiles = await readdir(knowledgeDir);
    for (const f of kFiles) {
      if (f.endsWith('.md')) files.push({ path: join(knowledgeDir, f), filename: f, dir: 'knowledge' });
    }
  } catch {}

  // Read and process each file
  for (const file of files) {
    let content;
    try { content = await readFile(file.path, 'utf8'); } catch { continue; }

    let nodeId;
    if (file.dir === 'root') {
      nodeId = 'llms.txt';
    } else if (file.dir === 'knowledge') {
      const topic = Object.entries(KNOWLEDGE_TOPICS).find(([, f]) => f === file.filename);
      if (!topic) continue;
      nodeId = `knowledge/${topic[0]}`;
    } else {
      nodeId = fileToNodeId[file.filename];
      if (!nodeId) nodeId = file.filename.replace(/\.txt$/, '');
    }

    const role = file.dir === 'knowledge' ? 'knowledge' : detectRole(file.filename, content);
    const domain = detectDomain(nodeId);

    if (!nodeSet.has(nodeId)) {
      nodeSet.add(nodeId);
      nodes.push({
        id: nodeId,
        label: makeLabel(nodeId),
        domain,
        role,
        file: `docs/${file.dir === 'root' ? '' : file.dir + '/'}${file.filename}`,
        stage: detectStage(domain),
        desc: extractDesc(content),
      });
    }

    // Extract cross-references
    const refs = [];

    // Determine if we're in a "See Also" section (with or without heading markers)
    const seeAlsoStart = content.search(/(?:##?\s*)?See [Aa]lso/m);

    // GET /api/v1/skills/...
    for (const m of content.matchAll(/GET\s+\/api\/v1\/skills\/([\w\/.:-]+(?:\.txt)?)/g)) {
      const target = resolveSkillRoute(m[1]);
      if (target && target !== nodeId) {
        const isSeeAlso = seeAlsoStart >= 0 && m.index > seeAlsoStart;
        refs.push({ target, via: `GET /api/v1/skills/${m[1]}`, seeAlso: isSeeAlso });
      }
    }

    // /api/v1/knowledge/... (with or without GET prefix — tables use bare URLs)
    for (const m of content.matchAll(/(?:GET\s+)?\/api\/v1\/knowledge\/([\w-]+)/g)) {
      const target = resolveKnowledgeRoute(m[1]);
      if (target && target !== nodeId) {
        refs.push({ target, via: `/api/v1/knowledge/${m[1]}`, knowledge: true });
      }
    }

    // GET /llms.txt
    if (content.match(/GET\s+\/llms\.txt/) && nodeId !== 'llms.txt') {
      refs.push({ target: 'llms.txt', via: 'GET /llms.txt', seeAlso: false });
    }

    // GET /docs/skills/...
    for (const m of content.matchAll(/GET\s+\/docs\/skills\/([\w-]+\.txt)/g)) {
      const target = resolveDirectFileRef(m[1]);
      if (target && target !== nodeId) {
        const isSeeAlso = seeAlsoStart >= 0 && m.index > seeAlsoStart;
        refs.push({ target, via: `GET /docs/skills/${m[1]}`, seeAlso: isSeeAlso });
      }
    }

    // Deduplicate edges from this source
    const seen = new Set();
    for (const ref of refs) {
      const key = `${nodeId}→${ref.target}`;
      if (seen.has(key)) continue;
      seen.add(key);

      let type = 'map-link';
      if (role === 'pointer') type = 'pointer-redirect';
      else if (ref.knowledge) type = 'knowledge-ref';
      else if (ref.seeAlso) type = 'see-also';

      edges.push({ source: nodeId, target: ref.target, via: ref.via, type });
    }
  }

  // ── Compute issues ──
  const adj = {};
  nodes.forEach(n => adj[n.id] = []);
  edges.forEach(e => { if (adj[e.source]) adj[e.source].push(e.target); });

  const deadEnds = nodes.filter(n => (adj[n.id] || []).length === 0).map(n => n.id);
  const incoming = new Set(edges.map(e => e.target));
  const orphans = nodes.filter(n => !incoming.has(n.id) && n.id !== 'llms.txt').map(n => n.id);
  const pointers = nodes.filter(n => n.role === 'pointer').map(n => n.id);

  // Duplicate paths: group files reachable from llms.txt directly AND via map parent
  const directFromLlms = new Set(edges.filter(e => e.source === 'llms.txt').map(e => e.target));
  const maps = nodes.filter(n => n.role === 'map').map(n => n.id);
  const dupPaths = [];
  for (const mapId of maps) {
    const children = edges.filter(e => e.source === mapId && e.type === 'map-link').map(e => e.target);
    for (const child of children) {
      if (directFromLlms.has(child)) {
        dupPaths.push({ node: child, path1: `llms.txt → ${child}`, path2: `llms.txt → ${mapId} → ${child}` });
      }
    }
  }

  const issues = { deadEnds, orphans, pointers, dupPaths, nodeCount: nodes.length, edgeCount: edges.length };

  return { nodes, edges, issues };
}

// ── Line-level diff (Myers-like, simple O(n*m) LCS for short files) ──

function computeLineDiff(oldText, newText) {
  const oldLines = oldText.split('\n');
  const newLines = newText.split('\n');

  // Simple LCS to find common lines, then derive added/removed
  const m = oldLines.length, n = newLines.length;

  // For very large files, cap to avoid O(n*m) blowup — just show first/last changes
  if (m * n > 500_000) {
    const hunks = [];
    // Quick scan: find first and last differing regions
    let top = 0;
    while (top < m && top < n && oldLines[top] === newLines[top]) top++;
    let botO = m - 1, botN = n - 1;
    while (botO > top && botN > top && oldLines[botO] === newLines[botN]) { botO--; botN--; }
    if (top <= botO || top <= botN) {
      const lines = [];
      for (let i = top; i <= botO; i++) lines.push({ type: 'del', line: i + 1, text: oldLines[i] });
      for (let i = top; i <= botN; i++) lines.push({ type: 'add', line: i + 1, text: newLines[i] });
      hunks.push({ startOld: top + 1, startNew: top + 1, lines });
    }
    return hunks;
  }

  // Standard LCS table
  const dp = Array.from({ length: m + 1 }, () => new Uint16Array(n + 1));
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = oldLines[i - 1] === newLines[j - 1]
        ? dp[i - 1][j - 1] + 1
        : Math.max(dp[i - 1][j], dp[i][j - 1]);
    }
  }

  // Backtrack to build diff sequence
  const ops = []; // { type: 'keep'|'del'|'add', text, oldLine, newLine }
  let i = m, j = n;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && oldLines[i - 1] === newLines[j - 1]) {
      ops.push({ type: 'keep', text: oldLines[i - 1], oldLine: i, newLine: j });
      i--; j--;
    } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
      ops.push({ type: 'add', text: newLines[j - 1], newLine: j });
      j--;
    } else {
      ops.push({ type: 'del', text: oldLines[i - 1], oldLine: i });
      i--;
    }
  }
  ops.reverse();

  // Group into hunks (contiguous change regions with 3-line context)
  const CONTEXT = 3;
  const hunks = [];
  let hunk = null;

  for (let k = 0; k < ops.length; k++) {
    const op = ops[k];
    if (op.type !== 'keep') {
      // Start a new hunk or extend current one
      if (!hunk) {
        hunk = { startOld: op.oldLine || 0, startNew: op.newLine || 0, lines: [] };
        // Add leading context
        for (let c = Math.max(0, k - CONTEXT); c < k; c++) {
          hunk.lines.push({ type: 'ctx', line: ops[c].oldLine, text: ops[c].text });
        }
        // Adjust start lines
        if (hunk.lines.length) {
          hunk.startOld = hunk.lines[0].line || hunk.startOld;
          hunk.startNew = hunk.lines[0].line || hunk.startNew;
        }
      }
      hunk.lines.push({ type: op.type, line: op.oldLine || op.newLine, text: op.text });
      hunk._lastChangeIdx = hunk.lines.length - 1;
    } else if (hunk) {
      // Context after changes — add up to CONTEXT lines, then maybe close hunk
      const sinceLastChange = hunk.lines.length - 1 - hunk._lastChangeIdx;
      if (sinceLastChange < CONTEXT) {
        hunk.lines.push({ type: 'ctx', line: op.oldLine, text: op.text });
      } else {
        // Check if next change is close enough to merge
        let nextChange = -1;
        for (let look = k + 1; look < ops.length && look <= k + CONTEXT * 2; look++) {
          if (ops[look].type !== 'keep') { nextChange = look; break; }
        }
        if (nextChange >= 0) {
          hunk.lines.push({ type: 'ctx', line: op.oldLine, text: op.text });
        } else {
          delete hunk._lastChangeIdx;
          hunks.push(hunk);
          hunk = null;
        }
      }
    }
  }
  if (hunk) { delete hunk._lastChangeIdx; hunks.push(hunk); }

  return hunks;
}

// ── Graph-level diff ──

function diffGraphs(prev, next) {
  const prevNodeIds = new Set((prev?.nodes || []).map(n => n.id));
  const nextNodeIds = new Set(next.nodes.map(n => n.id));
  const prevEdgeKeys = new Set((prev?.edges || []).map(e => `${e.source}→${e.target}`));
  const nextEdgeKeys = new Set(next.edges.map(e => `${e.source}→${e.target}`));

  return {
    added_nodes: next.nodes.filter(n => !prevNodeIds.has(n.id)).map(n => n.id),
    removed_nodes: [...prevNodeIds].filter(id => !nextNodeIds.has(id)),
    added_edges: next.edges.filter(e => !prevEdgeKeys.has(`${e.source}→${e.target}`)).map(e => `${e.source}→${e.target}`),
    removed_edges: [...prevEdgeKeys].filter(k => !nextEdgeKeys.has(k)),
  };
}

// ── File content tracking ──

const previousContents = new Map(); // relPath → content string

async function computeFileDiffs() {
  const diffs = [];
  const currentContents = new Map();

  // llms.txt
  const llmsPath = join(docsDir, 'llms.txt');
  if (existsSync(llmsPath)) {
    try {
      const content = await readFile(llmsPath, 'utf8');
      currentContents.set('docs/llms.txt', content);
    } catch {}
  }

  // skills/
  try {
    for (const f of await readdir(skillsDir)) {
      if (!f.endsWith('.txt')) continue;
      try {
        const content = await readFile(join(skillsDir, f), 'utf8');
        currentContents.set(`docs/skills/${f}`, content);
      } catch {}
    }
  } catch {}

  // knowledge/
  try {
    for (const f of await readdir(knowledgeDir)) {
      if (!f.endsWith('.md')) continue;
      try {
        const content = await readFile(join(knowledgeDir, f), 'utf8');
        currentContents.set(`docs/knowledge/${f}`, content);
      } catch {}
    }
  } catch {}

  // Compare with previous
  for (const [path, newContent] of currentContents) {
    const oldContent = previousContents.get(path);
    if (oldContent !== undefined && oldContent !== newContent) {
      const hunks = computeLineDiff(oldContent, newContent);
      if (hunks.length > 0) {
        diffs.push({ file: path, hunks });
      }
    } else if (oldContent === undefined && previousContents.size > 0) {
      // New file (only flag after initial scan)
      diffs.push({ file: path, type: 'new' });
    }
  }

  // Detect deleted files
  for (const path of previousContents.keys()) {
    if (!currentContents.has(path)) {
      diffs.push({ file: path, type: 'deleted' });
    }
  }

  // Update stored contents
  previousContents.clear();
  for (const [path, content] of currentContents) {
    previousContents.set(path, content);
  }

  return diffs;
}

// ── SSE ──

const sseClients = new Set();

function broadcast(data) {
  const msg = `data: ${JSON.stringify(data)}\n\n`;
  for (const res of sseClients) {
    try { res.write(msg); } catch { sseClients.delete(res); }
  }
}

// ── State ──

let currentGraph = null;

async function rescan() {
  const prev = currentGraph;
  const fileDiffs = await computeFileDiffs();
  currentGraph = await scanDocs();

  if (prev) {
    const diff = diffGraphs(prev, currentGraph);
    const hasGraphChanges = diff.added_nodes.length || diff.removed_nodes.length ||
      diff.added_edges.length || diff.removed_edges.length;
    const hasFileChanges = fileDiffs.length > 0;

    if (hasGraphChanges || hasFileChanges) {
      console.log(`[${new Date().toLocaleTimeString()}] Change detected:`,
        `+${diff.added_nodes.length} nodes, -${diff.removed_nodes.length} nodes,`,
        `+${diff.added_edges.length} edges, -${diff.removed_edges.length} edges,`,
        `${fileDiffs.length} file(s) changed`);
      broadcast({ ...currentGraph, diff, fileDiffs });
    }
  } else {
    // First scan — seed the content store (fileDiffs already captured contents)
  }
}

// ── File watcher with debounce ──

let debounceTimer = null;
function watchDocs() {
  try {
    watch(docsDir, { recursive: true }, (_event, filename) => {
      if (!filename) return;
      if (filename.includes('graph/')) return; // ignore our own output
      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(rescan, 500);
    });
  } catch (err) {
    console.warn('fs.watch failed, falling back to polling');
    setInterval(rescan, 3000);
  }
}

// ── Express server ──

const app = express();

app.get('/', (_req, res) => {
  res.sendFile(join(__dirname, 'interactive-agent-docs-navigation-graph-with-live-updates.html'));
});

app.get('/api/graph', (_req, res) => {
  res.json(currentGraph || { nodes: [], edges: [], issues: {} });
});

app.get('/api/events', (req, res) => {
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
  });
  res.flushHeaders();

  // Send current state immediately
  res.write(`data: ${JSON.stringify(currentGraph)}\n\n`);
  sseClients.add(res);

  req.on('close', () => sseClients.delete(res));
});

const PORT = 3307;

async function start() {
  await rescan();
  watchDocs();
  app.listen(PORT, () => {
    console.log(`Live docs graph at http://localhost:${PORT}`);
    console.log(`Watching ${docsDir} for changes...`);
    console.log(`${currentGraph.nodes.length} nodes, ${currentGraph.edges.length} edges`);
  });
}

start().catch(err => { console.error(err); process.exit(1); });
