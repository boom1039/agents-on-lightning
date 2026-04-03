/**
 * Central rate limiting middleware with sliding window counters.
 *
 * Extremely conservative per-category limits.
 * In-memory Map<string, { count, windowStart }> per category.
 * Returns 429 with Retry-After header when exceeded.
 */

import { logRateLimitHit } from './audit-log.js';
import { err429 } from './agent-friendly-errors.js';
import { acquire as acquireMutex } from './mutex.js';
import { getSocketAddress, isLoopbackAddress } from './request-security.js';

// Category configurations: { perAgent, perIp, global, windowMs }
const CATEGORIES = {
  registration:  { perAgent: null, perIp: 3,  global: 50,  windowMs: 3600_000 },    // 1 hour
  analysis:      { perAgent: 2,    perIp: 3,  global: 10,  windowMs: 300_000 },      // 5 min
  wallet_write:  { perAgent: 10,   perIp: 15, global: 100, windowMs: 60_000 },       // 1 min
  wallet_read:   { perAgent: 20,   perIp: 30, global: 200, windowMs: 60_000 },       // 1 min
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
  market_private_read: { perAgent: 20, perIp: 30, global: 200, windowMs: 60_000 }, // 1 min
  market_write:     { perAgent: 5,  perIp: 10, global: 60,  windowMs: 300_000 },   // 5 min
  identity_read:    { perAgent: 20, perIp: 30, global: 200, windowMs: 60_000 },    // 1 min
  identity_write:   { perAgent: 10, perIp: 15, global: 100, windowMs: 60_000 },    // 1 min
  node_write:       { perAgent: 3,  perIp: 5,  global: 30,  windowMs: 300_000 },   // 5 min
};

// Global server cap
const GLOBAL_CAP = { limit: 1000, windowMs: 60_000 };

// Counters: Map<string, { count: number, windowStart: number }>
const _counters = new Map();
const _globalCounter = { count: 0, windowStart: Date.now() };
let _persistentStore = null;

// ---------------------------------------------------------------------------
// Progressive penalty tracking
// ---------------------------------------------------------------------------
// Tracks consecutive rate-limit violations per agent. After 5+ consecutive
// violations the effective cooldown doubles; after 10+ it quadruples.
// A clean request (no rate limit hit) resets the counter.

const PROGRESSIVE_THRESHOLDS = [
  { violations: 10, multiplier: 4 },
  { violations: 5,  multiplier: 2 },
];
const PROGRESSIVE_RESET_WINDOW_MS = 300_000; // 5 minutes without violations → full reset

// Map<agentId, { count: number, lastViolation: number }>
const _violationCounters = new Map();

/**
 * Record a rate-limit violation for an agent. Returns the penalty multiplier.
 */
export function recordViolation(agentId) {
  if (!agentId) return 1;
  const now = Date.now();
  const entry = _violationCounters.get(agentId) || { count: 0, lastViolation: 0 };
  entry.count++;
  entry.lastViolation = now;
  _violationCounters.set(agentId, entry);
  return _getPenaltyMultiplier(agentId);
}

/**
 * Reset violation counter for an agent after a clean request.
 */
export function resetViolations(agentId) {
  if (!agentId) return;
  const entry = _violationCounters.get(agentId);
  if (!entry) return;
  // Only reset if enough time has passed since last violation, or count is low
  const now = Date.now();
  if (now - entry.lastViolation > PROGRESSIVE_RESET_WINDOW_MS || entry.count <= 1) {
    _violationCounters.delete(agentId);
  } else {
    // Decay: reduce count on each clean request so recovery is gradual
    entry.count = Math.max(0, entry.count - 1);
    if (entry.count === 0) _violationCounters.delete(agentId);
  }
}

/**
 * Get the current penalty multiplier for an agent.
 */
export function _getPenaltyMultiplier(agentId) {
  if (!agentId) return 1;
  const entry = _violationCounters.get(agentId);
  if (!entry) return 1;

  // Auto-expire if no violations in the reset window
  const now = Date.now();
  if (now - entry.lastViolation > PROGRESSIVE_RESET_WINDOW_MS) {
    _violationCounters.delete(agentId);
    return 1;
  }

  for (const { violations, multiplier } of PROGRESSIVE_THRESHOLDS) {
    if (entry.count >= violations) return multiplier;
  }
  return 1;
}

/**
 * Get violation info for an agent (for testing / diagnostics).
 */
export function getViolationInfo(agentId) {
  const entry = _violationCounters.get(agentId);
  if (!entry) return { count: 0, multiplier: 1 };
  return { count: entry.count, multiplier: _getPenaltyMultiplier(agentId) };
}

function defaultPersistentState() {
  return {
    counters: {},
    globalCounter: { count: 0, windowStart: Date.now() },
  };
}

export function configureRateLimiterPersistence({ dataLayer, path = 'data/security/rate-limits.json', mutex = { acquire: acquireMutex } } = {}) {
  if (!dataLayer || typeof dataLayer.readJSON !== 'function' || typeof dataLayer.writeJSON !== 'function') {
    _persistentStore = null;
    return;
  }
  _persistentStore = { dataLayer, path, mutex };
}

export function disableRateLimiterPersistence() {
  _persistentStore = null;
}

async function withPersistentState(mutator) {
  if (!_persistentStore) return mutator(null);
  const unlock = await _persistentStore.mutex.acquire(`rate-limit:${_persistentStore.path}`);
  try {
    let state;
    try {
      state = await _persistentStore.dataLayer.readJSON(_persistentStore.path);
    } catch (err) {
      if (err.code === 'ENOENT') state = defaultPersistentState();
      else throw err;
    }
    const result = await mutator(state);
    await _persistentStore.dataLayer.writeJSON(_persistentStore.path, state);
    return result;
  } finally {
    unlock();
  }
}

/**
 * Check and increment a rate limit counter for a given key.
 * Exported so routes can build compound keys (e.g., IP+target).
 * @param {string} key - Unique counter key
 * @param {number} limit - Max count per window
 * @param {number} windowMs - Window duration in ms
 * @returns {{ allowed: boolean, retryAfter: number }}
 */
export async function checkAndIncrement(key, limit, windowMs) {
  if (_persistentStore) {
    return withPersistentState((state) => {
      const now = Date.now();
      const entry = state.counters[key];
      if (!entry || now - entry.windowStart > windowMs) {
        state.counters[key] = { count: 1, windowStart: now };
        return { allowed: true, retryAfter: 0 };
      }
      if (entry.count >= limit) {
        const retryAfter = Math.ceil((entry.windowStart + windowMs - now) / 1000);
        return { allowed: false, retryAfter };
      }
      entry.count++;
      return { allowed: true, retryAfter: 0 };
    });
  }
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
export async function checkOnly(key, limit, windowMs) {
  if (_persistentStore) {
    return withPersistentState((state) => {
      const now = Date.now();
      const entry = state.counters[key];
      if (!entry || now - entry.windowStart > windowMs) {
        return { allowed: true, retryAfter: 0 };
      }
      if (entry.count >= limit) {
        const retryAfter = Math.ceil((entry.windowStart + windowMs - now) / 1000);
        return { allowed: false, retryAfter };
      }
      return { allowed: true, retryAfter: 0 };
    });
  }
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

export async function decrementCounter(key, amount = 1) {
  const decrementBy = Number.isFinite(amount) && amount > 0 ? Math.floor(amount) : 1;
  if (_persistentStore) {
    return withPersistentState((state) => {
      const entry = state.counters[key];
      if (!entry) return { count: 0 };
      entry.count = Math.max(0, (entry.count || 0) - decrementBy);
      if (entry.count === 0) {
        delete state.counters[key];
      }
      return { count: entry.count || 0 };
    });
  }

  const entry = _counters.get(key);
  if (!entry) return { count: 0 };
  entry.count = Math.max(0, (entry.count || 0) - decrementBy);
  if (entry.count === 0) {
    _counters.delete(key);
  }
  return { count: entry.count || 0 };
}

async function _checkGlobalCap() {
  if (_persistentStore) {
    return withPersistentState((state) => {
      const now = Date.now();
      const counter = state.globalCounter || { count: 0, windowStart: now };
      state.globalCounter = counter;
      if (now - counter.windowStart > GLOBAL_CAP.windowMs) {
        counter.count = 1;
        counter.windowStart = now;
        return { allowed: true, retryAfter: 0 };
      }
      if (counter.count >= GLOBAL_CAP.limit) {
        const retryAfter = Math.ceil((counter.windowStart + GLOBAL_CAP.windowMs - now) / 1000);
        return { allowed: false, retryAfter };
      }
      counter.count++;
      return { allowed: true, retryAfter: 0 };
    });
  }
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

  return async (req, res, next) => {
    try {
    const socketIp = getSocketAddress(req) || 'unknown';
    const agentId = req.agentId || null;

    // Exempt localhost (dashboard, test runner, operator)
    if (isLoopbackAddress(socketIp)) return next();

    // 1. Global server cap
    const globalCheck = await _checkGlobalCap();
    if (!globalCheck.allowed) {
      logRateLimitHit('global', socketIp, agentId);
      return err429(res, { category: 'global', retryAfter: globalCheck.retryAfter });
    }

    // 2. Per-IP limit
    if (config.perIp) {
      const ipCheck = await checkAndIncrement(`${category}:ip:${socketIp}`, config.perIp, config.windowMs);
      if (!ipCheck.allowed) {
        logRateLimitHit(category, socketIp, agentId);
        return err429(res, { category, retryAfter: ipCheck.retryAfter });
      }
    }

    // 3. Per-agent limit (only if authenticated)
    // Apply progressive penalty: repeat offenders get a longer effective window
    if (config.perAgent && agentId) {
      const multiplier = _getPenaltyMultiplier(agentId);
      const effectiveWindow = config.windowMs * multiplier;
      const agentCheck = await checkAndIncrement(`${category}:agent:${agentId}`, config.perAgent, effectiveWindow);
      if (!agentCheck.allowed) {
        recordViolation(agentId);
        const penaltyInfo = multiplier > 1 ? ` (penalty ${multiplier}x due to repeated violations)` : '';
        logRateLimitHit(category, socketIp, agentId);
        return err429(res, { category, retryAfter: agentCheck.retryAfter, penaltyMultiplier: multiplier, penaltyInfo });
      }
    }

    // 4. Global per-category limit
    const catCheck = await checkAndIncrement(`${category}:global`, config.global, config.windowMs);
    if (!catCheck.allowed) {
      if (agentId) recordViolation(agentId);
      logRateLimitHit(category, socketIp, agentId);
      return err429(res, { category, retryAfter: catCheck.retryAfter });
    }

    // Clean pass — decay violation counter
    if (agentId) resetViolations(agentId);

    next();
    } catch (err) {
      next(err);
    }
  };
}

/**
 * Global rate limit middleware (applied to all requests).
 */
export async function globalRateLimit(req, res, next) {
  try {
  const socketIp = getSocketAddress(req) || 'unknown';
  if (isLoopbackAddress(socketIp)) return next();
  const globalCheck = await _checkGlobalCap();
  if (!globalCheck.allowed) {
    logRateLimitHit('global', socketIp, null);
    return err429(res, { category: 'global', retryAfter: globalCheck.retryAfter });
  }
  next();
  } catch (err) {
    next(err);
  }
}

/**
 * Reset all rate limit counters. Used by E2E tests to avoid cross-suite interference.
 */
export async function resetCounters() {
  _counters.clear();
  _violationCounters.clear();
  _globalCounter.count = 0;
  _globalCounter.windowStart = Date.now();
  if (_persistentStore) {
    await _persistentStore.dataLayer.writeJSON(_persistentStore.path, defaultPersistentState());
  }
}
