/**
 * Authentication middleware for internal MCP-to-API calls.
 *
 * External agents do not receive reusable shared-secret credentials. Private MCP tools verify a
 * secp256k1-signed agent_auth payload, then forward a loopback-only internal
 * assertion to these API routes.
 */

import {
  INTERNAL_AUTH_AUDIENCE_HEADER,
  INTERNAL_AUTH_PAYLOAD_HASH_HEADER,
  INTERNAL_VERIFIED_AGENT_ID_HEADER,
  verifySecp256k1DerSignature,
} from './signed-auth.js';
import { err401NoAuth, err401BadFormat, err401BadKey } from './agent-friendly-errors.js';
import { logAuthFailure } from './audit-log.js';
import {
  getSocketAddress,
  hasValidInternalMcpSecret,
  isLoopbackRequest,
} from './request-security.js';
import { validateAgentId } from './validators.js';

// In-memory rate limit tracking: IP -> { count, windowStart }
const _rateLimits = new Map();
const RATE_LIMIT_WINDOW_MS = 3600_000; // 1 hour
const RATE_LIMIT_MAX = 10; // 10 registrations per IP per hour

/**
 * Check IP-based rate limit for registration.
 * Returns { allowed: boolean, remaining: number, resetAt: number }
 */
export function checkRateLimit(ip) {
  const now = Date.now();
  const entry = _rateLimits.get(ip);

  if (!entry || now - entry.windowStart > RATE_LIMIT_WINDOW_MS) {
    _rateLimits.set(ip, { count: 1, windowStart: now });
    return { allowed: true, remaining: RATE_LIMIT_MAX - 1, resetAt: now + RATE_LIMIT_WINDOW_MS };
  }

  if (entry.count >= RATE_LIMIT_MAX) {
    return { allowed: false, remaining: 0, resetAt: entry.windowStart + RATE_LIMIT_WINDOW_MS };
  }

  entry.count++;
  return { allowed: true, remaining: RATE_LIMIT_MAX - entry.count, resetAt: entry.windowStart + RATE_LIMIT_WINDOW_MS };
}

function readInternalAgentAssertion(req) {
  const agentId = req.get(INTERNAL_VERIFIED_AGENT_ID_HEADER);
  const authPayloadHash = req.get(INTERNAL_AUTH_PAYLOAD_HASH_HEADER);
  const audience = req.get(INTERNAL_AUTH_AUDIENCE_HEADER);
  if (!agentId || !authPayloadHash || !audience) {
    return { ok: false, code: 'missing_signed_agent_assertion' };
  }
  const idCheck = validateAgentId(agentId);
  if (!idCheck.valid) return { ok: false, code: 'invalid_agent_id', message: idCheck.reason };
  if (!/^[0-9a-f]{64}$/i.test(authPayloadHash)) {
    return { ok: false, code: 'invalid_auth_payload_hash' };
  }
  return { ok: true, agentId, authPayloadHash, audience };
}

/**
 * Express middleware: accept only loopback MCP requests carrying a verified
 * signed-agent assertion. Sets req.agentId and req.agentProfile on success.
 */
export function requireAuth(registry, {
  internalMcpSecret = process.env.AOL_INTERNAL_MCP_SECRET,
} = {}) {
  return async (req, res, next) => {
    const socketIp = getSocketAddress(req) || null;
    const path = req.path || req.originalUrl || null;
    const hadAuthHeader = typeof req.headers.authorization === 'string' && req.headers.authorization.length > 0;

    if (!isLoopbackRequest(req) || !hasValidInternalMcpSecret(req, internalMcpSecret)) {
      logAuthFailure(socketIp, hadAuthHeader, path, req.method || null);
      return err401NoAuth(res);
    }

    const assertion = readInternalAgentAssertion(req);
    if (!assertion.ok) {
      logAuthFailure(socketIp, hadAuthHeader, path, req.method || null);
      return err401BadFormat(res, {
        hint: 'Private API routes require a signed AOL MCP tool call. Use the matching named MCP tool with agent_auth.',
      });
    }

    const agent = registry.getById(assertion.agentId);
    if (!agent) {
      logAuthFailure(socketIp, hadAuthHeader, path, req.method || null);
      return err401BadKey(res, {
        hint: 'The signed agent_auth payload references an unknown agent_id. Register first, then sign with that agent public key.',
      });
    }

    req.agentId = agent.id;
    req.agentProfile = agent;
    req.agentAuthPayloadHash = assertion.authPayloadHash;
    req.agentAuthAudience = assertion.audience;
    req.dashboardBindAgent?.(agent.id, agent.name || null);
    return next();
  };
}

/**
 * Express middleware: optional internal MCP assertion.
 */
export function optionalAuth(registry, options = {}) {
  const strict = requireAuth(registry, options);
  return async (req, res, next) => {
    if (
      isLoopbackRequest(req)
      && hasValidInternalMcpSecret(req, options.internalMcpSecret || process.env.AOL_INTERNAL_MCP_SECRET)
      && req.get(INTERNAL_VERIFIED_AGENT_ID_HEADER)
    ) {
      return strict(req, res, next);
    }
    req.agentId = null;
    req.agentProfile = null;
    return next();
  };
}

/**
 * Verify a secp256k1 ECDSA signature over SHA256(message).
 * Public key must be compressed hex. Signature must be strict DER hex.
 */
export async function verifySecp256k1Signature(publicKeyHex, message, signatureHex) {
  const result = await verifySecp256k1DerSignature(publicKeyHex, message, signatureHex);
  return Boolean(result.ok);
}
