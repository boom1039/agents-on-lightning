#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import http from 'node:http';
import https from 'node:https';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const DEFAULT_DASHBOARD_URL = 'http://127.0.0.1:3308';
const DEFAULT_RESULTS_FILE = 'test/walkthrough/stress-test-results.jsonl';

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const item = argv[i];
    if (!item.startsWith('--')) continue;
    const key = item.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith('--')) {
      args[key] = true;
      continue;
    }
    args[key] = next;
    i += 1;
  }
  return args;
}

function toInt(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

async function postEvents(baseUrl, events) {
  const target = new URL(`${baseUrl}/api/live-events`);
  const transport = target.protocol === 'https:' ? https : http;
  const body = JSON.stringify({ events });

  await new Promise((resolvePost, rejectPost) => {
    const req = transport.request({
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port,
      path: target.pathname,
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(body),
      },
    }, (res) => {
      res.resume();
      if (res.statusCode >= 200 && res.statusCode < 300) {
        resolvePost();
        return;
      }
      rejectPost(new Error(`dashboard returned ${res.statusCode}`));
    });

    req.setTimeout(1_500, () => req.destroy(new Error('dashboard timeout')));
    req.on('error', rejectPost);
    req.end(body);
  });
}

function normalizeUrl(url = '') {
  try {
    const parsed = new URL(url, 'http://localhost:3302');
    return parsed.pathname;
  } catch {
    return String(url || '').split('?')[0] || '/';
  }
}

function loadRecords(text) {
  return text
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

function pickRecord(records, args) {
  const suite = args.suite ? String(args.suite) : null;
  const phase = args.phase ? String(args.phase) : null;
  const tagged = args.tag ? String(args.tag) : null;

  const matches = records.filter((record) => {
    if (!Array.isArray(record.request_timeline) || record.request_timeline.length === 0) return false;
    if (suite && record.suite !== suite) return false;
    if (phase && record.phase !== phase) return false;
    if (tagged && record.tag !== tagged) return false;
    return true;
  });

  if (matches.length === 0) {
    throw new Error('No walkthrough record with request_timeline matched the requested filters');
  }

  return matches[matches.length - 1];
}

async function replayRecord(baseUrl, record, args) {
  const speed = Math.max(1, toInt(args.speed, 1));
  const agentId = String(args['agent-id'] || `replay-${Date.now().toString(36)}`);
  const timeline = [...record.request_timeline].sort((a, b) => (a.request_timeline_index || 0) - (b.request_timeline_index || 0));

  for (const entry of timeline) {
    const method = String(entry.method || 'GET').toUpperCase();
    const path = normalizeUrl(entry.url || '');
    const gapMs = Number.isFinite(entry.gap_from_prev_request_ms) ? entry.gap_from_prev_request_ms : 0;
    const holdMs = Number.isFinite(entry.latency_ms) ? entry.latency_ms : Math.max(1, (Number(entry.finished_at_ms) || 0) - (Number(entry.started_at_ms) || 0));

    if (gapMs > 0) await delay(Math.max(0, Math.round(gapMs / speed)));

    if (path === '/api/v1/agents/register' && method === 'POST') {
      await postEvents(baseUrl, [{
        event: 'registration_attempt',
        ts: Date.now(),
        agent_id: agentId,
        success: true,
        request_timeline_index: entry.request_timeline_index,
        turn_started_at_ms: entry.turn_started_at_ms,
        turn_finished_at_ms: entry.turn_finished_at_ms,
      }]);
    }

    const traceId = `${agentId}-replay-${entry.request_timeline_index}`;
    const startTs = Date.now();
    await postEvents(baseUrl, [{
      event: 'request_start',
      ts: startTs,
      trace_id: traceId,
      agent_id: agentId,
      method,
      path,
      request_timeline_index: entry.request_timeline_index,
      started_at_ms: entry.started_at_ms,
      finished_at_ms: null,
      latency_ms: entry.latency_ms,
      gap_from_prev_request_ms: entry.gap_from_prev_request_ms,
      gap_from_prev_turn_ms: entry.gap_from_prev_turn_ms,
      turn_started_at_ms: entry.turn_started_at_ms,
      turn_finished_at_ms: entry.turn_finished_at_ms,
    }]);

    if (holdMs > 0) await delay(Math.max(1, Math.round(holdMs / speed)));

    await postEvents(baseUrl, [{
      event: 'request_finish',
      ts: Date.now(),
      trace_id: traceId,
      agent_id: agentId,
      method,
      path,
      status: path === '/api/v1/agents/register' ? 201 : 200,
      duration_ms: holdMs,
      request_timeline_index: entry.request_timeline_index,
      started_at_ms: entry.started_at_ms,
      finished_at_ms: entry.finished_at_ms,
      latency_ms: entry.latency_ms,
      gap_from_prev_request_ms: entry.gap_from_prev_request_ms,
      gap_from_prev_turn_ms: entry.gap_from_prev_turn_ms,
      turn_started_at_ms: entry.turn_started_at_ms,
      turn_finished_at_ms: entry.turn_finished_at_ms,
    }]);
  }

  return agentId;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const filePath = resolve(args.file || DEFAULT_RESULTS_FILE);
  const dashboardUrl = String(args['dashboard-url'] || DEFAULT_DASHBOARD_URL).replace(/\/$/, '');
  const text = await readFile(filePath, 'utf8');
  const record = pickRecord(loadRecords(text), args);
  const agentId = await replayRecord(dashboardUrl, record, args);
  console.log(`replayed ${record.suite || 'walkthrough'}:${record.phase || 'phase'} as ${agentId} on ${dashboardUrl}`);
}

main().catch((error) => {
  console.error(error.message || error);
  process.exitCode = 1;
});
