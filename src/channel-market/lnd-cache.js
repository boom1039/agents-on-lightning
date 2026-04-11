/**
 * Shared LND cache — single cache instance for all read-only channel market modules.
 *
 * Avoids duplicate LND calls when MarketTransparency and PerformanceTracker
 * are both queried within the same 30-second window.
 */

export class LndCache {
  constructor(nodeManager, maxAgeMs = 30_000) {
    this._nodeManager = nodeManager;
    this._maxAgeMs = maxAgeMs;
    this._entries = new Map();
    this._inflight = new Map();
  }

  async _get(key, fetchFn, {
    maxAgeMs = this._maxAgeMs,
    fallbackValue = [],
    useStaleOnError = true,
  } = {}) {
    const entry = this._entries.get(key);
    if (entry && Date.now() - entry.at < maxAgeMs) return entry.data;

    const inflight = this._inflight.get(key);
    if (inflight) return inflight;

    const client = this._nodeManager.getScopedDefaultNodeOrNull('read');
    if (!client) return fallbackValue;

    const promise = (async () => {
      try {
        const data = await fetchFn(client);
        this._entries.set(key, { data, at: Date.now() });
        return data;
      } catch (err) {
        if (useStaleOnError && entry) return entry.data;
        throw err;
      } finally {
        this._inflight.delete(key);
      }
    })();
    this._inflight.set(key, promise);
    return promise;
  }

  invalidate(...keys) {
    if (keys.length === 0) {
      this._entries.clear();
      return;
    }
    for (const key of keys) this._entries.delete(key);
  }

  getChannels(options = {}) {
    return this._get('channels', async c => (await c.listChannels()).channels || [], {
      fallbackValue: [],
      ...options,
    });
  }

  getChannelsLive() {
    return this.getChannels({ maxAgeMs: 0, useStaleOnError: false });
  }

  getFeeReport(options = {}) {
    return this._get('fees', async c => (await c.feeReport()).channel_fees || [], {
      fallbackValue: [],
      ...options,
    });
  }

  getFeeReportLive() {
    return this.getFeeReport({ maxAgeMs: 0, useStaleOnError: false });
  }

  getClosedChannels(options = {}) {
    return this._get('closed', async c => (await c.closedChannels()).channels || [], {
      fallbackValue: [],
      ...options,
    });
  }

  getClosedChannelsLive() {
    return this.getClosedChannels({ maxAgeMs: 0, useStaleOnError: false });
  }

  getInfo(options = {}) {
    return this._get('info', async c => await c.getInfo(), {
      fallbackValue: null,
      ...options,
    });
  }

  getInfoLive() {
    return this.getInfo({ maxAgeMs: 0, useStaleOnError: false });
  }

  getBestBlock(options = {}) {
    return this._get('best-block', async c => await c.getBestBlock(), {
      fallbackValue: null,
      ...options,
    });
  }

  getBestBlockLive() {
    return this.getBestBlock({ maxAgeMs: 0, useStaleOnError: false });
  }

  getTransactions(startHeight = 0, endHeight = -1, options = {}) {
    const key = `transactions:${startHeight}:${endHeight}`;
    return this._get(key, async c => (await c.getTransactions(startHeight, endHeight)).transactions || [], {
      fallbackValue: [],
      ...options,
    });
  }

  getTransactionsLive(startHeight = 0, endHeight = -1) {
    return this.getTransactions(startHeight, endHeight, { maxAgeMs: 0, useStaleOnError: false });
  }

  getNodeInfo(pubkey, options = {}) {
    if (!pubkey) return Promise.resolve(null);
    return this._get(`node-info:${pubkey}`, async c => await c.getNodeInfo(pubkey), {
      fallbackValue: null,
      ...options,
    });
  }

  getNodeInfoLive(pubkey) {
    return this.getNodeInfo(pubkey, { maxAgeMs: 0, useStaleOnError: false });
  }
}

/**
 * Classify channel balance health based on local/capacity ratio.
 * @param {number} localBalance
 * @param {number} capacity
 * @returns {'balanced'|'outbound_heavy'|'inbound_heavy'|'depleted'|'unknown'}
 */
export function classifyBalanceHealth(localBalance, capacity) {
  if (!capacity || capacity === 0) return 'unknown';
  const ratio = localBalance / capacity;
  if (ratio < 0.05 || ratio > 0.95) return 'depleted';
  if (ratio < 0.2) return 'inbound_heavy';
  if (ratio > 0.8) return 'outbound_heavy';
  return 'balanced';
}
