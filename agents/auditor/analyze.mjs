#!/usr/bin/env node

/**
 * Auditor agent -- reads platform audit logs, detects anomalies, writes report.
 *
 * Usage:
 *   node agents/auditor/analyze.mjs              # last 24 hours
 *   node agents/auditor/analyze.mjs --since 6    # last 6 hours
 */

import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';


// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, '..', '..');
const SECURITY_LOG = resolve(PROJECT_ROOT, 'data', 'security-audit.jsonl');
const WALLET_LEDGER = resolve(PROJECT_ROOT, 'data', 'wallet', 'ledger.jsonl');
const AUDIT_CHAIN = resolve(PROJECT_ROOT, 'data', 'channel-accountability', 'audit-chain.jsonl');
const REPORTS_DIR = resolve(__dirname, 'reports');

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------

function parseArgs() {
  const args = process.argv.slice(2);
  let sinceHours = 24;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--since' && args[i + 1]) {
      sinceHours = Number(args[i + 1]);
      if (Number.isNaN(sinceHours) || sinceHours <= 0) {
        console.error('--since must be a positive number (hours)');
        process.exit(1);
      }
    }
  }
  return { sinceHours };
}

// ---------------------------------------------------------------------------
// JSONL reader
// ---------------------------------------------------------------------------

async function readJSONL(filePath, sinceTs) {
  let raw;
  try {
    raw = await readFile(filePath, 'utf-8');
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
  const entries = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      const obj = JSON.parse(line);
      const ts = obj._ts || obj.recorded_at || 0;
      if (ts >= sinceTs) entries.push(obj);
    } catch {
      // skip malformed lines
    }
  }
  return entries;
}

// ---------------------------------------------------------------------------
// Detection: auth brute force
// ---------------------------------------------------------------------------

function detectAuthBruteForce(events) {
  const authFailures = events.filter(e => e.event === 'auth_failure');
  // Group by IP, then check for 5+ in any 10-minute window
  const byIp = new Map();
  for (const e of authFailures) {
    const ip = e.ip || 'unknown';
    if (!byIp.has(ip)) byIp.set(ip, []);
    byIp.get(ip).push(e._ts);
  }

  const alerts = [];
  const WINDOW = 10 * 60 * 1000;
  for (const [ip, timestamps] of byIp) {
    timestamps.sort((a, b) => a - b);
    for (let i = 0; i <= timestamps.length - 5; i++) {
      if (timestamps[i + 4] - timestamps[i] <= WINDOW) {
        alerts.push({
          type: 'auth_brute_force',
          ip,
          count: timestamps.length,
          window_start: new Date(timestamps[i]).toISOString(),
          window_end: new Date(timestamps[i + 4]).toISOString(),
        });
        break; // one alert per IP
      }
    }
  }
  return alerts;
}

// ---------------------------------------------------------------------------
// Detection: stuck agents
// ---------------------------------------------------------------------------

function detectStuckAgents(events) {
  const apiRequests = events.filter(e => e.event === 'api_request' && e.agent_id);
  // Group by agent_id + path
  const byKey = new Map();
  for (const e of apiRequests) {
    const key = `${e.agent_id}::${e.path}`;
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key).push(e._ts);
  }

  const alerts = [];
  const WINDOW = 5 * 60 * 1000;
  for (const [key, timestamps] of byKey) {
    timestamps.sort((a, b) => a - b);
    for (let i = 0; i <= timestamps.length - 10; i++) {
      if (timestamps[i + 9] - timestamps[i] <= WINDOW) {
        const [agentId, path] = key.split('::');
        alerts.push({
          type: 'stuck_agent',
          agent_id: agentId,
          path,
          hits: timestamps.length,
          window_start: new Date(timestamps[i]).toISOString(),
          window_end: new Date(timestamps[i + 9]).toISOString(),
        });
        break;
      }
    }
  }
  return alerts;
}

// ---------------------------------------------------------------------------
// Detection: registration spikes
// ---------------------------------------------------------------------------

function detectRegistrationSpikes(events) {
  const regs = events.filter(e => e.event === 'registration_attempt');
  const byIp = new Map();
  for (const e of regs) {
    const ip = e.ip || 'unknown';
    if (!byIp.has(ip)) byIp.set(ip, []);
    byIp.get(ip).push(e._ts);
  }

  const alerts = [];
  const WINDOW = 10 * 60 * 1000;
  for (const [ip, timestamps] of byIp) {
    timestamps.sort((a, b) => a - b);
    for (let i = 0; i <= timestamps.length - 5; i++) {
      if (timestamps[i + 4] - timestamps[i] <= WINDOW) {
        alerts.push({
          type: 'registration_spike',
          ip,
          count: timestamps.length,
          window_start: new Date(timestamps[i]).toISOString(),
          window_end: new Date(timestamps[i + 4]).toISOString(),
        });
        break;
      }
    }
  }
  return alerts;
}

// ---------------------------------------------------------------------------
// Detection: wallet anomalies
// ---------------------------------------------------------------------------

function detectWalletAnomalies(ledgerEntries, securityEvents) {
  const alerts = [];

  // Large withdrawals from ledger
  for (const e of ledgerEntries) {
    if (e.type === 'withdrawal' && (e.amount_sats || 0) > 100_000) {
      alerts.push({
        type: 'large_withdrawal',
        agent_id: e.agent_id || 'unknown',
        amount_sats: e.amount_sats,
        time: new Date(e.recorded_at || e._ts).toISOString(),
      });
    }
  }

  // More withdrawals than deposits per agent (from ledger)
  const balances = new Map();
  for (const e of ledgerEntries) {
    const id = e.agent_id;
    if (!id) continue;
    if (!balances.has(id)) balances.set(id, { deposited: 0, withdrawn: 0 });
    const b = balances.get(id);
    if (e.type === 'deposit' || e.type === 'credit') b.deposited += (e.amount_sats || 0);
    if (e.type === 'withdrawal') b.withdrawn += (e.amount_sats || 0);
  }
  for (const [agentId, b] of balances) {
    if (b.withdrawn > b.deposited && b.withdrawn > 0) {
      alerts.push({
        type: 'withdrawal_exceeds_deposits',
        agent_id: agentId,
        deposited: b.deposited,
        withdrawn: b.withdrawn,
        deficit: b.withdrawn - b.deposited,
      });
    }
  }

  // Large wallet ops from security log
  const walletOps = securityEvents.filter(e => e.event === 'wallet_operation');
  for (const e of walletOps) {
    if (e.operation === 'withdrawal' && (e.amount_sats || 0) > 100_000) {
      alerts.push({
        type: 'large_withdrawal_security_log',
        agent_id: e.agent_id || 'unknown',
        amount_sats: e.amount_sats,
        success: e.success,
        time: new Date(e._ts).toISOString(),
      });
    }
  }

  return alerts;
}

// ---------------------------------------------------------------------------
// Detection: rate limit abuse
// ---------------------------------------------------------------------------

function detectRateLimitAbuse(events) {
  const hits = events.filter(e => e.event === 'rate_limit_hit');
  // Group by IP + agent_id combo
  const byKey = new Map();
  for (const e of hits) {
    const key = `${e.ip || 'no-ip'}::${e.agent_id || 'no-agent'}`;
    if (!byKey.has(key)) byKey.set(key, { count: 0, categories: new Set(), timestamps: [] });
    const g = byKey.get(key);
    g.count++;
    if (e.category) g.categories.add(e.category);
    g.timestamps.push(e._ts);
  }

  const alerts = [];
  for (const [key, g] of byKey) {
    if (g.count >= 3) {
      const [ip, agentId] = key.split('::');
      alerts.push({
        type: 'rate_limit_abuse',
        ip: ip === 'no-ip' ? null : ip,
        agent_id: agentId === 'no-agent' ? null : agentId,
        hit_count: g.count,
        categories: [...g.categories],
        first: new Date(Math.min(...g.timestamps)).toISOString(),
        last: new Date(Math.max(...g.timestamps)).toISOString(),
      });
    }
  }
  return alerts;
}

// ---------------------------------------------------------------------------
// Detection: audit chain integrity
// ---------------------------------------------------------------------------

function checkChainIntegrity(chainEntries) {
  const alerts = [];
  for (let i = 1; i < chainEntries.length; i++) {
    const prev = chainEntries[i - 1];
    const curr = chainEntries[i];
    if (curr.prev_hash && prev.hash && curr.prev_hash !== prev.hash) {
      alerts.push({
        type: 'chain_break',
        index: i,
        expected_prev_hash: prev.hash,
        actual_prev_hash: curr.prev_hash,
        time: new Date(curr._ts).toISOString(),
      });
    }
  }
  return alerts;
}

// ---------------------------------------------------------------------------
// Summary stats
// ---------------------------------------------------------------------------

function computeSummary(securityEvents, ledgerEntries, chainEntries) {
  // Events by type
  const eventCounts = {};
  for (const e of securityEvents) {
    eventCounts[e.event] = (eventCounts[e.event] || 0) + 1;
  }

  // Most active agents
  const agentHits = new Map();
  for (const e of securityEvents) {
    if (e.agent_id) {
      agentHits.set(e.agent_id, (agentHits.get(e.agent_id) || 0) + 1);
    }
  }
  const topAgents = [...agentHits.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([id, count]) => ({ agent_id: id, requests: count }));

  // Most hit endpoints
  const endpointHits = new Map();
  for (const e of securityEvents) {
    if (e.event === 'api_request' && e.path) {
      endpointHits.set(e.path, (endpointHits.get(e.path) || 0) + 1);
    }
  }
  const topEndpoints = [...endpointHits.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([path, count]) => ({ path, hits: count }));

  // Time range
  const allTs = securityEvents.map(e => e._ts).filter(Boolean);
  const minTs = allTs.length ? Math.min(...allTs) : null;
  const maxTs = allTs.length ? Math.max(...allTs) : null;

  return {
    security_events_total: securityEvents.length,
    events_by_type: eventCounts,
    ledger_entries_total: ledgerEntries.length,
    chain_entries_total: chainEntries.length,
    top_agents: topAgents,
    top_endpoints: topEndpoints,
    time_range: {
      from: minTs ? new Date(minTs).toISOString() : null,
      to: maxTs ? new Date(maxTs).toISOString() : null,
    },
  };
}

// ---------------------------------------------------------------------------
// Text report formatter
// ---------------------------------------------------------------------------

function formatReport(report) {
  const lines = [];
  const hr = '='.repeat(60);

  lines.push(hr);
  lines.push('  AUDITOR REPORT');
  lines.push(`  Generated: ${report.generated_at}`);
  lines.push(`  Window:    last ${report.since_hours} hours`);
  lines.push(hr);

  // Summary
  lines.push('');
  lines.push('SUMMARY');
  lines.push('-'.repeat(40));
  const s = report.summary;
  lines.push(`  Security events: ${s.security_events_total}`);
  lines.push(`  Ledger entries:  ${s.ledger_entries_total}`);
  lines.push(`  Chain entries:   ${s.chain_entries_total}`);
  if (s.time_range.from) {
    lines.push(`  Time range:      ${s.time_range.from} to ${s.time_range.to}`);
  }

  lines.push('');
  lines.push('  Events by type:');
  for (const [type, count] of Object.entries(s.events_by_type)) {
    lines.push(`    ${type}: ${count}`);
  }

  if (s.top_endpoints.length) {
    lines.push('');
    lines.push('  Top endpoints:');
    for (const ep of s.top_endpoints) {
      lines.push(`    ${ep.hits.toString().padStart(4)}  ${ep.path}`);
    }
  }

  if (s.top_agents.length) {
    lines.push('');
    lines.push('  Most active agents:');
    for (const a of s.top_agents) {
      lines.push(`    ${a.requests.toString().padStart(4)}  ${a.agent_id}`);
    }
  }

  // Anomalies
  lines.push('');
  lines.push('ANOMALIES');
  lines.push('-'.repeat(40));

  const anomalies = report.anomalies;
  const total = anomalies.auth_brute_force.length
    + anomalies.stuck_agents.length
    + anomalies.registration_spikes.length
    + anomalies.wallet_anomalies.length
    + anomalies.rate_limit_abuse.length
    + anomalies.chain_integrity.length;

  if (total === 0) {
    lines.push('  No anomalies detected.');
  } else {
    lines.push(`  ${total} anomaly(ies) detected.`);

    if (anomalies.auth_brute_force.length) {
      lines.push('');
      lines.push(`  AUTH BRUTE FORCE (${anomalies.auth_brute_force.length}):`);
      for (const a of anomalies.auth_brute_force) {
        lines.push(`    IP ${a.ip}: ${a.count} failures (${a.window_start} - ${a.window_end})`);
      }
    }

    if (anomalies.stuck_agents.length) {
      lines.push('');
      lines.push(`  STUCK AGENTS (${anomalies.stuck_agents.length}):`);
      for (const a of anomalies.stuck_agents) {
        lines.push(`    Agent ${a.agent_id} hit ${a.path} ${a.hits}x (${a.window_start} - ${a.window_end})`);
      }
    }

    if (anomalies.registration_spikes.length) {
      lines.push('');
      lines.push(`  REGISTRATION SPIKES (${anomalies.registration_spikes.length}):`);
      for (const a of anomalies.registration_spikes) {
        lines.push(`    IP ${a.ip}: ${a.count} attempts (${a.window_start} - ${a.window_end})`);
      }
    }

    if (anomalies.wallet_anomalies.length) {
      lines.push('');
      lines.push(`  WALLET ANOMALIES (${anomalies.wallet_anomalies.length}):`);
      for (const a of anomalies.wallet_anomalies) {
        if (a.type === 'large_withdrawal' || a.type === 'large_withdrawal_security_log') {
          lines.push(`    Large withdrawal: agent ${a.agent_id}, ${a.amount_sats} sats at ${a.time}`);
        } else if (a.type === 'withdrawal_exceeds_deposits') {
          lines.push(`    Agent ${a.agent_id}: withdrew ${a.withdrawn} sats but deposited ${a.deposited} (deficit: ${a.deficit})`);
        }
      }
    }

    if (anomalies.rate_limit_abuse.length) {
      lines.push('');
      lines.push(`  RATE LIMIT ABUSE (${anomalies.rate_limit_abuse.length}):`);
      for (const a of anomalies.rate_limit_abuse) {
        const who = a.agent_id || a.ip || 'unknown';
        lines.push(`    ${who}: ${a.hit_count} hits on [${a.categories.join(', ')}] (${a.first} - ${a.last})`);
      }
    }

    if (anomalies.chain_integrity.length) {
      lines.push('');
      lines.push(`  CHAIN INTEGRITY (${anomalies.chain_integrity.length}):`);
      for (const a of anomalies.chain_integrity) {
        lines.push(`    Break at index ${a.index} at ${a.time}`);
      }
    }
  }

  lines.push('');
  lines.push(hr);
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const { sinceHours } = parseArgs();
  const sinceTs = Date.now() - sinceHours * 60 * 60 * 1000;

  // Read all data sources
  const [securityEvents, ledgerEntries, chainEntries] = await Promise.all([
    readJSONL(SECURITY_LOG, sinceTs),
    readJSONL(WALLET_LEDGER, sinceTs),
    readJSONL(AUDIT_CHAIN, sinceTs),
  ]);

  // Run detections
  const anomalies = {
    auth_brute_force: detectAuthBruteForce(securityEvents),
    stuck_agents: detectStuckAgents(securityEvents),
    registration_spikes: detectRegistrationSpikes(securityEvents),
    wallet_anomalies: detectWalletAnomalies(ledgerEntries, securityEvents),
    rate_limit_abuse: detectRateLimitAbuse(securityEvents),
    chain_integrity: checkChainIntegrity(chainEntries),
  };

  const summary = computeSummary(securityEvents, ledgerEntries, chainEntries);

  const report = {
    generated_at: new Date().toISOString(),
    since_hours: sinceHours,
    since_ts: sinceTs,
    summary,
    anomalies,
  };

  // Print text report to stdout
  console.log(formatReport(report));

  // Write JSON report
  await mkdir(REPORTS_DIR, { recursive: true });
  const filename = `audit-${Date.now()}.json`;
  const reportPath = resolve(REPORTS_DIR, filename);
  await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n', 'utf-8');
  console.log(`JSON report written to: ${reportPath}`);
}

main().catch(err => {
  console.error('Auditor failed:', err.message);
  process.exit(1);
});
