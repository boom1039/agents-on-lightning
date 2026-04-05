import { acquire as acquireMutex } from './mutex.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_PATH = 'data/security/danger-route-policy.json';

function defaultState() {
  return {
    daily_amounts: {},
    last_success: {},
  };
}

function clampArray(entries, cutoff) {
  if (!Array.isArray(entries)) return [];
  return entries.filter((entry) => entry && Number.isFinite(entry.ts) && entry.ts >= cutoff && Number.isFinite(entry.amount) && entry.amount >= 0);
}

function amountKey(scope, agentId) {
  return `${scope}:${agentId}`;
}

function sharedAmountKey(scope) {
  return `${scope}:__shared__`;
}

function successKey(scope, agentId, resourceId = 'global') {
  return `${scope}:${agentId}:${resourceId}`;
}

export function findUnexpectedKeys(body, allowedKeys) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return [];
  const allowed = new Set(allowedKeys);
  return Object.keys(body).filter((key) => !allowed.has(key));
}

export class DangerRoutePolicyStore {
  static _instances = new Set();

  constructor({ dataLayer, path = DEFAULT_PATH, mutex = { acquire: acquireMutex } } = {}) {
    this._dataLayer = dataLayer || null;
    this._path = path;
    this._mutex = mutex;
    this._memory = defaultState();
    DangerRoutePolicyStore._instances.add(this);
  }

  async _withState(mutator) {
    if (!this._dataLayer) return mutator(this._memory, false);
    const unlock = await this._mutex.acquire(`danger-policy:${this._path}`);
    try {
      let state;
      try {
        state = await this._dataLayer.readJSON(this._path);
      } catch (err) {
        if (err.code === 'ENOENT') state = defaultState();
        else throw err;
      }
      const result = await mutator(state, true);
      await this._dataLayer.writeJSON(this._path, state);
      return result;
    } finally {
      unlock();
    }
  }

  async assessAmount({
    scope,
    agentId,
    amountSats = 0,
    autoApproveSats,
    hardCapSats,
    dailyAutoApproveSats,
    dailyHardCapSats,
    sharedDailyAutoApproveSats,
    sharedDailyHardCapSats,
  }) {
    return this._withState(async (state) => {
      const now = Date.now();
      const cutoff = now - DAY_MS;
      const key = amountKey(scope, agentId);
      const sharedKey = sharedAmountKey(scope);
      const entries = clampArray(state.daily_amounts[key], cutoff);
      const sharedEntries = clampArray(state.daily_amounts[sharedKey], cutoff);
      state.daily_amounts[key] = entries;
      state.daily_amounts[sharedKey] = sharedEntries;
      const total24h = entries.reduce((sum, entry) => sum + entry.amount, 0);
      const sharedTotal24h = sharedEntries.reduce((sum, entry) => sum + entry.amount, 0);

      if (Number.isFinite(hardCapSats) && amountSats > hardCapSats) {
        return { decision: 'hard_cap', decisionReason: 'agent_hard_cap', total24h, sharedTotal24h };
      }
      if (Number.isFinite(dailyHardCapSats) && total24h + amountSats > dailyHardCapSats) {
        return { decision: 'hard_cap', decisionReason: 'agent_daily_hard_cap', total24h, sharedTotal24h };
      }
      if (Number.isFinite(sharedDailyHardCapSats) && sharedTotal24h + amountSats > sharedDailyHardCapSats) {
        return { decision: 'hard_cap', decisionReason: 'shared_daily_hard_cap', total24h, sharedTotal24h };
      }
      if (Number.isFinite(autoApproveSats) && amountSats > autoApproveSats) {
        return { decision: 'review_required', decisionReason: 'agent_auto_approve_cap', total24h, sharedTotal24h };
      }
      if (Number.isFinite(dailyAutoApproveSats) && total24h + amountSats > dailyAutoApproveSats) {
        return { decision: 'review_required', decisionReason: 'agent_daily_auto_approve_cap', total24h, sharedTotal24h };
      }
      if (Number.isFinite(sharedDailyAutoApproveSats) && sharedTotal24h + amountSats > sharedDailyAutoApproveSats) {
        return { decision: 'review_required', decisionReason: 'shared_daily_auto_approve_cap', total24h, sharedTotal24h };
      }

      return { decision: 'allow', decisionReason: 'allow', total24h, sharedTotal24h };
    });
  }

  async checkCooldown({ scope, agentId, cooldownMs, resourceId = 'global' }) {
    return this._withState(async (state) => {
      const key = successKey(scope, agentId, resourceId);
      const lastSuccess = state.last_success[key];
      if (!Number.isFinite(lastSuccess) || !Number.isFinite(cooldownMs) || cooldownMs <= 0) {
        return {
          allowed: true,
          retryAfterSeconds: 0,
          retryAfterMs: 0,
          retryAtMs: null,
          lastSuccess: null,
        };
      }

      const elapsed = Date.now() - lastSuccess;
      if (elapsed >= cooldownMs) {
        return {
          allowed: true,
          retryAfterSeconds: 0,
          retryAfterMs: 0,
          retryAtMs: null,
          lastSuccess,
        };
      }

      const retryAfterMs = Math.max(0, cooldownMs - elapsed);
      return {
        allowed: false,
        retryAfterSeconds: Math.ceil(retryAfterMs / 1000),
        retryAfterMs,
        retryAtMs: Date.now() + retryAfterMs,
        lastSuccess,
      };
    });
  }

  async recordSuccess({ scope, agentId, amountSats = 0, resourceId = 'global' }) {
    return this._withState(async (state) => {
      const now = Date.now();
      const cutoff = now - DAY_MS;
      const amountStateKey = amountKey(scope, agentId);
      const sharedStateKey = sharedAmountKey(scope);
      const entries = clampArray(state.daily_amounts[amountStateKey], cutoff);
      const sharedEntries = clampArray(state.daily_amounts[sharedStateKey], cutoff);
      if (amountSats > 0) {
        entries.push({ ts: now, amount: amountSats });
        sharedEntries.push({ ts: now, amount: amountSats });
      }
      state.daily_amounts[amountStateKey] = entries;
      state.daily_amounts[sharedStateKey] = sharedEntries;
      state.last_success[successKey(scope, agentId, resourceId)] = now;
      return { recorded: true, at: now };
    });
  }

  async resetForTests() {
    return this._withState(async (state) => {
      state.daily_amounts = {};
      state.last_success = {};
      if (!this._dataLayer) this._memory = defaultState();
      return { reset: true };
    });
  }

  static async resetAllForTests() {
    await Promise.all(Array.from(DangerRoutePolicyStore._instances, (instance) => instance.resetForTests()));
    return { reset: true, stores: DangerRoutePolicyStore._instances.size };
  }
}
