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

let CATEGORIES = null;
let GLOBAL_CAP = null;

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

let PROGRESSIVE_THRESHOLDS = null;
let PROGRESSIVE_RESET_WINDOW_MS = null;

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
  if (!PROGRESSIVE_THRESHOLDS || !Number.isInteger(PROGRESSIVE_RESET_WINDOW_MS)) {
    throw new Error('Rate limiter policy not configured. Set it in config/local.yaml.');
  }
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

export function configureRateLimiterPolicy({ categories, globalCap, progressive } = {}) {
  if (!categories || typeof categories !== 'object') {
    throw new Error('Missing hidden rate-limit categories. Set them in config/local.yaml.');
  }
  if (!globalCap || !Number.isInteger(globalCap.limit) || !Number.isInteger(globalCap.windowMs)) {
    throw new Error('Missing hidden global rate-limit settings. Set them in config/local.yaml.');
  }
  if (!progressive || !Array.isArray(progressive.thresholds) || !Number.isInteger(progressive.resetWindowMs)) {
    throw new Error('Missing hidden progressive rate-limit settings. Set them in config/local.yaml.');
  }
  CATEGORIES = { ...categories };
  GLOBAL_CAP = { ...globalCap };
  PROGRESSIVE_THRESHOLDS = [...progressive.thresholds].sort((a, b) => b.violations - a.violations);
  PROGRESSIVE_RESET_WINDOW_MS = progressive.resetWindowMs;
}

export function disableRateLimiterPersistence() {
  _persistentStore = null;
}

async function withPersistentState(mutator) {
  if (!_persistentStore) return mutator(null);
  const unlock = await _persistentStore.mutex.acquire(`rate-limit:${_persistentStore.path}`);
  try {
    const state = await _persistentStore.dataLayer.readRuntimeStateJSON(_persistentStore.path, {
      defaultValue: defaultPersistentState,
    });
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
 * @returns {{ allowed: boolean, retryAfter: number, retryAfterMs: number, retryAtMs: number|null }}
 */
export async function checkAndIncrement(key, limit, windowMs) {
  if (_persistentStore) {
    return withPersistentState((state) => {
      const now = Date.now();
      const entry = state.counters[key];
      if (!entry || now - entry.windowStart > windowMs) {
        state.counters[key] = { count: 1, windowStart: now };
        return { allowed: true, retryAfter: 0, retryAfterMs: 0, retryAtMs: null };
      }
      if (entry.count >= limit) {
        const retryAfterMs = Math.max(0, (entry.windowStart + windowMs) - now);
        const retryAfter = Math.ceil(retryAfterMs / 1000);
        return { allowed: false, retryAfter, retryAfterMs, retryAtMs: now + retryAfterMs };
      }
      entry.count++;
      return { allowed: true, retryAfter: 0, retryAfterMs: 0, retryAtMs: null };
    });
  }
  const now = Date.now();
  const entry = _counters.get(key);

  if (!entry || now - entry.windowStart > windowMs) {
    _counters.set(key, { count: 1, windowStart: now });
    return { allowed: true, retryAfter: 0, retryAfterMs: 0, retryAtMs: null };
  }

  if (entry.count >= limit) {
    const retryAfterMs = Math.max(0, (entry.windowStart + windowMs) - now);
    const retryAfter = Math.ceil(retryAfterMs / 1000);
    return { allowed: false, retryAfter, retryAfterMs, retryAtMs: now + retryAfterMs };
  }

  entry.count++;
  return { allowed: true, retryAfter: 0, retryAfterMs: 0, retryAtMs: null };
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
        return { allowed: true, retryAfter: 0, retryAfterMs: 0, retryAtMs: null };
      }
      if (entry.count >= limit) {
        const retryAfterMs = Math.max(0, (entry.windowStart + windowMs) - now);
        const retryAfter = Math.ceil(retryAfterMs / 1000);
        return { allowed: false, retryAfter, retryAfterMs, retryAtMs: now + retryAfterMs };
      }
      return { allowed: true, retryAfter: 0, retryAfterMs: 0, retryAtMs: null };
    });
  }
  const now = Date.now();
  const entry = _counters.get(key);

  if (!entry || now - entry.windowStart > windowMs) {
    return { allowed: true, retryAfter: 0, retryAfterMs: 0, retryAtMs: null };
  }

  if (entry.count >= limit) {
    const retryAfterMs = Math.max(0, (entry.windowStart + windowMs) - now);
    const retryAfter = Math.ceil(retryAfterMs / 1000);
    return { allowed: false, retryAfter, retryAfterMs, retryAtMs: now + retryAfterMs };
  }

  return { allowed: true, retryAfter: 0, retryAfterMs: 0, retryAtMs: null };
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
  if (!GLOBAL_CAP) {
    throw new Error('Rate limiter policy not configured. Set it in config/local.yaml.');
  }
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
  if (!CATEGORIES) {
    throw new Error('Rate limiter policy not configured. Set it in config/local.yaml.');
  }
  const config = CATEGORIES[category];
  if (!config) throw new Error(`Unknown rate limit category: ${category}`);

  return async (req, res, next) => {
    try {
    const socketIp = getSocketAddress(req) || 'unknown';
    const agentId = req.agentId || null;
    const routePath = req.path || req.originalUrl || null;
    const method = req.method || null;

    // Exempt localhost (dashboard, test runner, operator)
    if (isLoopbackAddress(socketIp)) return next();

    // 1. Global server cap
    const globalCheck = await _checkGlobalCap();
    if (!globalCheck.allowed) {
      logRateLimitHit('global', socketIp, agentId, routePath, method);
      return err429(res, { category: 'global', retryAfter: globalCheck.retryAfter });
    }

    // 2. Per-IP limit
    if (config.perIp) {
      const ipCheck = await checkAndIncrement(`${category}:ip:${socketIp}`, config.perIp, config.windowMs);
      if (!ipCheck.allowed) {
        logRateLimitHit(category, socketIp, agentId, routePath, method);
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
        logRateLimitHit(category, socketIp, agentId, routePath, method);
        return err429(res, { category, retryAfter: agentCheck.retryAfter, penaltyMultiplier: multiplier, penaltyInfo });
      }
    }

    // 4. Global per-category limit
    const catCheck = await checkAndIncrement(`${category}:global`, config.global, config.windowMs);
    if (!catCheck.allowed) {
      if (agentId) recordViolation(agentId);
      logRateLimitHit(category, socketIp, agentId, routePath, method);
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
  const routePath = req.path || req.originalUrl || null;
  const method = req.method || null;
  if (isLoopbackAddress(socketIp)) return next();
  const globalCheck = await _checkGlobalCap();
  if (!globalCheck.allowed) {
    logRateLimitHit('global', socketIp, null, routePath, method);
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
