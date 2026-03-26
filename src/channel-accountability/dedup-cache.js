/**
 * In-memory deduplication cache with automatic expiry.
 * Replaces copy-pasted _seenHashes Map + _cleanExpiredDedup() pattern.
 */
export class DedupCache {
  /**
   * @param {number} expiryMs — how long entries live (default 10 minutes)
   */
  constructor(expiryMs = 600_000) {
    this._expiryMs = expiryMs;
    this._entries = new Map(); // key → expiry timestamp (ms)
  }

  /** Check if key exists (cleans expired entries first). */
  has(key) {
    this._clean();
    return this._entries.has(key);
  }

  /** Record a key with the configured expiry. */
  mark(key) {
    this._entries.set(key, Date.now() + this._expiryMs);
  }

  _clean() {
    const now = Date.now();
    for (const [key, expiry] of this._entries) {
      if (now >= expiry) this._entries.delete(key);
    }
  }
}
