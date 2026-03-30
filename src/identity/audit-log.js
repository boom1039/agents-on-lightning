/**
 * Security audit logger.
 * Append-only JSONL at data/security-audit.jsonl.
 *
 * Events: rate_limit_hit, auth_failure, validation_failure,
 *         wallet_operation, registration_attempt
 */

import { open } from 'node:fs/promises';
import { mkdir } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { getProjectRoot } from '../config.js';

const LOG_PATH = resolve(getProjectRoot(), 'data', 'security-audit.jsonl');
let _initialized = false;

async function _ensureDir() {
  if (_initialized) return;
  await mkdir(dirname(LOG_PATH), { recursive: true });
  _initialized = true;
}

async function _append(event) {
  try {
    await _ensureDir();
    const line = JSON.stringify({ ...event, _ts: Date.now() }) + '\n';
    const fh = await open(LOG_PATH, 'a');
    try {
      await fh.write(line);
    } finally {
      await fh.close();
    }
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
  res.once('finish', () => {
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
