/**
 * Authentication middleware for external agent API.
 * Bearer token format: lb-agent-{32-byte-hex}
 * Optional secp256k1 signature verification for signed agent actions.
 */

import { randomBytes } from 'node:crypto';
import {
  createHash, createPublicKey, createVerify, ECDH,
} from 'node:crypto';
import { err401NoAuth, err401BadFormat, err401BadKey } from './agent-friendly-errors.js';
import { logAuthFailure } from './audit-log.js';
import { getSocketAddress } from './request-security.js';

// In-memory rate limit tracking: IP → { count, windowStart }
const _rateLimits = new Map();
const RATE_LIMIT_WINDOW_MS = 3600_000; // 1 hour
const RATE_LIMIT_MAX = 10; // 10 registrations per IP per hour

/**
 * Generate a new API key.
 * Format: lb-agent-{32 random hex bytes} = 67 chars total
 */
export function generateApiKey() {
  return `lb-agent-${randomBytes(32).toString('hex')}`;
}

export function hashApiKey(apiKey) {
  return createHash('sha256').update(String(apiKey)).digest('hex');
}

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

/**
 * Express middleware: extract and validate Bearer token.
 * Sets req.agentId and req.agentApiKey on success.
 * Returns 401 if missing/invalid.
 */
export function requireAuth(registry) {
  return async (req, res, next) => {
    const socketIp = getSocketAddress(req) || null;
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      logAuthFailure(socketIp, false, req.path || req.originalUrl || null, req.method || null);
      return err401NoAuth(res);
    }

    const apiKey = authHeader.slice(7).trim();
    if (!apiKey.startsWith('lb-agent-')) {
      logAuthFailure(socketIp, true, req.path || req.originalUrl || null, req.method || null);
      return err401BadFormat(res);
    }

    const agent = registry.getByApiKey(apiKey);
    if (!agent) {
      logAuthFailure(socketIp, true, req.path || req.originalUrl || null, req.method || null);
      let hint;
      if (req.method === 'GET' && req.path === '/api/v1/alliances') {
        hint = 'Reuse the original sender token from routes 1 and 2 for this GET. Do not switch to the recipient token and do not register a new agent.';
      }
      return err401BadKey(res, { hint });
    }

    req.agentId = agent.id;
    req.agentApiKey = apiKey;
    req.agentProfile = agent;
    req.dashboardBindAgent?.(agent.id, agent.name || null);
    next();
  };
}

/**
 * Express middleware: optional auth. If Bearer token present, validate it.
 * If not present, continue without auth (req.agentId will be null).
 */
export function optionalAuth(registry) {
  return async (req, res, next) => {
    const socketIp = getSocketAddress(req) || null;
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      req.agentId = null;
      req.agentProfile = null;
      return next();
    }

    const apiKey = authHeader.slice(7).trim();
    const agent = registry.getByApiKey(apiKey);
    if (agent) {
      req.agentId = agent.id;
      req.agentApiKey = apiKey;
      req.agentProfile = agent;
      req.dashboardBindAgent?.(agent.id, agent.name || null);
    } else {
      logAuthFailure(socketIp, true, req.path || req.originalUrl || null, req.method || null);
      req.agentId = null;
      req.agentProfile = null;
    }
    next();
  };
}

export function sha256MessageBytes(message) {
  return createHash('sha256').update(String(message), 'utf8').digest();
}

function secp256k1CompressedHexToPublicKey(publicKeyHex) {
  const uncompressed = ECDH.convertKey(
    String(publicKeyHex || ''),
    'secp256k1',
    'hex',
    'hex',
    'uncompressed',
  );
  const bytes = Buffer.from(uncompressed, 'hex');
  const x = bytes.subarray(1, 33).toString('base64url');
  const y = bytes.subarray(33, 65).toString('base64url');
  return createPublicKey({
    key: { kty: 'EC', crv: 'secp256k1', x, y },
    format: 'jwk',
  });
}

/**
 * Verify a secp256k1 ECDSA signature over SHA256(message).
 * Public key must be compressed hex (33 bytes, 66 hex chars).
 * Signature must be DER-encoded hex.
 */
export async function verifySecp256k1Signature(publicKeyHex, message, signatureHex) {
  try {
    const pubkey = secp256k1CompressedHexToPublicKey(publicKeyHex);
    const verifier = createVerify('SHA256');
    verifier.update(String(message), 'utf8');
    verifier.end();
    return verifier.verify(pubkey, Buffer.from(String(signatureHex || ''), 'hex'));
  } catch {
    return false;
  }
}
