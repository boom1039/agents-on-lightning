/**
 * In-memory deduplication cache with automatic expiry.
 * Replaces copy-pasted _seenHashes Map + _cleanExpiredDedup() pattern.
 */
import { acquire as acquireMutex } from '../identity/mutex.js';

export class DedupCache {
  /**
   * @param {number} expiryMs — how long entries live (default 10 minutes)
   */
  constructor(expiryMs = 600_000, { dataLayer = null, path = null, mutex = { acquire: acquireMutex } } = {}) {
    this._expiryMs = expiryMs;
    this._entries = new Map(); // key → expiry timestamp (ms)
    this._dataLayer = dataLayer && typeof dataLayer.readJSON === 'function' && typeof dataLayer.writeJSON === 'function'
      ? dataLayer
      : null;
    this._path = path;
    this._mutex = mutex;
  }

  /** Check if key exists (cleans expired entries first). */
  async has(key) {
    await this._refresh();
    this._clean();
    return this._entries.has(key);
  }

  /** Record a key with the configured expiry. */
  async mark(key) {
    await this._refresh();
    this._entries.set(key, Date.now() + this._expiryMs);
    await this._persist();
  }

  async resetForTests() {
    this._entries.clear();
    await this._persist();
    return { reset: true };
  }

  _clean() {
    const now = Date.now();
    for (const [key, expiry] of this._entries) {
      if (now >= expiry) this._entries.delete(key);
    }
  }

  async _refresh() {
    if (!this._dataLayer || !this._path) return;
    const unlock = await this._mutex.acquire(`dedup:${this._path}`);
    try {
      let raw;
      try {
        raw = await this._dataLayer.readJSON(this._path);
      } catch (err) {
        if (err.code === 'ENOENT') return;
        throw err;
      }
      this._entries.clear();
      for (const [key, expiry] of Object.entries(raw?.entries || {})) {
        if (typeof expiry === 'number') this._entries.set(key, expiry);
      }
      this._clean();
    } finally {
      unlock();
    }
  }

  async _persist() {
    if (!this._dataLayer || !this._path) return;
    const unlock = await this._mutex.acquire(`dedup:${this._path}`);
    try {
      this._clean();
      const entries = Object.fromEntries(this._entries.entries());
      await this._dataLayer.writeJSON(this._path, { entries });
    } finally {
      unlock();
    }
  }
}
