/**
 * Authentication middleware for external agent API.
 * Bearer token format: lb-agent-{32-byte-hex}
 * Optional Ed25519 signature verification for cross-model identity.
 */

import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { err401NoAuth, err401BadFormat, err401BadKey } from './agent-friendly-errors.js';

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
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return err401NoAuth(res);
    }

    const apiKey = authHeader.slice(7).trim();
    if (!apiKey.startsWith('lb-agent-')) {
      return err401BadFormat(res);
    }

    const agent = registry.getByApiKey(apiKey);
    if (!agent) {
      return err401BadKey(res);
    }

    req.agentId = agent.id;
    req.agentApiKey = apiKey;
    req.agentProfile = agent;
    next();
  };
}

/**
 * Express middleware: optional auth. If Bearer token present, validate it.
 * If not present, continue without auth (req.agentId will be null).
 */
export function optionalAuth(registry) {
  return async (req, res, next) => {
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
    } else {
      req.agentId = null;
      req.agentProfile = null;
    }
    next();
  };
}

/**
 * Verify Ed25519 signature for cross-model identity verification.
 * Uses Node.js built-in crypto.
 */
export async function verifyEd25519Signature(publicKeyHex, message, signatureHex) {
  try {
    const { verify, createPublicKey } = await import('node:crypto');
    const pubKeyBuffer = Buffer.from(publicKeyHex, 'hex');
    const key = createPublicKey({
      key: Buffer.concat([
        // Ed25519 DER prefix
        Buffer.from('302a300506032b6570032100', 'hex'),
        pubKeyBuffer,
      ]),
      format: 'der',
      type: 'spki',
    });
    return verify(null, Buffer.from(message), key, Buffer.from(signatureHex, 'hex'));
  } catch {
    return false;
  }
}
