/**
 * Security audit logger.
 * Append-only JSONL at data/security-audit.jsonl.
 *
 * Events: rate_limit_hit, auth_failure, validation_failure,
 *         wallet_operation, registration_attempt
 */

import { appendFile, mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { statSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { getProjectRoot } from '../config.js';
import { publishDashboardEvent } from '../../monitoring_dashboards/live/publisher.mjs';

const LOG_PATH = resolve(getProjectRoot(), 'data', 'security-audit.jsonl');
const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_RETENTION_DAYS = 7;
const DEFAULT_MAX_BYTES = 100 * 1024 * 1024;
const DEFAULT_WARN_RATIO = 0.8;
const DEFAULT_PRUNE_INTERVAL_MS = 5 * 60 * 1000;

let _initialized = false;
let _fileQueue = Promise.resolve();
let _traceSeq = 0;
const _logHealth = {
  lastRunAt: 0,
  lastPrunedAt: 0,
  lastSizeBytes: 0,
  warnActive: false,
  lastWarningAt: 0,
  lastPruneStats: null,
};

function parsePositiveInt(value, fallback) {
  const parsed = Number.parseInt(`${value ?? ''}`, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function formatMb(bytes) {
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}

function nextTraceId() {
  _traceSeq = (_traceSeq + 1) % 0xFFFFFF;
  return `trace-${Date.now().toString(36)}-${_traceSeq.toString(36)}`;
}

export function getAuditLogPolicy(env = process.env) {
  const retentionDays = parsePositiveInt(env.AOL_AUDIT_LOG_RETENTION_DAYS, DEFAULT_RETENTION_DAYS);
  const maxBytes = parsePositiveInt(env.AOL_AUDIT_LOG_MAX_BYTES, DEFAULT_MAX_BYTES);
  const warnBytes = Math.min(
    maxBytes,
    parsePositiveInt(env.AOL_AUDIT_LOG_WARN_BYTES, Math.floor(maxBytes * DEFAULT_WARN_RATIO)),
  );
  const pruneIntervalMs = parsePositiveInt(env.AOL_AUDIT_LOG_PRUNE_INTERVAL_MS, DEFAULT_PRUNE_INTERVAL_MS);
  return {
    retentionDays,
    retentionMs: retentionDays * DAY_MS,
    maxBytes,
    warnBytes,
    pruneIntervalMs,
  };
}

export function pruneAuditLogText(text, {
  now = Date.now(),
  retentionMs = DEFAULT_RETENTION_DAYS * DAY_MS,
  maxBytes = DEFAULT_MAX_BYTES,
} = {}) {
  const cutoff = now - retentionMs;
  const rows = [];
  const originalLines = text ? text.split('\n').filter(Boolean) : [];
  let droppedExpired = 0;
  let droppedInvalid = 0;

  for (const line of originalLines) {
    try {
      const event = JSON.parse(line);
      const ts = Number.isFinite(event?._ts) ? event._ts : null;
      if (ts !== null && ts < cutoff) {
        droppedExpired += 1;
        continue;
      }
      rows.push({ line, bytes: Buffer.byteLength(`${line}\n`) });
    } catch {
      droppedInvalid += 1;
    }
  }

  let totalBytes = rows.reduce((sum, row) => sum + row.bytes, 0);
  let droppedForSize = 0;
  while (totalBytes > maxBytes && rows.length > 0) {
    const removed = rows.shift();
    totalBytes -= removed.bytes;
    droppedForSize += 1;
  }

  const nextText = rows.length > 0 ? `${rows.map(row => row.line).join('\n')}\n` : '';
  return {
    text: nextText,
    keptLines: rows.length,
    keptBytes: totalBytes,
    droppedExpired,
    droppedInvalid,
    droppedForSize,
    changed: droppedExpired > 0 || droppedInvalid > 0 || droppedForSize > 0,
  };
}

export function getAuditLogStatus(env = process.env) {
  const policy = getAuditLogPolicy(env);
  let sizeBytes = _logHealth.lastSizeBytes;
  if (sizeBytes === 0) {
    try {
      sizeBytes = statSync(LOG_PATH).size;
    } catch {}
  }
  return {
    path: LOG_PATH,
    ...policy,
    ..._logHealth,
    lastSizeBytes: sizeBytes,
    level: sizeBytes >= policy.maxBytes
      ? 'cap'
      : sizeBytes >= policy.warnBytes
        ? 'warn'
        : 'ok',
  };
}

async function _ensureDir() {
  if (_initialized) return;
  await mkdir(dirname(LOG_PATH), { recursive: true });
  _initialized = true;
}

function _enqueueFileTask(task) {
  _fileQueue = _fileQueue
    .catch(() => {})
    .then(task);
  return _fileQueue;
}

function _setWarnState(sizeBytes, policy) {
  _logHealth.lastSizeBytes = sizeBytes;
  if (sizeBytes < policy.warnBytes) {
    _logHealth.warnActive = false;
    return;
  }
  if (_logHealth.warnActive) return;
  _logHealth.warnActive = true;
  _logHealth.lastWarningAt = Date.now();
  console.warn(
    `[audit-log] ${LOG_PATH} is ${formatMb(sizeBytes)}. Warning threshold ${formatMb(policy.warnBytes)}, cap ${formatMb(policy.maxBytes)}.`,
  );
}

async function _runHousekeeping(now = Date.now(), env = process.env, { force = false } = {}) {
  const policy = getAuditLogPolicy(env);
  if (!force && (now - _logHealth.lastRunAt) < policy.pruneIntervalMs) return;
  _logHealth.lastRunAt = now;

  let currentStat;
  try {
    currentStat = await stat(LOG_PATH);
  } catch (err) {
    if (err.code === 'ENOENT') {
      _logHealth.lastSizeBytes = 0;
      _logHealth.warnActive = false;
      return;
    }
    throw err;
  }

  _setWarnState(currentStat.size, policy);

  const pruneResult = await pruneAuditLogFile({
    now,
    retentionMs: policy.retentionMs,
    maxBytes: policy.maxBytes,
  });

  if (pruneResult) {
    _logHealth.lastPrunedAt = now;
    _logHealth.lastPruneStats = pruneResult;
    _setWarnState(pruneResult.keptBytes, policy);
  }
}

async function pruneAuditLogFile({
  now = Date.now(),
  retentionMs,
  maxBytes,
} = {}) {
  let raw = '';
  try {
    raw = await readFile(LOG_PATH, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }

  const result = pruneAuditLogText(raw, { now, retentionMs, maxBytes });
  if (!result.changed) {
    _logHealth.lastSizeBytes = Buffer.byteLength(raw);
    return null;
  }

  const tmpPath = `${LOG_PATH}.tmp`;
  await writeFile(tmpPath, result.text, 'utf8');
  await rename(tmpPath, LOG_PATH);
  _logHealth.lastSizeBytes = result.keptBytes;
  return result;
}

async function _append(event) {
  try {
    await _enqueueFileTask(async () => {
      await _ensureDir();
      const line = JSON.stringify({ ...event, _ts: Date.now() }) + '\n';
      await appendFile(LOG_PATH, line, 'utf8');
      _logHealth.lastSizeBytes += Buffer.byteLength(line);
      const policy = getAuditLogPolicy();
      await _runHousekeeping(Date.now(), process.env, {
        force: _logHealth.lastSizeBytes >= policy.warnBytes,
      });
    });
  } catch {
    // Audit logging is best-effort — never crash the server
  }
}

export function logRateLimitHit(category, ip, agentId) {
  return _append({
    event: 'rate_limit_hit',
    category,
    ip: ip || null,
    agent_id: agentId || null,
  });
}

export function logAuthFailure(ip, hadBearerToken) {
  return _append({
    event: 'auth_failure',
    ip: ip || null,
    had_bearer_token: Boolean(hadBearerToken),
  });
}

export function logAuthorizationDenied(route, agentId, resourceId, ip) {
  return _append({
    event: 'authz_denied',
    route,
    agent_id: agentId || null,
    resource_id: resourceId || null,
    ip: ip || null,
  });
}

export function logValidationFailure(endpoint, field, valueSnippet) {
  return _append({
    event: 'validation_failure',
    endpoint,
    field,
    value_snippet: typeof valueSnippet === 'string' ? valueSnippet.slice(0, 50) : null,
  });
}

export function logWalletOperation(agentId, operation, amountSats, success) {
  return _append({
    event: 'wallet_operation',
    agent_id: agentId,
    operation,
    amount_sats: amountSats,
    success,
  });
}

export function logRegistrationAttempt(ip, success, agentId) {
  publishDashboardEvent({
    event: 'registration_attempt',
    ip: ip || null,
    success,
    agent_id: agentId || null,
  });
  return _append({
    event: 'registration_attempt',
    ip: ip || null,
    success,
    agent_id: agentId || null,
  });
}

/**
 * Express middleware that logs all /api/v1/ requests to the audit log.
 */
export function classifyDocKind(path, accept = '') {
  if (path === '/' && (accept.includes('text/markdown') || accept.includes('text/plain'))) {
    return 'root-markdown';
  }
  if (path === '/llms.txt' || path === '/docs/llms.txt') {
    return 'root';
  }
  if (path === '/api/v1/skills' || path.startsWith('/api/v1/skills/')) {
    return 'skill-api';
  }
  if (path.startsWith('/docs/skills/')) {
    return 'skill-static';
  }
  if (path.startsWith('/api/v1/knowledge/')) {
    return 'knowledge-api';
  }
  return null;
}

export function getTrackedRequestMeta(req) {
  const accept = req.headers?.accept || '';
  const originalPath = ((req.originalUrl || req.url || req.path || '').split('?')[0]) || req.path || '';
  const isRootDoc = originalPath === '/' && (accept.includes('text/markdown') || accept.includes('text/plain'));
  const tracked =
    originalPath.startsWith('/api/v1/')
    || originalPath.startsWith('/docs/')
    || originalPath === '/llms.txt'
    || originalPath === '/health'
    || originalPath === '/';

  return {
    accept,
    originalPath,
    isRootDoc,
    tracked,
    doc_kind: isRootDoc ? 'root-markdown' : classifyDocKind(originalPath, accept),
  };
}

export function auditMiddleware(req, res, next) {
  const {
    accept,
    originalPath,
    tracked,
    doc_kind,
  } = getTrackedRequestMeta(req);

  if (!tracked) return next();

  const start = Date.now();
  const traceId = nextTraceId();
  req.dashboardTraceId = traceId;
  req.dashboardBindAgent = (agentId) => {
    if (!agentId) return;
    publishDashboardEvent({
      event: 'agent_bound',
      trace_id: traceId,
      agent_id: agentId,
      method: req.method,
      path: originalPath,
      ts: Date.now(),
    });
  };

  publishDashboardEvent({
    event: 'request_start',
    trace_id: traceId,
    method: req.method,
    path: originalPath,
    agent_id: req.agentId || null,
    ip: req.socket?.remoteAddress || req.connection?.remoteAddress || null,
    accept: accept || null,
    doc_kind,
    ts: start,
  });

  res.once('finish', () => {
    publishDashboardEvent({
      event: 'request_finish',
      trace_id: traceId,
      method: req.method,
      path: originalPath,
      status: res.statusCode,
      duration_ms: Date.now() - start,
      ip: req.socket?.remoteAddress || req.connection?.remoteAddress || null,
      agent_id: req.agentId || null,
      accept: accept || null,
      doc_kind,
      ts: Date.now(),
    });
    _append({
      event: 'api_request',
      method: req.method,
      path: originalPath,
      status: res.statusCode,
      duration_ms: Date.now() - start,
      ip: req.socket?.remoteAddress || req.connection?.remoteAddress || null,
      agent_id: req.agentId || null,
      accept: accept || null,
      doc_kind,
    });
  });

  next();
}
