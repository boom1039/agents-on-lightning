/**
 * Spending Velocity Tracker — Per-agent daily spending limits.
 *
 * Tracks cumulative sats spent per agent per day across high-value operations
 * (melt, channel open, capital withdraw). Configurable daily limit.
 *
 * In-memory only — resets on server restart, which is acceptable for a
 * velocity check (restart already interrupts any sustained attack).
 */

export class SpendingVelocityTracker {
  /**
   * @param {object} [opts]
   * @param {number} [opts.dailyLimitSats=10_000_000] Default daily spending limit per agent
   */
  constructor({ dailyLimitSats = 10_000_000 } = {}) {
    this._dailyLimitSats = dailyLimitSats;
    // agentId → { day: 'YYYY-MM-DD', total: number }
    this._spending = new Map();
  }

  _today() {
    return new Date().toISOString().slice(0, 10);
  }

  /**
   * Check if an agent can spend the given amount without exceeding the daily limit.
   * @param {string} agentId
   * @param {number} amountSats
   * @returns {{ allowed: boolean, remaining: number, daily_limit: number, spent_today: number }}
   */
  check(agentId, amountSats) {
    const today = this._today();
    const entry = this._spending.get(agentId);
    const spentToday = (entry && entry.day === today) ? entry.total : 0;
    const remaining = this._dailyLimitSats - spentToday;

    if (amountSats > remaining) {
      return {
        allowed: false,
        remaining: Math.max(0, remaining),
        daily_limit: this._dailyLimitSats,
        spent_today: spentToday,
      };
    }

    return {
      allowed: true,
      remaining: remaining - amountSats,
      daily_limit: this._dailyLimitSats,
      spent_today: spentToday,
    };
  }

  /**
   * Record that an agent spent sats. Call after the operation succeeds.
   * @param {string} agentId
   * @param {number} amountSats
   */
  record(agentId, amountSats) {
    const today = this._today();
    const entry = this._spending.get(agentId);
    if (!entry || entry.day !== today) {
      this._spending.set(agentId, { day: today, total: amountSats });
    } else {
      entry.total += amountSats;
    }
  }

  /**
   * Get current spending stats for an agent.
   */
  getStats(agentId) {
    const today = this._today();
    const entry = this._spending.get(agentId);
    const spentToday = (entry && entry.day === today) ? entry.total : 0;
    return {
      spent_today: spentToday,
      daily_limit: this._dailyLimitSats,
      remaining: Math.max(0, this._dailyLimitSats - spentToday),
    };
  }
}
