#!/usr/bin/env node

/**
 * Data Integrity Validator
 *
 * Scans data/ for corruption, missing fields, orphaned data, and inconsistencies.
 * Read-only -- never modifies any data file.
 *
 * Exit 0 if no errors (warnings ok), exit 1 if errors found.
 */

import { readFile, readdir, stat, mkdir, writeFile } from 'node:fs/promises';
import { resolve, join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const PROJECT_ROOT = resolve(__dirname, '..', '..');
const DATA_DIR = join(PROJECT_ROOT, 'data');
const REPORTS_DIR = join(__dirname, 'reports');

const SIZE_WARN_BYTES = 10 * 1024 * 1024; // 10 MB

// ── Issue collector ─────────────────────────────────────────────────────────

const issues = [];

function addIssue(severity, category, message, file) {
  issues.push({ severity, category, message, file: file || null });
}

// ── Helpers ─────────────────────────────────────────────────────────────────

async function exists(p) {
  try { await stat(p); return true; } catch { return false; }
}

async function tryReadJSON(filePath) {
  const raw = await readFile(filePath, 'utf-8');
  return JSON.parse(raw);
}

async function listSubdirs(dir) {
  let entries;
  try { entries = await readdir(dir, { withFileTypes: true }); } catch { return []; }
  return entries.filter(e => e.isDirectory() && !e.name.startsWith('.')).map(e => e.name);
}

/**
 * Recursively collect all files under a directory.
 * Returns array of { path, size, name }.
 */
async function walkFiles(dir) {
  const results = [];
  let entries;
  try { entries = await readdir(dir, { withFileTypes: true }); } catch { return results; }
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...await walkFiles(full));
    } else {
      const s = await stat(full);
      results.push({ path: full, size: s.size, name: entry.name });
    }
  }
  return results;
}

function relPath(absPath) {
  return absPath.startsWith(PROJECT_ROOT) ? absPath.slice(PROJECT_ROOT.length + 1) : absPath;
}

// ── Checks ──────────────────────────────────────────────────────────────────

let totalFilesChecked = 0;

/**
 * 1. JSON validity + file size warnings for all files under data/
 */
async function checkAllFiles() {
  const files = await walkFiles(DATA_DIR);

  for (const file of files) {
    totalFilesChecked++;
    const rel = relPath(file.path);

    // File size warning
    if (file.size > SIZE_WARN_BYTES) {
      addIssue('warning', 'file-size', `File exceeds 10 MB (${(file.size / 1024 / 1024).toFixed(1)} MB)`, rel);
    }

    const ext = extname(file.name);

    if (ext === '.json') {
      try {
        await tryReadJSON(file.path);
      } catch (err) {
        addIssue('error', 'json-parse', `Invalid JSON: ${err.message}`, rel);
      }
    }

    if (ext === '.jsonl') {
      try {
        const raw = await readFile(file.path, 'utf-8');
        const lines = raw.split('\n');
        let lineNum = 0;
        for (const line of lines) {
          lineNum++;
          const trimmed = line.trim();
          if (trimmed.length === 0) continue;
          try {
            JSON.parse(trimmed);
          } catch {
            addIssue('error', 'jsonl-parse', `Invalid JSON at line ${lineNum}`, rel);
          }
        }
      } catch (err) {
        addIssue('error', 'file-read', `Cannot read file: ${err.message}`, rel);
      }
    }
  }
}

/**
 * 2. Agent profile validation + orphan detection
 */
async function checkAgentProfiles() {
  const agentsDir = join(DATA_DIR, 'external-agents');
  if (!await exists(agentsDir)) {
    addIssue('info', 'agents', 'No external-agents directory found');
    return new Map();
  }

  const agentIds = await listSubdirs(agentsDir);
  const validAgents = new Map(); // id -> profile

  for (const agentId of agentIds) {
    const dir = join(agentsDir, agentId);
    const profilePath = join(dir, 'profile.json');

    if (!await exists(profilePath)) {
      addIssue('error', 'orphan', `Agent directory has no profile.json`, relPath(dir));
      continue;
    }

    let profile;
    try {
      profile = await tryReadJSON(profilePath);
    } catch (err) {
      addIssue('error', 'orphan', `Agent profile.json is invalid JSON: ${err.message}`, relPath(profilePath));
      continue;
    }

    // Required fields
    const required = ['id', 'name', 'api_key', 'registered_at'];
    const missing = required.filter(f => profile[f] === undefined || profile[f] === null);
    if (missing.length > 0) {
      addIssue('error', 'profile', `Missing required fields: ${missing.join(', ')}`, relPath(profilePath));
    }

    // ID mismatch
    if (profile.id && profile.id !== agentId) {
      addIssue('error', 'profile', `Profile id "${profile.id}" does not match directory name "${agentId}"`, relPath(profilePath));
    }

    validAgents.set(agentId, profile);
  }

  return validAgents;
}

/**
 * 3. State consistency
 */
async function checkAgentStates(validAgents) {
  for (const [agentId] of validAgents) {
    const statePath = join(DATA_DIR, 'external-agents', agentId, 'state.json');
    if (!await exists(statePath)) continue;

    let state;
    try {
      state = await tryReadJSON(statePath);
    } catch {
      // Already caught by checkAllFiles
      continue;
    }

    if (state.tier === undefined || state.tier === null) {
      addIssue('warning', 'state', `state.json missing "tier" field`, relPath(statePath));
    }

    if (state.agent_id && state.agent_id !== agentId) {
      addIssue('warning', 'state', `state.json agent_id "${state.agent_id}" does not match directory "${agentId}"`, relPath(statePath));
    }
  }
}

/**
 * 4. Reputation consistency
 */
async function checkAgentReputations(validAgents) {
  for (const [agentId] of validAgents) {
    const repPath = join(DATA_DIR, 'external-agents', agentId, 'reputation.json');
    if (!await exists(repPath)) continue;

    let rep;
    try {
      rep = await tryReadJSON(repPath);
    } catch {
      continue;
    }

    if (rep.agent_id && rep.agent_id !== agentId) {
      addIssue('warning', 'reputation', `reputation.json agent_id "${rep.agent_id}" does not match directory "${agentId}"`, relPath(repPath));
    }

    if (!rep.scores || typeof rep.scores !== 'object') {
      addIssue('warning', 'reputation', `reputation.json missing "scores" object`, relPath(repPath));
    }

    if (!Array.isArray(rep.badges)) {
      addIssue('warning', 'reputation', `reputation.json missing "badges" array`, relPath(repPath));
    }
  }
}

/**
 * 5. Lineage consistency
 */
async function checkAgentLineages(validAgents) {
  for (const [agentId] of validAgents) {
    const linPath = join(DATA_DIR, 'external-agents', agentId, 'lineage.json');
    if (!await exists(linPath)) continue;

    let lineage;
    try {
      lineage = await tryReadJSON(linPath);
    } catch {
      continue;
    }

    if (lineage.agent_id && lineage.agent_id !== agentId) {
      addIssue('warning', 'lineage', `lineage.json agent_id "${lineage.agent_id}" does not match directory "${agentId}"`, relPath(linPath));
    }

    if (lineage.forked_from && !validAgents.has(lineage.forked_from)) {
      addIssue('warning', 'lineage', `forked_from references non-existent agent "${lineage.forked_from}"`, relPath(linPath));
    }
  }
}

/**
 * 6. Ledger balance check + cross-reference
 */
async function checkLedger(validAgents) {
  const ledgerPath = join(DATA_DIR, 'wallet', 'ledger.jsonl');
  if (!await exists(ledgerPath)) {
    addIssue('info', 'ledger', 'No wallet/ledger.jsonl found');
    return;
  }

  let raw;
  try {
    raw = await readFile(ledgerPath, 'utf-8');
  } catch (err) {
    addIssue('error', 'ledger', `Cannot read ledger: ${err.message}`, relPath(ledgerPath));
    return;
  }

  const balances = new Map(); // agent_id -> net sats
  const referencedAgents = new Set();
  const lines = raw.split('\n');
  let lineNum = 0;

  for (const line of lines) {
    lineNum++;
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;

    let entry;
    try {
      entry = JSON.parse(trimmed);
    } catch {
      // Already caught by checkAllFiles
      continue;
    }

    const agentId = entry.agent_id;
    if (agentId) referencedAgents.add(agentId);
    if (entry.from_agent_id) referencedAgents.add(entry.from_agent_id);
    if (entry.to_agent_id) referencedAgents.add(entry.to_agent_id);

    if (!agentId) continue;

    const amt = entry.amount_sats || 0;
    const current = balances.get(agentId) || 0;

    switch (entry.type) {
      case 'deposit':
      case 'credit':
        balances.set(agentId, current + amt);
        break;
      case 'withdrawal':
      case 'melt':
        balances.set(agentId, current - amt);
        break;
      case 'transfer':
        // Debit sender, credit receiver
        if (entry.from_agent_id) {
          const fromBal = balances.get(entry.from_agent_id) || 0;
          balances.set(entry.from_agent_id, fromBal - amt);
        }
        if (entry.to_agent_id) {
          const toBal = balances.get(entry.to_agent_id) || 0;
          balances.set(entry.to_agent_id, toBal + amt);
        }
        break;
      // tournament -- context-dependent, skip net balance tracking
    }
  }

  // Flag negative balances
  for (const [agentId, balance] of balances) {
    if (balance < 0) {
      addIssue('warning', 'ledger-balance', `Agent "${agentId}" has negative ledger balance: ${balance} sats`, relPath(ledgerPath));
    }
  }

  // Cross-reference: agents in ledger should exist in external-agents
  for (const agentId of referencedAgents) {
    if (!validAgents.has(agentId)) {
      addIssue('warning', 'cross-ref', `Ledger references agent "${agentId}" which has no valid profile in external-agents/`, relPath(ledgerPath));
    }
  }
}

/**
 * 7. Leaderboard consistency
 */
async function checkLeaderboard(validAgents) {
  const lbPath = join(DATA_DIR, 'leaderboard', 'external-current.json');
  if (!await exists(lbPath)) {
    addIssue('info', 'leaderboard', 'No leaderboard/external-current.json found');
    return;
  }

  let data;
  try {
    data = await tryReadJSON(lbPath);
  } catch {
    return; // Already caught
  }

  if (!data.entries || !Array.isArray(data.entries)) {
    addIssue('warning', 'leaderboard', 'external-current.json missing "entries" array', relPath(lbPath));
    return;
  }

  for (const entry of data.entries) {
    if (entry.agent_id && !validAgents.has(entry.agent_id)) {
      addIssue('warning', 'cross-ref', `Leaderboard references agent "${entry.agent_id}" which has no valid profile`, relPath(lbPath));
    }
  }
}

// ── Report ──────────────────────────────────────────────────────────────────

function printReport() {
  const errors = issues.filter(i => i.severity === 'error');
  const warnings = issues.filter(i => i.severity === 'warning');
  const infos = issues.filter(i => i.severity === 'info');

  console.log('='.repeat(60));
  console.log('  Data Integrity Report');
  console.log('='.repeat(60));
  console.log();
  console.log(`  Files checked: ${totalFilesChecked}`);
  console.log(`  Errors:        ${errors.length}`);
  console.log(`  Warnings:      ${warnings.length}`);
  console.log(`  Info:          ${infos.length}`);
  console.log();

  if (errors.length > 0) {
    console.log('--- ERRORS ---');
    for (const i of errors) {
      console.log(`  [${i.category}] ${i.message}`);
      if (i.file) console.log(`    -> ${i.file}`);
    }
    console.log();
  }

  if (warnings.length > 0) {
    console.log('--- WARNINGS ---');
    for (const i of warnings) {
      console.log(`  [${i.category}] ${i.message}`);
      if (i.file) console.log(`    -> ${i.file}`);
    }
    console.log();
  }

  if (infos.length > 0) {
    console.log('--- INFO ---');
    for (const i of infos) {
      console.log(`  [${i.category}] ${i.message}`);
      if (i.file) console.log(`    -> ${i.file}`);
    }
    console.log();
  }

  const passed = errors.length === 0;
  console.log('='.repeat(60));
  console.log(`  Result: ${passed ? 'PASS' : 'FAIL'}${warnings.length > 0 ? ` (${warnings.length} warning${warnings.length !== 1 ? 's' : ''})` : ''}`);
  console.log('='.repeat(60));
}

async function writeJsonReport() {
  await mkdir(REPORTS_DIR, { recursive: true });
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const reportPath = join(REPORTS_DIR, `integrity-${timestamp}.json`);
  const report = {
    timestamp: new Date().toISOString(),
    files_checked: totalFilesChecked,
    summary: {
      errors: issues.filter(i => i.severity === 'error').length,
      warnings: issues.filter(i => i.severity === 'warning').length,
      info: issues.filter(i => i.severity === 'info').length,
      passed: issues.filter(i => i.severity === 'error').length === 0,
    },
    issues,
  };
  await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n', 'utf-8');
  console.log(`\nJSON report: ${relPath(reportPath)}`);
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main() {
  if (!await exists(DATA_DIR)) {
    console.log('No data/ directory found. Nothing to validate.');
    process.exit(0);
  }

  // Run all checks
  await checkAllFiles();
  const validAgents = await checkAgentProfiles();
  await checkAgentStates(validAgents);
  await checkAgentReputations(validAgents);
  await checkAgentLineages(validAgents);
  await checkLedger(validAgents);
  await checkLeaderboard(validAgents);

  // Output
  printReport();
  await writeJsonReport();

  const errorCount = issues.filter(i => i.severity === 'error').length;
  process.exit(errorCount > 0 ? 1 : 0);
}

main().catch(err => {
  console.error(`Fatal: ${err.message}`);
  process.exit(1);
});
