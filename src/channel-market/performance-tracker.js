/**
 * Performance Tracker — Channel performance dashboard for agents.
 *
 * Aggregates revenue attribution, LND channel state, uptime tracking,
 * and fee policies into unified performance views. Supports agent
 * leaderboards and daily snapshots.
 *
 * Plan G: Performance Dashboard
 */

import { classifyBalanceHealth } from './lnd-cache.js';

const UPTIME_PATH = 'data/channel-market/performance-uptime.json';
const DAILY_PATH = 'data/channel-market/performance-daily.jsonl';

export class PerformanceTracker {
  /**
   * @param {object} opts
   * @param {import('../data-layer.js').DataLayer} opts.dataLayer
   * @param {import('../channel-accountability/channel-assignment-registry.js').ChannelAssignmentRegistry} opts.assignmentRegistry
   * @param {import('./revenue-attribution-tracker.js').RevenueAttributionTracker} opts.revenueTracker
   * @param {import('./lnd-cache.js').LndCache} opts.lndCache
   * @param {import('../identity/registry.js').AgentRegistry} opts.agentRegistry
   */
  constructor({ dataLayer, assignmentRegistry, revenueTracker, lndCache, agentRegistry }) {
    if (!dataLayer) throw new Error('PerformanceTracker requires dataLayer');
    if (!assignmentRegistry) throw new Error('PerformanceTracker requires assignmentRegistry');
    if (!revenueTracker) throw new Error('PerformanceTracker requires revenueTracker');
    if (!lndCache) throw new Error('PerformanceTracker requires lndCache');
    if (!agentRegistry) throw new Error('PerformanceTracker requires agentRegistry');

    this._dataLayer = dataLayer;
    this._assignmentRegistry = assignmentRegistry;
    this._revenueTracker = revenueTracker;
    this._lndCache = lndCache;
    this._agentRegistry = agentRegistry;

    // Uptime counters: channel_point → { total_samples, active_samples, last_seen_active, last_seen_inactive, tracking_since }
    this._uptimeCounters = {};

    this._uptimeTimer = null;
    this._dailyTimer = null;
    this._stopping = false;
  }

  // ---------------------------------------------------------------------------
  // State persistence
  // ---------------------------------------------------------------------------

  async load() {
    try {
      const raw = await this._dataLayer.readRuntimeStateJSON(UPTIME_PATH, { defaultValue: {} });
      if (raw && raw._uptimeCounters) {
        this._uptimeCounters = raw._uptimeCounters;
      }
      console.log(
        `[PerformanceTracker] Loaded uptime counters for ${Object.keys(this._uptimeCounters).length} channels`
      );
    } catch (err) {
      if (err.code === 'ENOENT') {
        console.log('[PerformanceTracker] No existing uptime state — starting fresh');
      } else {
        throw err;
      }
    }
  }

  async _persist() {
    await this._dataLayer.writeJSON(UPTIME_PATH, {
      _uptimeCounters: this._uptimeCounters,
      _persisted_at: Date.now(),
    });
  }

  // ---------------------------------------------------------------------------
  // Polling (uptime + daily snapshot)
  // ---------------------------------------------------------------------------

  startPolling(intervalMs = 30_000) {
    if (this._uptimeTimer) return;
    this._stopping = false;
    this._uptimeTimer = setInterval(() => this._recordUptimeSamples(), intervalMs);
    console.log(`[PerformanceTracker] Uptime polling every ${intervalMs / 1000}s`);
    this._scheduleDailySnapshot();
  }

  stopPolling() {
    this._stopping = true;
    if (this._uptimeTimer) {
      clearInterval(this._uptimeTimer);
      this._uptimeTimer = null;
    }
    if (this._dailyTimer) {
      clearTimeout(this._dailyTimer);
      this._dailyTimer = null;
    }
  }

  _scheduleDailySnapshot() {
    const now = new Date();
    const nextMidnight = new Date(Date.UTC(
      now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1, 0, 0, 0
    ));
    const delayMs = nextMidnight.getTime() - now.getTime();

    this._dailyTimer = setTimeout(() => {
      this._snapshotDaily();
      // Re-schedule for next day
      this._dailyTimer = setInterval(() => this._snapshotDaily(), 86400_000);
    }, delayMs);

    console.log(`[PerformanceTracker] Daily snapshot scheduled in ${Math.round(delayMs / 60000)}min`);
  }

  // ---------------------------------------------------------------------------
  // Uptime sampling
  // ---------------------------------------------------------------------------

  async _recordUptimeSamples() {
    try {
      const channels = await this._lndCache.getChannels();
      const assignedPoints = this._assignmentRegistry.getAssignedChannelPoints();
      const now = Date.now();

      for (const ch of channels) {
        if (!ch.channel_point || !assignedPoints.has(ch.channel_point)) continue;

        if (!this._uptimeCounters[ch.channel_point]) {
          this._uptimeCounters[ch.channel_point] = {
            total_samples: 0,
            active_samples: 0,
            last_seen_active: 0,
            last_seen_inactive: 0,
            tracking_since: now,
          };
        }

        const counter = this._uptimeCounters[ch.channel_point];
        counter.total_samples++;

        if (ch.active !== false) {
          counter.active_samples++;
          counter.last_seen_active = now;
        } else {
          counter.last_seen_inactive = now;
        }
      }

      await this._persist();
    } catch (err) {
      if (!this._stopping) {
        console.error(`[PerformanceTracker] Uptime sample error: ${err.message}`);
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Channel performance
  // ---------------------------------------------------------------------------

  async getChannelPerformance(chanId, agentId) {
    // Get assignment for this channel
    const assignment = this._assignmentRegistry.getAssignment(chanId);

    // Authorization: agent can only see their own channels
    if (assignment && assignment.agent_id !== agentId) {
      return { success: false, error: 'Channel not found', status: 404 };
    }

    // Revenue data
    const revenue = this._revenueTracker.getChannelRevenue(chanId);

    // LND channel data
    const channels = await this._lndCache.getChannels();
    const feeReport = await this._lndCache.getFeeReport();

    const lndCh = channels.find(c => c.chan_id === chanId);
    const channelPoint = assignment?.channel_point || lndCh?.channel_point;

    // Fee policy
    const feeByPoint = new Map();
    for (const f of feeReport) {
      if (f.channel_point) feeByPoint.set(f.channel_point, f);
    }
    const fee = channelPoint ? feeByPoint.get(channelPoint) : null;

    // Balance info
    const localBalance = lndCh ? parseInt(lndCh.local_balance || '0', 10) : 0;
    const remoteBalance = lndCh ? parseInt(lndCh.remote_balance || '0', 10) : 0;
    const capacity = lndCh ? parseInt(lndCh.capacity || '0', 10) : (assignment?.capacity || 0);
    const balanceHealth = classifyBalanceHealth(localBalance, capacity);

    // Uptime
    const uptimeCounter = channelPoint ? this._uptimeCounters[channelPoint] : null;
    const uptimePct = uptimeCounter && uptimeCounter.total_samples > 0
      ? Math.round((uptimeCounter.active_samples / uptimeCounter.total_samples) * 10000) / 100
      : null;

    // Management duration
    const managedSinceMs = assignment?.assigned_at || null;
    const managedDurationHours = managedSinceMs
      ? Math.round((Date.now() - managedSinceMs) / 3600_000)
      : null;

    return {
      chan_id: chanId,
      channel_point: channelPoint || null,
      active: lndCh ? lndCh.active !== false : false,
      capacity_sats: capacity,
      local_balance_sats: localBalance,
      remote_balance_sats: remoteBalance,
      balance_health: balanceHealth,
      base_fee_msat: fee ? parseInt(fee.base_fee_msat || '0', 10) : null,
      fee_rate_ppm: fee ? parseInt(fee.fee_per_mil || '0', 10) : null,
      total_fees_sats: revenue.total_fees_sats,
      forward_count: revenue.forward_count,
      last_forward_at: revenue.last_forward_at,
      uptime_pct: uptimePct,
      uptime_samples: uptimeCounter?.total_samples || 0,
      managed_since: managedSinceMs,
      managed_duration_hours: managedDurationHours,
      learn: `Channel ${chanId}: ${balanceHealth} balance (${localBalance.toLocaleString()}/${capacity.toLocaleString()} sats local). ` +
        `${revenue.forward_count} forwards earning ${revenue.total_fees_sats} sats. ` +
        (uptimePct !== null ? `${uptimePct}% uptime over ${uptimeCounter.total_samples} samples. ` : '') +
        'Balance health indicates routing potential — balanced channels route in both directions.',
    };
  }

  // ---------------------------------------------------------------------------
  // Agent performance (aggregate)
  // ---------------------------------------------------------------------------

  async getAgentPerformance(agentId) {
    const agentChannels = this._assignmentRegistry.getByAgent(agentId);
    const agentRevenue = this._revenueTracker.getAgentRevenue(agentId);

    const channels = await this._lndCache.getChannels();
    const lndByPoint = new Map();
    for (const c of channels) {
      if (c.channel_point) lndByPoint.set(c.channel_point, c);
    }

    const channelSummaries = [];
    let totalCapacity = 0;
    let totalLocal = 0;
    let totalUptimeSamples = 0;
    let totalActiveSamples = 0;

    for (const assignment of agentChannels) {
      const lndCh = lndByPoint.get(assignment.channel_point);
      const capacity = assignment.capacity || (lndCh ? parseInt(lndCh.capacity || '0', 10) : 0);
      const localBalance = lndCh ? parseInt(lndCh.local_balance || '0', 10) : 0;
      const balanceHealth = classifyBalanceHealth(localBalance, capacity);

      totalCapacity += capacity;
      totalLocal += localBalance;

      const uptimeCounter = this._uptimeCounters[assignment.channel_point];
      if (uptimeCounter) {
        totalUptimeSamples += uptimeCounter.total_samples;
        totalActiveSamples += uptimeCounter.active_samples;
      }

      const chanRevenue = this._revenueTracker.getChannelRevenue(assignment.chan_id);

      channelSummaries.push({
        chan_id: assignment.chan_id,
        channel_point: assignment.channel_point,
        peer_pubkey: assignment.remote_pubkey,
        capacity_sats: capacity,
        local_balance_sats: localBalance,
        balance_health: balanceHealth,
        active: lndCh ? lndCh.active !== false : false,
        total_fees_sats: chanRevenue.total_fees_sats,
        forward_count: chanRevenue.forward_count,
      });
    }

    const avgUptimePct = totalUptimeSamples > 0
      ? Math.round((totalActiveSamples / totalUptimeSamples) * 10000) / 100
      : null;

    return {
      agent_id: agentId,
      total_channels: agentChannels.length,
      total_capacity_sats: totalCapacity,
      total_local_balance_sats: totalLocal,
      total_fees_sats: agentRevenue.total_fees_sats,
      total_forwards: agentRevenue.forward_count,
      average_uptime_pct: avgUptimePct,
      channels: channelSummaries,
      learn: agentChannels.length > 0
        ? `You manage ${agentChannels.length} channel(s) with ${totalCapacity.toLocaleString()} sats total capacity. ` +
          `Earned ${agentRevenue.total_fees_sats} sats from ${agentRevenue.forward_count} forwards. ` +
          (avgUptimePct !== null ? `Average uptime: ${avgUptimePct}%. ` : '') +
          'Keep channels balanced and active to maximize routing revenue.'
        : 'No channels assigned yet. Open channels via POST /api/v1/market/open to start earning routing fees.',
    };
  }

  // ---------------------------------------------------------------------------
  // Leaderboard
  // ---------------------------------------------------------------------------

  getLeaderboard(metric = 'fees', limit = 10) {
    const validMetrics = ['fees', 'forwards', 'uptime'];
    if (!validMetrics.includes(metric)) {
      return { success: false, error: `Invalid metric. Must be one of: ${validMetrics.join(', ')}`, status: 400 };
    }

    limit = Math.min(Math.max(1, parseInt(limit, 10) || 10), 50);

    const allAgentRevenue = this._revenueTracker.getAllAgentRevenue();
    const allAssignments = this._assignmentRegistry.getAllAssignments();

    // Collect unique agent IDs from both revenue and assignments
    const agentIds = new Set([
      ...Object.keys(allAgentRevenue),
      ...allAssignments.map(a => a.agent_id),
    ]);

    const entries = [];

    for (const agentId of agentIds) {
      const profile = this._agentRegistry.getById(agentId);
      const revenue = allAgentRevenue[agentId] || { total_fees_msat: 0, forward_count: 0 };
      const agentAssignments = this._assignmentRegistry.getByAgent(agentId);

      // Compute uptime
      let totalSamples = 0;
      let activeSamples = 0;
      for (const a of agentAssignments) {
        const counter = this._uptimeCounters[a.channel_point];
        if (counter) {
          totalSamples += counter.total_samples;
          activeSamples += counter.active_samples;
        }
      }
      const uptimePct = totalSamples > 0
        ? Math.round((activeSamples / totalSamples) * 10000) / 100
        : 0;

      entries.push({
        agent_id: agentId,
        agent_name: profile?.name || 'Unknown',
        channels: agentAssignments.length,
        total_fees_sats: Math.floor((revenue.total_fees_msat || 0) / 1000),
        forward_count: revenue.forward_count || 0,
        uptime_pct: uptimePct,
      });
    }

    // Sort by metric
    if (metric === 'fees') {
      entries.sort((a, b) => b.total_fees_sats - a.total_fees_sats);
    } else if (metric === 'forwards') {
      entries.sort((a, b) => b.forward_count - a.forward_count);
    } else {
      entries.sort((a, b) => b.uptime_pct - a.uptime_pct);
    }

    const ranked = entries.slice(0, limit).map((e, i) => ({ rank: i + 1, ...e }));

    return {
      metric,
      rankings: ranked,
      total_agents: entries.length,
      learn: `Agent leaderboard ranked by ${metric}. ` +
        (ranked.length > 0
          ? `Top agent: ${ranked[0].agent_name} with ${metric === 'fees' ? ranked[0].total_fees_sats + ' sats' : metric === 'forwards' ? ranked[0].forward_count + ' forwards' : ranked[0].uptime_pct + '% uptime'}.`
          : 'No agents ranked yet.'),
    };
  }

  // ---------------------------------------------------------------------------
  // Daily snapshot
  // ---------------------------------------------------------------------------

  async _snapshotDaily() {
    try {
      const assignments = this._assignmentRegistry.getAllAssignments();
      const channels = await this._lndCache.getChannels();
      const lndByPoint = new Map();
      for (const c of channels) {
        if (c.channel_point) lndByPoint.set(c.channel_point, c);
      }

      const date = new Date().toISOString().slice(0, 10);
      let count = 0;

      for (const assignment of assignments) {
        const lndCh = lndByPoint.get(assignment.channel_point);
        const localBalance = lndCh ? parseInt(lndCh.local_balance || '0', 10) : 0;
        const capacity = assignment.capacity || (lndCh ? parseInt(lndCh.capacity || '0', 10) : 0);
        const uptimeCounter = this._uptimeCounters[assignment.channel_point];
        const revenue = this._revenueTracker.getChannelRevenue(assignment.chan_id);

        await this._dataLayer.appendLog(DAILY_PATH, {
          date,
          agent_id: assignment.agent_id,
          chan_id: assignment.chan_id,
          channel_point: assignment.channel_point,
          capacity_sats: capacity,
          local_balance_sats: localBalance,
          balance_health: classifyBalanceHealth(localBalance, capacity),
          active: lndCh ? lndCh.active !== false : false,
          total_fees_sats: revenue.total_fees_sats,
          forward_count: revenue.forward_count,
          uptime_pct: uptimeCounter && uptimeCounter.total_samples > 0
            ? Math.round((uptimeCounter.active_samples / uptimeCounter.total_samples) * 10000) / 100
            : null,
          uptime_samples: uptimeCounter?.total_samples || 0,
        });
        count++;
      }

      // Reset uptime counters for fresh daily tracking
      for (const key of Object.keys(this._uptimeCounters)) {
        this._uptimeCounters[key].total_samples = 0;
        this._uptimeCounters[key].active_samples = 0;
      }
      await this._persist();

      console.log(`[PerformanceTracker] Daily snapshot: ${count} channels recorded for ${date}`);
    } catch (err) {
      if (!this._stopping) {
        console.error(`[PerformanceTracker] Daily snapshot error: ${err.message}`);
      }
    }
  }
}
