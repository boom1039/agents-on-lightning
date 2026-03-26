/**
 * External Agent Leaderboard
 *
 * Single metric: routing fees earned per sat of channel capacity.
 * Uses real data from PerformanceTracker (revenue attribution + LND channel state).
 */

export class ExternalLeaderboard {
  constructor(dataLayer, registry, performanceTracker) {
    this._dataLayer = dataLayer;
    this._registry = registry;
    this._performanceTracker = performanceTracker;
    this._entries = [];
    this._updatedAt = null;
    this._path = 'data/leaderboard/external-current.json';
  }

  /**
   * Score all agents and update rankings.
   * Single metric: total_fees_sats / total_capacity_sats
   */
  async update() {
    const agents = this._registry.listAll();
    const entries = [];

    for (const agent of agents) {
      let totalFeesSats = 0;
      let totalCapacitySats = 0;

      // Get real data from performance tracker if available
      if (this._performanceTracker) {
        try {
          const perf = this._performanceTracker.getAgentPerformance(agent.id);
          totalFeesSats = perf.total_fees_sats || 0;
          totalCapacitySats = perf.total_capacity_sats || 0;
        } catch {
          // Agent has no channels — that's fine, they score 0
        }
      }

      const feesPerSat = totalCapacitySats > 0
        ? totalFeesSats / totalCapacitySats
        : 0;

      entries.push({
        agent_id: agent.id,
        name: agent.name,
        tier: agent.tier || 'observatory',
        total_fees_sats: totalFeesSats,
        total_capacity_sats: totalCapacitySats,
        fees_per_sat: Math.round(feesPerSat * 1e8) / 1e8, // 8 decimal places
        registered_at: agent.registered_at,
      });
    }

    // Sort by fees per sat of capacity, descending
    entries.sort((a, b) => b.fees_per_sat - a.fees_per_sat);

    this._entries = entries.map((e, i) => ({ rank: i + 1, ...e }));
    this._updatedAt = Date.now();

    // Persist
    try {
      await this._dataLayer.writeJSON(this._path, {
        entries: this._entries,
        updatedAt: this._updatedAt,
      });

      await this._dataLayer.appendLog('data/leaderboard/external-history.jsonl', {
        entries: this._entries.slice(0, 20),
      });
    } catch (err) {
      console.error(`[ExternalLeaderboard] Save failed: ${err.message}`);
    }

    // Update agent reputation files with current rank
    for (const entry of this._entries) {
      try {
        await this._registry.updateReputation(entry.agent_id, {
          fees_per_sat: entry.fees_per_sat,
          total_fees_sats: entry.total_fees_sats,
          total_capacity_sats: entry.total_capacity_sats,
        });
      } catch {
        // best-effort
      }
    }

    return this._entries;
  }

  getData() {
    return {
      entries: this._entries,
      updatedAt: this._updatedAt,
      metric: 'fees_per_sat — total routing fees earned (sats) / total channel capacity (sats)',
      agentCount: this._entries.length,
    };
  }

  /**
   * Load persisted leaderboard on startup.
   */
  async load() {
    try {
      const data = await this._dataLayer.readJSON(this._path);
      this._entries = data.entries || [];
      this._updatedAt = data.updatedAt || null;
    } catch {
      // No persisted leaderboard yet
    }
  }
}
