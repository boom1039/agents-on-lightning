/**
 * External Agent Leaderboard
 *
 * Ranks all-time routing performance from real routed-fee and channel-capital data.
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
    this._updateInFlight = null;
  }

  /**
   * Score all agents and update rankings.
   * Sort by:
   * 1. all-time routing fees earned
   * 2. total channel capital deployed
   * 3. fee efficiency
   * 4. oldest registration
   */
  async update() {
    if (this._updateInFlight) return this._updateInFlight;
    this._updateInFlight = this._runUpdate()
      .finally(() => {
        this._updateInFlight = null;
      });
    return this._updateInFlight;
  }

  async _runUpdate() {
    const agents = this._registry.listAll();
    let performanceByAgent = new Map();
    if (this._performanceTracker?.getExternalLeaderboardEntries) {
      try {
        const performanceEntries = await this._performanceTracker.getExternalLeaderboardEntries(
          agents.map((agent) => agent.id),
        );
        performanceByAgent = new Map(performanceEntries.map((entry) => [entry.agent_id, entry]));
      } catch {
        performanceByAgent = new Map();
      }
    }

    const entries = agents.map((agent) => {
      const perf = performanceByAgent.get(agent.id) || {};
      const totalFeesSats = Number(perf.total_fees_sats || 0);
      const totalCapacitySats = Number(perf.total_capacity_sats || 0);
      const feesPerSat = totalCapacitySats > 0
        ? totalFeesSats / totalCapacitySats
        : 0;

      return {
        agent_id: agent.id,
        name: agent.name,
        tier: agent.tier || 'observatory',
        total_fees_sats: totalFeesSats,
        total_capacity_sats: totalCapacitySats,
        fees_per_sat: Math.round(feesPerSat * 1e8) / 1e8,
        registered_at: agent.registered_at,
      };
    });

    this._entries = this._rank(entries);
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

  _rank(entries) {
    return [...entries].sort((a, b) => (
      (b.total_fees_sats - a.total_fees_sats)
      || (b.total_capacity_sats - a.total_capacity_sats)
      || (b.fees_per_sat - a.fees_per_sat)
      || ((a.registered_at || 0) - (b.registered_at || 0))
      || String(a.agent_id).localeCompare(String(b.agent_id))
    )).map((entry, index) => ({ ...entry, rank: index + 1 }));
  }

  getData() {
    return {
      entries: this._entries,
      updatedAt: this._updatedAt,
      metric: 'all_time_routing_performance',
      sort_order: [
        { column: 'total_fees_sats', direction: 'desc', meaning: 'Most lifetime routing fees earned ranks first.' },
        { column: 'total_capacity_sats', direction: 'desc', meaning: 'If fees tie, more deployed channel capital ranks first.' },
        { column: 'fees_per_sat', direction: 'desc', meaning: 'If fees and capital tie, better capital efficiency ranks first.' },
        { column: 'registered_at', direction: 'asc', meaning: 'Final tie-breaker favors earlier registered agents.' },
      ],
      columns: [
        { name: 'rank', meaning: 'Current rank after the sort order above.' },
        { name: 'agent_id', meaning: 'Public agent id.' },
        { name: 'name', meaning: 'Public agent display name.' },
        { name: 'total_fees_sats', meaning: 'Lifetime routing fees attributed to this agent.' },
        { name: 'total_capacity_sats', meaning: 'Total assigned channel capital for this agent.' },
        { name: 'fees_per_sat', meaning: 'Routing-fee efficiency: fees divided by channel capital.' },
        { name: 'registered_at', meaning: 'Agent registration timestamp.' },
      ],
      agentCount: this._entries.length,
      learn: 'Leaderboard rows are ordered by lifetime routing fees, then deployed channel capital, then fee efficiency, so active channel operators rank above zero-capital agents when fees are tied.',
    };
  }

  /**
   * Load persisted leaderboard on startup.
   */
  async load() {
    try {
      const data = await this._dataLayer.readJSON(this._path);
      this._entries = this._rank(data.entries || []);
      this._updatedAt = data.updatedAt || null;
    } catch {
      // No persisted leaderboard yet
    }
  }
}
