/**
 * Security audit logger.
 * Journey events go straight into DuckDB.
 *
 * Events: rate_limit_hit, auth_failure, validation_failure,
 *         wallet_operation, registration_attempt
 */

import { getJourneyMonitorStatus, recordJourneyEvent } from '../monitor/journey-monitor.js';
import { resolveTrackedSurface, shouldIgnoreAgentSurfacePath } from '../monitor/agent-surface-inventory.js';
let _traceSeq = 0;

function nextTraceId() {
  _traceSeq = (_traceSeq + 1) % 0xFFFFFF;
  return `trace-${Date.now().toString(36)}-${_traceSeq.toString(36)}`;
}

export function getAuditLogStatus() {
  const journeyStatus = getJourneyMonitorStatus();
  return {
    path: journeyStatus.path,
    backend: 'duckdb',
    totalEvents: journeyStatus.totalEvents,
    uniqueAgents: journeyStatus.uniqueAgents,
    hydratedAt: journeyStatus.hydratedAt,
    lastSizeBytes: journeyStatus.lastSizeBytes,
    sizeBytes: journeyStatus.sizeBytes,
    level: journeyStatus.level || 'offline',
    lastRunAt: 0,
    lastPrunedAt: 0,
    warnActive: false,
    lastWarningAt: 0,
    lastPruneStats: null,
  };
}

async function _append(event) {
  try {
    await recordJourneyEvent({ ...event, _ts: Date.now() });
  } catch {
    // Audit logging is best-effort — never crash the server
  }
}

const DASHBOARD_RESULT_META_KEYS = new Set([
  'failure_code',
  'failure_stage',
  'failure_reason',
  'cooldown_retry_after_ms',
  'cooldown_retry_at_ms',
  'cooldown_scope',
]);

function sanitizeDashboardResultMeta(input = {}) {
  const clean = {};
  for (const [key, value] of Object.entries(input || {})) {
    if (!DASHBOARD_RESULT_META_KEYS.has(key)) continue;
    if (typeof value === 'string') {
      const trimmed = value.trim();
      if (trimmed) clean[key] = trimmed.slice(0, 280);
      continue;
    }
    if (Number.isFinite(value)) {
      clean[key] = value;
      continue;
    }
    if (value === null) {
      clean[key] = null;
    }
  }
  return clean;
}

export function logRateLimitHit(category, ip, agentId, routePath = null, method = null) {
  return _append({
    event: 'rate_limit_hit',
    category,
    ip: ip || null,
    agent_id: agentId || null,
    path: routePath || null,
    method: method ? String(method).toUpperCase() : null,
  });
}

export function logAuthFailure(ip, hadBearerToken, routePath = null, method = null) {
  return _append({
    event: 'auth_failure',
    ip: ip || null,
    had_bearer_token: Boolean(hadBearerToken),
    path: routePath || null,
    method: method ? String(method).toUpperCase() : null,
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

export function logRegistrationAttempt(ip, success, agentId, agentName = null) {
  return _append({
    event: 'registration_attempt',
    ip: ip || null,
    success,
    agent_id: agentId || null,
    agent_name: agentName || null,
  });
}

/**
 * Express middleware that logs all /api/v1/ requests to the audit log.
 */
export function classifyDocKind(path, accept = '') {
  if (path === '/llms.txt') {
    return 'root';
  }
  if (path === '/api/v1/skills') {
    return 'skill-index';
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
  const tracked =
    (originalPath.startsWith('/api/v1/') && !shouldIgnoreAgentSurfacePath(originalPath))
    || originalPath.startsWith('/docs/')
    || originalPath === '/llms.txt'
    || originalPath === '/health'
    || originalPath === '/'
    || originalPath === '/mcp'
    || originalPath.startsWith('/.well-known/');

  return {
    accept,
    originalPath,
    tracked,
    doc_kind: classifyDocKind(originalPath, accept),
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
  const trackedSurface = resolveTrackedSurface({
    method: req.method,
    path: originalPath,
    doc_kind,
  });
  const surfaceMeta = trackedSurface ? {
    surface_key: trackedSurface.key,
    surface_type: trackedSurface.kind,
    doc_id: trackedSurface.kind === 'doc' ? trackedSurface.entry.doc_id : null,
    domain: trackedSurface.entry.domain || null,
  } : {};
  req.dashboardTraceId = traceId;
  req.dashboardResultMeta = {};
  req.dashboardSetResultMeta = (meta = {}) => {
    Object.assign(req.dashboardResultMeta, sanitizeDashboardResultMeta(meta));
  };
  req.dashboardBindAgent = (agentId, agentName = null) => {
    if (!agentId) return;
    void recordJourneyEvent({
      event: 'agent_bound',
      trace_id: traceId,
      agent_id: agentId,
      agent_name: agentName || null,
      method: req.method,
      path: originalPath,
      ...surfaceMeta,
      ts: Date.now(),
    });
  };

  void recordJourneyEvent({
    event: 'request_start',
    trace_id: traceId,
    method: req.method,
    path: originalPath,
    agent_id: req.agentId || null,
    agent_name: req.agentProfile?.name || null,
    ip: req.socket?.remoteAddress || req.connection?.remoteAddress || null,
    accept: accept || null,
    doc_kind,
    ...surfaceMeta,
    ts: start,
  });

  res.once('finish', () => {
    void recordJourneyEvent({
      event: 'request_finish',
      trace_id: traceId,
      method: req.method,
      path: originalPath,
      status: res.statusCode,
      duration_ms: Date.now() - start,
      ip: req.socket?.remoteAddress || req.connection?.remoteAddress || null,
      agent_id: req.agentId || null,
      agent_name: req.agentProfile?.name || null,
      accept: accept || null,
      doc_kind,
      ...req.dashboardResultMeta,
      ...surfaceMeta,
      ts: Date.now(),
    });
    void _append({
      event: 'api_request',
      method: req.method,
      path: originalPath,
      status: res.statusCode,
      duration_ms: Date.now() - start,
      ip: req.socket?.remoteAddress || req.connection?.remoteAddress || null,
      agent_id: req.agentId || null,
      agent_name: req.agentProfile?.name || null,
      accept: accept || null,
      doc_kind,
      ...surfaceMeta,
    });
  });

  next();
}
