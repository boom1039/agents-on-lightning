#!/usr/bin/env node

/**
 * Docs Sync Check
 *
 * Compares docs/llms.txt + docs/skills/*.txt against src/routes/*.js to find:
 *   - Undocumented endpoints (in code but not in docs or skills)
 *   - Phantom endpoints (in docs but not in code)
 *   - Error handler references to nonexistent endpoints
 *   - Duplicate documentation (same endpoint in multiple files)
 *
 * Exit 0 = clean, exit 1 = issues found.
 */

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..', '..');

// Endpoints that are intentionally not documented (internal/operator-only/aliases/405 handlers)
const INTENTIONALLY_UNDOCUMENTED = new Set([
  // Test/operator-only
  'POST /api/v1/test/reset-rate-limits',
  'POST /api/v1/channels/assign',
  'DELETE /api/v1/channels/assign/:chanId',
  // Dashboard (operator monitoring)
  'GET /dashboard',
  'GET /dashboard/api/summary',
  'GET /dashboard/api/agents',
  'GET /dashboard/api/activity',
  'GET /dashboard/api/leaderboard',
  'GET /dashboard/api/transactions',
  'GET /dashboard/api/endpoints',
  // Route aliases (canonical route is documented, alias noted in docs)
  'GET /api/v1/analysis/profile-node/:pubkey',
  'GET /api/v1/analysis/node-profile/:pubkey',
  // 405 method-not-allowed teaching handlers (exist to guide agents, not real endpoints)
  'GET /api/v1/wallet/mint-quote',
  'GET /api/v1/market/preview',
  'GET /api/v1/market/open',
  'GET /api/v1/market/close',
]);

// ---------------------------------------------------------------------------
// 1. Parse documented endpoints from a text file
// ---------------------------------------------------------------------------

function parseEndpointsFromFile(filepath) {
  const text = readFileSync(filepath, 'utf-8');
  const endpoints = new Map(); // "METHOD /path" -> true

  // Match patterns like:
  //   POST /api/v1/agents/register
  //   GET  /api/v1/wallet/balance
  //   `GET /api/v1/foo`
  //   - method: `POST`  ... url: `/api/v1/foo`
  const methodPathRe = /\b(GET|POST|PUT|DELETE|PATCH)\s+[`]?\/?(?=api)(api\/v1(?:\/\S*)?)/gi;

  for (const match of text.matchAll(methodPathRe)) {
    const method = match[1].toUpperCase();
    let path = '/' + match[2]
      .replace(/[`'",.\s)]+$/g, '')          // strip trailing punctuation
      .replace(/\{([^}]+)\}/g, ':$1');        // {param} -> :param
    // Skip example paths with literal hex pubkeys (66-char hex strings)
    if (/\/[0-9a-f]{20,}$/i.test(path)) continue;
    endpoints.set(`${method} ${path}`, true);
  }

  // Also pick up "- method: `POST`" / "- url: `/api/v1/...`" blocks
  const methodUrlRe = /method:\s*`(GET|POST|PUT|DELETE|PATCH)`[\s\S]*?url:\s*`(\/api\/v1[^`]*)`/gi;
  for (const match of text.matchAll(methodUrlRe)) {
    const method = match[1].toUpperCase();
    let path = match[2].replace(/\{([^}]+)\}/g, ':$1');
    if (/\/[0-9a-f]{20,}$/i.test(path)) continue;
    endpoints.set(`${method} ${path}`, true);
  }

  return endpoints;
}

// ---------------------------------------------------------------------------
// 2. Parse all doc files (llms.txt + skills/*.txt)
// ---------------------------------------------------------------------------

function parseAllDocEndpoints() {
  const allEndpoints = new Map(); // "METHOD /path" -> [files...]
  const perFile = {};

  // Parse root llms.txt
  const llmsPath = resolve(ROOT, 'docs', 'llms.txt');
  const llmsEndpoints = parseEndpointsFromFile(llmsPath);
  perFile['llms.txt'] = llmsEndpoints.size;
  for (const key of llmsEndpoints.keys()) {
    if (!allEndpoints.has(key)) allEndpoints.set(key, []);
    allEndpoints.get(key).push('llms.txt');
  }

  // Parse skill files
  const skillsDir = resolve(ROOT, 'docs', 'skills');
  if (existsSync(skillsDir)) {
    const skillFiles = readdirSync(skillsDir).filter(f => f.endsWith('.txt'));
    for (const file of skillFiles) {
      const filepath = resolve(skillsDir, file);
      const endpoints = parseEndpointsFromFile(filepath);
      const label = `skills/${file}`;
      perFile[label] = endpoints.size;
      for (const key of endpoints.keys()) {
        if (!allEndpoints.has(key)) allEndpoints.set(key, []);
        allEndpoints.get(key).push(label);
      }
    }
  }

  return { allEndpoints, perFile };
}

// ---------------------------------------------------------------------------
// 3. Scan src/routes/*.js for registered routes
// ---------------------------------------------------------------------------

function parseCodeRoutes() {
  const routesDir = resolve(ROOT, 'src', 'routes');
  const files = readdirSync(routesDir).filter(f => f.endsWith('.js'));
  const endpoints = new Map(); // "METHOD /path" -> { file, line }

  for (const file of files) {
    const filepath = resolve(routesDir, file);
    const source = readFileSync(filepath, 'utf-8');

    const routeRe = /router\.(get|post|put|delete|patch)\(\s*(\[[^\]]+\]|'[^']*'|"[^"]*"|`[^`]*`)/gi;
    let m;
    while ((m = routeRe.exec(source)) !== null) {
      const method = m[1].toUpperCase();
      const rawArg = m[2];
      const line = source.substring(0, m.index).split('\n').length;

      const paths = [];
      if (rawArg.startsWith('[')) {
        const pathStrRe = /['"`]([^'"`]+)['"`]/g;
        let pm;
        while ((pm = pathStrRe.exec(rawArg)) !== null) {
          paths.push(pm[1]);
        }
      } else {
        const pathStrRe = /['"`]([^'"`]+)['"`]/;
        const pm = rawArg.match(pathStrRe);
        if (pm) paths.push(pm[1]);
      }

      for (const path of paths) {
        if (path.startsWith('/api/v1') || path.startsWith('/dashboard')) {
          const key = `${method} ${path}`;
          if (!endpoints.has(key)) {
            endpoints.set(key, { file, line });
          }
        }
      }
    }
  }

  return endpoints;
}

// ---------------------------------------------------------------------------
// 4. Scan agent-friendly-errors.js for see/hint endpoint references
// ---------------------------------------------------------------------------

function parseErrorReferences() {
  const filepath = resolve(ROOT, 'src', 'identity', 'agent-friendly-errors.js');
  const source = readFileSync(filepath, 'utf-8');
  const refs = [];

  const seeHintRe = /(?:see|hint):\s*['"`]([^'"`]+)['"`]/g;
  let m;
  while ((m = seeHintRe.exec(source)) !== null) {
    const value = m[1];
    const epRe = /(GET|POST|PUT|DELETE|PATCH)\s+(\/api\/v1\/\S+)/gi;
    let em;
    while ((em = epRe.exec(value)) !== null) {
      const method = em[1].toUpperCase();
      const path = em[2].replace(/[.,;'"]+$/g, '');
      refs.push({ method, path, raw: m[1] });
    }
  }

  return refs;
}

// ---------------------------------------------------------------------------
// 5. Normalize paths for comparison
// ---------------------------------------------------------------------------

function normalizePath(path) {
  return path
    .replace(/\/[0-9a-f]{66}/g, '/:pubkey')
    .replace(/\/$/, '');
}

function routeMatches(docPath, codePaths) {
  const docNorm = normalizePath(docPath);
  const docSegments = docNorm.split('/');

  for (const codePath of codePaths) {
    const codeNorm = normalizePath(codePath);
    const codeSegments = codeNorm.split('/');
    if (docSegments.length !== codeSegments.length) continue;

    let match = true;
    for (let i = 0; i < docSegments.length; i++) {
      const ds = docSegments[i];
      const cs = codeSegments[i];
      if (ds.startsWith(':') || cs.startsWith(':')) continue;
      if (ds !== cs) { match = false; break; }
    }
    if (match) return codePath;
  }
  return null;
}

// ---------------------------------------------------------------------------
// 6. Compare and report
// ---------------------------------------------------------------------------

function run() {
  const { allEndpoints, perFile } = parseAllDocEndpoints();
  const codeRoutes = parseCodeRoutes();
  const errorRefs = parseErrorReferences();

  // Build lookup structures
  const codeByMethod = new Map();
  for (const key of codeRoutes.keys()) {
    const [method, path] = key.split(' ', 2);
    if (!codeByMethod.has(method)) codeByMethod.set(method, []);
    codeByMethod.get(method).push(path);
  }

  const docByMethod = new Map();
  for (const key of allEndpoints.keys()) {
    const [method, path] = key.split(' ', 2);
    if (!docByMethod.has(method)) docByMethod.set(method, []);
    docByMethod.get(method).push(path);
  }

  const issues = [];

  // --- Undocumented endpoints: in code but not in docs ---
  const undocumented = [];
  for (const [key, info] of codeRoutes) {
    if (INTENTIONALLY_UNDOCUMENTED.has(key)) continue;
    const [method, codePath] = key.split(' ', 2);
    const docPaths = docByMethod.get(method) || [];
    const matched = routeMatches(codePath, docPaths);
    if (!matched) {
      undocumented.push({ method, path: codePath, file: info.file, line: info.line });
    }
  }

  // --- Phantom endpoints: in docs but not in code ---
  const phantoms = [];
  for (const key of allEndpoints.keys()) {
    const [method, docPath] = key.split(' ', 2);
    const codePaths = codeByMethod.get(method) || [];
    const matched = routeMatches(docPath, codePaths);
    if (!matched) {
      const files = allEndpoints.get(key);
      phantoms.push({ method, path: docPath, files });
    }
  }

  // --- Duplicate documentation: same endpoint in multiple files ---
  const duplicates = [];
  for (const [key, files] of allEndpoints) {
    if (files.length > 1) {
      duplicates.push({ endpoint: key, files });
    }
  }

  // --- Error handler references to nonexistent endpoints ---
  const badRefs = [];
  for (const ref of errorRefs) {
    const codePaths = codeByMethod.get(ref.method) || [];
    const matched = routeMatches(ref.path, codePaths);
    if (!matched) {
      badRefs.push(ref);
    }
  }

  // --- Report ---
  console.log('=== Docs Sync Check ===\n');
  console.log(`Documented endpoints:  ${allEndpoints.size}`);
  console.log(`Code routes:           ${codeRoutes.size}`);
  console.log(`Intentionally skipped: ${INTENTIONALLY_UNDOCUMENTED.size}`);
  console.log(`Error handler refs:    ${errorRefs.length}\n`);

  // Per-file breakdown
  console.log('--- Coverage by file ---');
  for (const [file, count] of Object.entries(perFile)) {
    console.log(`  ${file}: ${count} endpoints`);
  }
  console.log();

  if (undocumented.length > 0) {
    console.log(`--- Undocumented endpoints (${undocumented.length}) ---`);
    console.log('Routes in code but not in any doc file:\n');
    for (const ep of undocumented) {
      console.log(`  ${ep.method} ${ep.path}`);
      console.log(`    src/routes/${ep.file}:${ep.line}`);
    }
    console.log();
    issues.push(...undocumented.map(e => `undocumented: ${e.method} ${e.path}`));
  }

  if (phantoms.length > 0) {
    console.log(`--- Phantom endpoints (${phantoms.length}) ---`);
    console.log('Documented but no matching route in code:\n');
    for (const ep of phantoms) {
      console.log(`  ${ep.method} ${ep.path}`);
      console.log(`    in: ${ep.files.join(', ')}`);
    }
    console.log();
    issues.push(...phantoms.map(e => `phantom: ${e.method} ${e.path}`));
  }

  if (duplicates.length > 0) {
    console.log(`--- Duplicate documentation (${duplicates.length}) ---`);
    console.log('Same endpoint documented in multiple files:\n');
    for (const dup of duplicates) {
      console.log(`  ${dup.endpoint}`);
      console.log(`    in: ${dup.files.join(', ')}`);
    }
    console.log();
    // Duplicates are warnings, not blocking issues
  }

  if (badRefs.length > 0) {
    console.log(`--- Bad error handler references (${badRefs.length}) ---`);
    console.log('Endpoints in agent-friendly-errors.js see/hint fields that do not exist:\n');
    for (const ref of badRefs) {
      console.log(`  ${ref.method} ${ref.path}`);
      console.log(`    referenced in: "${ref.raw}"`);
    }
    console.log();
    issues.push(...badRefs.map(r => `bad-ref: ${r.method} ${r.path}`));
  }

  if (issues.length === 0) {
    console.log('All clean. Docs and code are in sync.');
    process.exit(0);
  } else {
    console.log(`${issues.length} issue(s) found.`);
    process.exit(1);
  }
}

run();
