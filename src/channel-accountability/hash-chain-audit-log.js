import { sha256, canonicalJSON } from './crypto-utils.js';

export { canonicalJSON };

const CHAIN_PATH = 'data/channel-accountability/audit-chain.jsonl';
const GENESIS_HASH = '0'.repeat(64);
const CHECKPOINT_INTERVAL = 1000;
const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 1000;

/**
 * Tamper-evident append-only SHA-256 hash chain stored as JSONL.
 * Each entry links to the previous via prev_hash, forming an unbroken chain.
 */
export class HashChainAuditLog {
  constructor(dataLayer, mutex) {
    this._dataLayer = dataLayer;
    this._mutex = mutex;
    this._lastHash = GENESIS_HASH;
    this._entryCount = 0;
    this._lastTimestamp = null;
  }

  async _loadTail() {
    const entries = await this._dataLayer.readLog(CHAIN_PATH);
    if (entries.length > 0) {
      const last = entries[entries.length - 1];
      if (last.hash) {
        this._lastHash = last.hash;
      }
      this._entryCount = entries.length;
      this._lastTimestamp = last._ts || null;
    }
  }

  async append(entry) {
    const unlock = await this._mutex.acquire('audit-chain');
    try {
      const stamped = {
        ...entry,
        _ts: Date.now(),
        prev_hash: this._lastHash,
      };
      const hash = sha256(canonicalJSON(stamped));
      stamped.hash = hash;

      await this._dataLayer.appendLog(CHAIN_PATH, stamped);
      this._lastHash = hash;
      this._entryCount++;
      this._lastTimestamp = stamped._ts;

      // Auto-checkpoint every N entries
      if (this._entryCount % CHECKPOINT_INTERVAL === 0) {
        await this._appendCheckpoint();
      }

      return stamped;
    } finally {
      unlock();
    }
  }

  async _appendCheckpoint() {
    const checkpoint = {
      type: 'checkpoint',
      chain_hash: this._lastHash,
      entry_count: this._entryCount,
      _ts: Date.now(),
      prev_hash: this._lastHash,
    };
    const hash = sha256(canonicalJSON(checkpoint));
    checkpoint.hash = hash;
    await this._dataLayer.appendLog(CHAIN_PATH, checkpoint);
    this._lastHash = hash;
    this._entryCount++;
    this._lastTimestamp = checkpoint._ts;
  }

  async readAll({ since, limit = DEFAULT_LIMIT, offset = 0 } = {}) {
    const clamped = Math.min(Math.max(1, limit), MAX_LIMIT);
    const entries = await this._dataLayer.readLog(CHAIN_PATH, since);
    return entries.slice(offset, offset + clamped);
  }

  async readByChannel(chanId, limit = DEFAULT_LIMIT) {
    const clamped = Math.min(Math.max(1, limit), MAX_LIMIT);
    const all = await this._dataLayer.readLog(CHAIN_PATH);
    return all.filter(e => e.chan_id === chanId || e.channel_id === chanId).slice(-clamped);
  }

  async readByType(type, limit = DEFAULT_LIMIT) {
    const clamped = Math.min(Math.max(1, limit), MAX_LIMIT);
    const all = await this._dataLayer.readLog(CHAIN_PATH);
    return all.filter(e => e.type === type).slice(-clamped);
  }

  /**
   * Verify chain integrity from genesis.
   * Partial lines at file tail are warnings (crash artifacts), not errors.
   */
  async verify(chanId) {
    const all = await this._dataLayer.readLog(CHAIN_PATH);
    const entries = chanId
      ? all.filter(e => e.chan_id === chanId || e.channel_id === chanId || e.type === 'checkpoint' || e.type === 'monitor_started' || e.type === 'monitor_restarted')
      : all;

    // For full chain verification, we need all entries in order
    const fullChain = chanId ? all : entries;

    const errors = [];
    const warnings = [];
    let prevHash = GENESIS_HASH;
    let checked = 0;

    for (let i = 0; i < fullChain.length; i++) {
      const entry = fullChain[i];

      if (!entry.hash || !entry.prev_hash) {
        // Likely a partial write at tail
        if (i === fullChain.length - 1) {
          warnings.push({ index: i, issue: 'incomplete entry at chain tail (possible crash artifact)' });
        } else {
          errors.push({ index: i, issue: 'missing hash or prev_hash' });
        }
        continue;
      }

      // Check prev_hash linkage
      if (entry.prev_hash !== prevHash) {
        errors.push({
          index: i,
          issue: 'prev_hash mismatch',
          expected: prevHash,
          got: entry.prev_hash,
        });
      }

      // Recompute hash
      const { hash: storedHash, ...withoutHash } = entry;
      const computed = sha256(canonicalJSON(withoutHash));
      if (computed !== storedHash) {
        errors.push({
          index: i,
          issue: 'hash mismatch (entry tampered)',
          expected: computed,
          got: storedHash,
        });
      }

      prevHash = storedHash;
      checked++;
    }

    return {
      valid: errors.length === 0,
      checked,
      total: fullChain.length,
      errors,
      warnings,
    };
  }

  async getStatus() {
    return {
      entries: this._entryCount,
      lastHash: this._lastHash,
      lastTimestamp: this._lastTimestamp,
    };
  }

  getLastTimestamp() {
    return this._lastTimestamp;
  }
}
