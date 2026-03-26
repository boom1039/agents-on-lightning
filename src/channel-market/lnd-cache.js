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
    this._entries = {};
  }

  async _get(key, fetchFn) {
    const entry = this._entries[key];
    if (entry && Date.now() - entry.at < this._maxAgeMs) return entry.data;
    const client = this._nodeManager.getDefaultNodeOrNull();
    if (!client) return [];
    try {
      const data = await fetchFn(client);
      this._entries[key] = { data, at: Date.now() };
      return data;
    } catch {
      return entry?.data || [];
    }
  }

  getChannels() {
    return this._get('channels', async c => (await c.listChannels()).channels || []);
  }

  getFeeReport() {
    return this._get('fees', async c => (await c.feeReport()).channel_fees || []);
  }

  getClosedChannels() {
    return this._get('closed', async c => (await c.closedChannels()).channels || []);
  }

  async getNodeInfo(pubkey) {
    const client = this._nodeManager.getDefaultNodeOrNull();
    if (!client) return null;
    try {
      return await client.getNodeInfo(pubkey);
    } catch {
      return null;
    }
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
