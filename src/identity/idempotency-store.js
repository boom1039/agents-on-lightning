import { acquire as acquireMutex } from './mutex.js';

const DEFAULT_TTL_MS = 24 * 3600 * 1000;

function defaultState() {
  return { entries: {} };
}

export class IdempotencyStore {
  constructor({ dataLayer, path = 'data/security/idempotency.json', ttlMs = DEFAULT_TTL_MS, mutex = { acquire: acquireMutex } } = {}) {
    if (!dataLayer) throw new Error('IdempotencyStore requires dataLayer');
    this._dataLayer = dataLayer;
    this._path = path;
    this._ttlMs = ttlMs;
    this._mutex = mutex;
  }

  async _readState() {
    const state = await this._dataLayer.readRuntimeStateJSON(this._path, {
      defaultValue: defaultState,
    });
    return state && typeof state === 'object' ? state : defaultState();
  }

  async _writeState(state) {
    await this._dataLayer.writeJSON(this._path, state);
  }

  _clean(state) {
    const now = Date.now();
    for (const [key, entry] of Object.entries(state.entries || {})) {
      if (!entry || typeof entry !== 'object') {
        delete state.entries[key];
        continue;
      }
      if (entry.expires_at != null && entry.expires_at <= now) {
        delete state.entries[key];
      }
    }
  }

  _compositeKey(scope, agentId, key) {
    return `${scope}:${agentId}:${key}`;
  }

  async begin(scope, agentId, key) {
    const unlock = await this._mutex.acquire(`idempotency:${scope}:${agentId}:${key}`);
    try {
      const state = await this._readState();
      this._clean(state);
      const compositeKey = this._compositeKey(scope, agentId, key);
      const existing = state.entries[compositeKey];
      if (existing) {
        await this._writeState(state);
        return { started: false, entry: existing };
      }
      const now = Date.now();
      const entry = {
        scope,
        agent_id: agentId,
        key,
        status: 'pending',
        started_at: now,
        expires_at: now + this._ttlMs,
      };
      state.entries[compositeKey] = entry;
      await this._writeState(state);
      return { started: true, entry };
    } finally {
      unlock();
    }
  }

  async finish(scope, agentId, key, { statusCode, body }) {
    const unlock = await this._mutex.acquire(`idempotency:${scope}:${agentId}:${key}`);
    try {
      const state = await this._readState();
      this._clean(state);
      const compositeKey = this._compositeKey(scope, agentId, key);
      const now = Date.now();
      state.entries[compositeKey] = {
        ...(state.entries[compositeKey] || {}),
        scope,
        agent_id: agentId,
        key,
        status: 'complete',
        completed_at: now,
        expires_at: now + this._ttlMs,
        response: {
          statusCode,
          body,
        },
      };
      await this._writeState(state);
      return state.entries[compositeKey];
    } finally {
      unlock();
    }
  }
}
