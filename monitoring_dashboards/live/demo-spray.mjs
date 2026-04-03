import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_RESULTS_FILE = path.resolve(__dirname, '../../test/walkthrough/stress-test-results.jsonl');

function toInt(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function normalizeUrl(url = '') {
  try {
    const parsed = new URL(url, 'http://localhost:3302');
    return parsed.pathname;
  } catch {
    return String(url || '').split('?')[0] || '/';
  }
}

function loadLines(text) {
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

function hasTimeline(record) {
  return Array.isArray(record?.request_timeline) && record.request_timeline.length > 0;
}

export async function loadReplayCatalog(filePath = DEFAULT_RESULTS_FILE) {
  const text = await readFile(filePath, 'utf8');
  return loadLines(text).filter(hasTimeline);
}

export function pickLatestReplayRecord(records, {
  suite,
  phase,
} = {}) {
  const matches = (records || []).filter((record) => {
    if (!hasTimeline(record)) return false;
    if (suite && record.suite !== suite) return false;
    if (phase && record.phase !== phase) return false;
    return true;
  });

  if (matches.length === 0) {
    throw new Error(`No replay record for ${suite || 'suite'}:${phase || 'phase'}`);
  }

  return matches[matches.length - 1];
}

export function buildReplayBatches(record, {
  agentId,
  speed = 1,
  startOffsetMs = 0,
} = {}) {
  const timeline = [...(record?.request_timeline || [])]
    .sort((a, b) => (a.request_timeline_index || 0) - (b.request_timeline_index || 0));
  const safeSpeed = Math.max(1, Number(speed) || 1);
  const batches = [];
  let cursorMs = Math.max(0, toInt(startOffsetMs, 0));

  for (const entry of timeline) {
    const method = String(entry.method || 'GET').toUpperCase();
    const replayPath = normalizeUrl(entry.url || '');
    const gapMs = Number.isFinite(entry.gap_from_prev_request_ms) ? entry.gap_from_prev_request_ms : 0;
    const holdMs = Number.isFinite(entry.latency_ms)
      ? entry.latency_ms
      : Math.max(1, (Number(entry.finished_at_ms) || 0) - (Number(entry.started_at_ms) || 0));
    const delayGap = Math.max(0, Math.round(gapMs / safeSpeed));
    const delayHold = Math.max(1, Math.round(holdMs / safeSpeed));

    cursorMs += delayGap;

    if (replayPath === '/api/v1/agents/register' && method === 'POST') {
      batches.push({
        delayMs: cursorMs,
        events: [{
          event: 'registration_attempt',
          agent_id: agentId,
          success: true,
          request_timeline_index: entry.request_timeline_index,
          turn_started_at_ms: entry.turn_started_at_ms,
          turn_finished_at_ms: entry.turn_finished_at_ms,
        }],
      });
    }

    const traceId = `${agentId}-replay-${entry.request_timeline_index}`;
    batches.push({
      delayMs: cursorMs,
      events: [{
        event: 'request_start',
        trace_id: traceId,
        agent_id: agentId,
        method,
        path: replayPath,
        request_timeline_index: entry.request_timeline_index,
        started_at_ms: entry.started_at_ms,
        finished_at_ms: null,
        latency_ms: entry.latency_ms,
        gap_from_prev_request_ms: entry.gap_from_prev_request_ms,
        gap_from_prev_turn_ms: entry.gap_from_prev_turn_ms,
        turn_started_at_ms: entry.turn_started_at_ms,
        turn_finished_at_ms: entry.turn_finished_at_ms,
      }],
    });

    cursorMs += delayHold;

    batches.push({
      delayMs: cursorMs,
      events: [{
        event: 'request_finish',
        trace_id: traceId,
        agent_id: agentId,
        method,
        path: replayPath,
        status: replayPath === '/api/v1/agents/register' ? 201 : 200,
        duration_ms: holdMs,
        request_timeline_index: entry.request_timeline_index,
        started_at_ms: entry.started_at_ms,
        finished_at_ms: entry.finished_at_ms,
        latency_ms: entry.latency_ms,
        gap_from_prev_request_ms: entry.gap_from_prev_request_ms,
        gap_from_prev_turn_ms: entry.gap_from_prev_turn_ms,
        turn_started_at_ms: entry.turn_started_at_ms,
        turn_finished_at_ms: entry.turn_finished_at_ms,
      }],
    });
  }

  return {
    agentId,
    durationMs: cursorMs,
    batches,
  };
}

export function buildDefaultDemoSpray(records, options = {}) {
  const defaults = [
    { suite: 'discovery', phase: 'skills', copies: 2, speed: 3.6, spacingMs: 190, laneOffsetMs: 0, prefix: 'demo-discovery' },
    { suite: 'identity', phase: 'registration-and-profile', copies: 4, speed: 4.4, spacingMs: 260, laneOffsetMs: 120, prefix: 'demo-profile' },
    { suite: 'identity', phase: 'node-connection', copies: 3, speed: 4.0, spacingMs: 260, laneOffsetMs: 380, prefix: 'demo-node' },
    { suite: 'identity', phase: 'actions', copies: 4, speed: 4.2, spacingMs: 260, laneOffsetMs: 620, prefix: 'demo-actions' },
  ];

  const plan = [];
  let counter = 1;
  for (const item of defaults) {
    const record = pickLatestReplayRecord(records, item);
    for (let copy = 0; copy < item.copies; copy += 1) {
      const agentId = `${item.prefix}-${String(counter).padStart(2, '0')}`;
      counter += 1;
      plan.push(buildReplayBatches(record, {
        agentId,
        speed: item.speed,
        startOffsetMs: item.laneOffsetMs + (copy * item.spacingMs),
      }));
    }
  }

  const totalDurationMs = plan.reduce((max, entry) => Math.max(max, entry.durationMs), 0);
  return {
    name: options.name || 'big-spray',
    agents: plan.length,
    totalDurationMs,
    runs: plan,
  };
}

export function stampBatchEvents(events = [], baseTs = Date.now()) {
  return events.map((event, index) => ({
    ...event,
    ts: baseTs + index,
  }));
}
