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

export function logAuthFailure(ip, tokenPrefix) {
  return _append({
    event: 'auth_failure',
    ip: ip || null,
    token_prefix: tokenPrefix || null,
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
export function auditMiddleware(req, _res, next) {
  if (req.path.startsWith('/api/v1/')) {
    _append({
      event: 'api_request',
      method: req.method,
      path: req.path,
      ip: req.ip || null,
      agent_id: req.agentId || null,
    });
  }
  next();
}
