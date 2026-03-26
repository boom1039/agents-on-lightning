/**
 * Central rate limiting middleware with sliding window counters.
 *
 * Extremely conservative per-category limits.
 * In-memory Map<string, { count, windowStart }> per category.
 * Returns 429 with Retry-After header when exceeded.
 */

import { logRateLimitHit } from './audit-log.js';
import { err429 } from './agent-friendly-errors.js';

// Category configurations: { perAgent, perIp, global, windowMs }
const CATEGORIES = {
  registration:  { perAgent: null, perIp: 3,  global: 50,  windowMs: 3600_000 },    // 1 hour
  analysis:      { perAgent: 2,    perIp: 3,  global: 10,  windowMs: 300_000 },      // 5 min
  wallet_write:  { perAgent: 10,   perIp: 15, global: 100, windowMs: 60_000 },       // 1 min
  wallet_read:   { perAgent: 20,   perIp: 30, global: 200, windowMs: 60_000 },       // 1 min
  bounty_write:  { perAgent: 3,    perIp: 5,  global: 20,  windowMs: 3600_000 },     // 1 hour
  social_write:  { perAgent: 3,    perIp: 5,  global: 30,  windowMs: 300_000 },      // 5 min
  social_read:   { perAgent: 10,   perIp: 20, global: 120, windowMs: 60_000 },       // 1 min
  discovery:     { perAgent: null, perIp: 10, global: 200, windowMs: 60_000 },       // 1 min
  mcp:           { perAgent: null, perIp: 5,  global: 30,  windowMs: 60_000 },       // 1 min
  channel_instruct: { perAgent: 2, perIp: 5,  global: 20,  windowMs: 300_000 },    // 5 min
  channel_read:     { perAgent: 20, perIp: 30, global: 200, windowMs: 60_000 },     // 1 min
  analytics_query:  { perAgent: 30, perIp: 50, global: 500, windowMs: 60_000 },    // 1 min
  capital_read:     { perAgent: 20, perIp: 30, global: 200, windowMs: 60_000 },    // 1 min
  capital_write:    { perAgent: 3,  perIp: 5,  global: 30,  windowMs: 300_000 },   // 5 min
  market_read:      { perAgent: null, perIp: 30, global: 300, windowMs: 60_000 },  // 1 min
};

// Global server cap
const GLOBAL_CAP = { limit: 1000, windowMs: 60_000 };

// Counters: Map<string, { count: number, windowStart: number }>
const _counters = new Map();
const _globalCounter = { count: 0, windowStart: Date.now() };

/**
 * Check and increment a rate limit counter for a given key.
 * Exported so routes can build compound keys (e.g., IP+target).
 * @param {string} key - Unique counter key
 * @param {number} limit - Max count per window
 * @param {number} windowMs - Window duration in ms
 * @returns {{ allowed: boolean, retryAfter: number }}
 */
export function checkAndIncrement(key, limit, windowMs) {
  const now = Date.now();
  const entry = _counters.get(key);

  if (!entry || now - entry.windowStart > windowMs) {
    _counters.set(key, { count: 1, windowStart: now });
    return { allowed: true, retryAfter: 0 };
  }

  if (entry.count >= limit) {
    const retryAfter = Math.ceil((entry.windowStart + windowMs - now) / 1000);
    return { allowed: false, retryAfter };
  }

  entry.count++;
  return { allowed: true, retryAfter: 0 };
}

/**
 * Check rate limit WITHOUT incrementing. Use when you need to verify
 * before committing to the operation (e.g., check before payment).
 */
export function checkOnly(key, limit, windowMs) {
  const now = Date.now();
  const entry = _counters.get(key);

  if (!entry || now - entry.windowStart > windowMs) {
    return { allowed: true, retryAfter: 0 };
  }

  if (entry.count >= limit) {
    const retryAfter = Math.ceil((entry.windowStart + windowMs - now) / 1000);
    return { allowed: false, retryAfter };
  }

  return { allowed: true, retryAfter: 0 };
}

function _checkGlobalCap() {
  const now = Date.now();
  if (now - _globalCounter.windowStart > GLOBAL_CAP.windowMs) {
    _globalCounter.count = 1;
    _globalCounter.windowStart = now;
    return { allowed: true, retryAfter: 0 };
  }

  if (_globalCounter.count >= GLOBAL_CAP.limit) {
    const retryAfter = Math.ceil((_globalCounter.windowStart + GLOBAL_CAP.windowMs - now) / 1000);
    return { allowed: false, retryAfter };
  }

  _globalCounter.count++;
  return { allowed: true, retryAfter: 0 };
}

/**
 * Express middleware factory. Returns middleware that enforces rate limits
 * for the given category.
 *
 * @param {string} category - One of the CATEGORIES keys
 * @returns {Function} Express middleware
 */
export function rateLimit(category) {
  const config = CATEGORIES[category];
  if (!config) throw new Error(`Unknown rate limit category: ${category}`);

  return (req, res, next) => {
    const ip = req.ip || req.connection?.remoteAddress || 'unknown';
    const agentId = req.agentId || null;

    // Exempt localhost (dashboard, test runner, operator)
    if (ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1') return next();

    // 1. Global server cap
    const globalCheck = _checkGlobalCap();
    if (!globalCheck.allowed) {
      logRateLimitHit('global', ip, agentId);
      return err429(res, { category: 'global', retryAfter: globalCheck.retryAfter });
    }

    // 2. Per-IP limit
    if (config.perIp) {
      const ipCheck = checkAndIncrement(`${category}:ip:${ip}`, config.perIp, config.windowMs);
      if (!ipCheck.allowed) {
        logRateLimitHit(category, ip, agentId);
        return err429(res, { category, retryAfter: ipCheck.retryAfter });
      }
    }

    // 3. Per-agent limit (only if authenticated)
    if (config.perAgent && agentId) {
      const agentCheck = checkAndIncrement(`${category}:agent:${agentId}`, config.perAgent, config.windowMs);
      if (!agentCheck.allowed) {
        logRateLimitHit(category, ip, agentId);
        return err429(res, { category, retryAfter: agentCheck.retryAfter });
      }
    }

    // 4. Global per-category limit
    const catCheck = checkAndIncrement(`${category}:global`, config.global, config.windowMs);
    if (!catCheck.allowed) {
      logRateLimitHit(category, ip, agentId);
      return err429(res, { category, retryAfter: catCheck.retryAfter });
    }

    next();
  };
}

/**
 * Global rate limit middleware (applied to all requests).
 */
export function globalRateLimit(req, res, next) {
  const ip = req.ip || req.connection?.remoteAddress || 'unknown';
  const globalCheck = _checkGlobalCap();
  if (!globalCheck.allowed) {
    logRateLimitHit('global', ip, null);
    return err429(res, { category: 'global', retryAfter: globalCheck.retryAfter });
  }
  next();
}

/**
 * Reset all rate limit counters. Used by E2E tests to avoid cross-suite interference.
 */
export function resetCounters() {
  _counters.clear();
  _globalCounter.count = 0;
  _globalCounter.windowStart = Date.now();
}
