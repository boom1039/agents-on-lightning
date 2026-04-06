/**
 * Revenue Attribution Tracker — Polls forwarding history, attributes fees
 * to managing agents, credits capital ledger.
 *
 * Attribution rule: 100% of the fee goes to the outbound channel's managing
 * agent. The outbound channel is where the fee policy was set.
 *
 * Msat accumulation: LND reports fees in msat. Sub-sat dust prevented by
 * accumulating msat per agent, crediting floor(total_msat / 1000) sats,
 * storing the remainder.
 *
 * State persisted to disk — survives Express restarts.
 */

const STATE_PATH = 'data/channel-market/revenue-attribution.json';
const CONFIG_PATH = 'data/channel-market/revenue-config.json';

const REVENUE_CONFIG = {
  pollIntervalMs: 120_000,    // 2 minutes
  maxEventsPerPoll: 1000,     // LND batch size
  lookbackSeconds: 86400,     // 24h on first poll
};

export class RevenueAttributionTracker {
  /**
   * @param {object} opts
   * @param {import('./capital-ledger.js').CapitalLedger} opts.capitalLedger
   * @param {import('../lnd/index.js').NodeManager} opts.nodeManager
   * @param {import('../data-layer.js').DataLayer} opts.dataLayer
   * @param {import('../channel-accountability/hash-chain-audit-log.js').HashChainAuditLog} opts.auditLog
   * @param {import('../channel-accountability/channel-assignment-registry.js').ChannelAssignmentRegistry} opts.assignmentRegistry
   * @param {{ acquire: (key: string) => Promise<() => void> }} opts.mutex
   */
  constructor({ capitalLedger, nodeManager, dataLayer, auditLog, assignmentRegistry, mutex }) {
    if (!capitalLedger) throw new Error('RevenueAttributionTracker requires capitalLedger');
    if (!nodeManager) throw new Error('RevenueAttributionTracker requires nodeManager');
    if (!dataLayer) throw new Error('RevenueAttributionTracker requires dataLayer');
    if (!auditLog) throw new Error('RevenueAttributionTracker requires auditLog');
    if (!assignmentRegistry) throw new Error('RevenueAttributionTracker requires assignmentRegistry');
    if (!mutex) throw new Error('RevenueAttributionTracker requires mutex');

    this._capitalLedger = capitalLedger;
    this._nodeManager = nodeManager;
    this._dataLayer = dataLayer;
    this._auditLog = auditLog;
    this._assignmentRegistry = assignmentRegistry;
    this._mutex = mutex;

    // Cursor: last processed forwarding event timestamp
    this._lastProcessedTimestamp = 0;
    this._lastProcessedIndex = 0;

    // Per-agent msat accumulation: agentId → pending_msat
    this._pendingMsat = {};

    // Per-channel revenue stats: chanId → { total_fees_msat, forward_count, last_forward_at }
    this._channelRevenue = {};

    // Per-agent total: agentId → { total_fees_msat, total_credited_sats, forward_count }
    this._agentRevenue = {};

    // Per-agent revenue config: agentId → { destination: 'capital' }
    this._revenueConfig = {};

    this._pollTimer = null;
    this._stopping = false;
    this.config = { ...REVENUE_CONFIG };
  }

  // ---------------------------------------------------------------------------
  // State persistence
  // ---------------------------------------------------------------------------

  async load() {
    try {
      const raw = await this._dataLayer.readJSON(STATE_PATH);
      if (raw) {
        this._lastProcessedTimestamp = raw._lastProcessedTimestamp || 0;
        this._lastProcessedIndex = raw._lastProcessedIndex || 0;
        this._pendingMsat = raw._pendingMsat || {};
        this._channelRevenue = raw._channelRevenue || {};
        this._agentRevenue = raw._agentRevenue || {};
      }
      console.log(
        `[RevenueTracker] Loaded state — cursor: ${this._lastProcessedTimestamp}, ` +
        `${Object.keys(this._channelRevenue).length} channels tracked`
      );
    } catch (err) {
      if (err.code === 'ENOENT') {
        console.log('[RevenueTracker] No existing state — starting fresh');
      } else {
        throw err;
      }
    }

    // Load revenue config
    try {
      const cfg = await this._dataLayer.readJSON(CONFIG_PATH);
      if (cfg) this._revenueConfig = cfg;
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }
  }

  async _persist() {
    const data = {
      _lastProcessedTimestamp: this._lastProcessedTimestamp,
      _lastProcessedIndex: this._lastProcessedIndex,
      _pendingMsat: this._pendingMsat,
      _channelRevenue: this._channelRevenue,
      _agentRevenue: this._agentRevenue,
    };
    await this._dataLayer.writeJSON(STATE_PATH, data);
  }

  async _persistConfig() {
    await this._dataLayer.writeJSON(CONFIG_PATH, this._revenueConfig);
  }

  // ---------------------------------------------------------------------------
  // Polling
  // ---------------------------------------------------------------------------

  startPolling(intervalMs = this.config.pollIntervalMs) {
    if (this._pollTimer) return;
    this._stopping = false;
    this._pollTimer = setInterval(() => this._pollCycle(), intervalMs);
    console.log(`[RevenueTracker] Polling every ${intervalMs / 1000}s`);
  }

  stopPolling() {
    this._stopping = true;
    if (this._pollTimer) {
      clearInterval(this._pollTimer);
      this._pollTimer = null;
    }
  }

  async _pollCycle() {
    try {
      await this._processForwards();
    } catch (err) {
      if (!this._stopping) {
        console.error(`[RevenueTracker] Poll error: ${err.message}`);
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Core: process forwarding events
  // ---------------------------------------------------------------------------

  async _processForwards() {
    const client = this._nodeManager.getScopedDefaultNodeOrNull('read');
    if (!client) return;

    const now = Math.floor(Date.now() / 1000);
    const startTime = this._lastProcessedTimestamp || (now - this.config.lookbackSeconds);

    let resp;
    try {
      resp = await client.forwardingHistory(
        startTime, now, this._lastProcessedIndex, this.config.maxEventsPerPoll
      );
    } catch (err) {
      if (!this._stopping) {
        console.error(`[RevenueTracker] forwardingHistory() failed: ${err.message}`);
      }
      return;
    }

    const events = resp.forwarding_events || [];
    if (events.length === 0) return;

    let credited = 0;
    let skipped = 0;

    for (const event of events) {
      const outChanId = event.chan_id_out;
      const feeMsat = parseInt(event.fee_msat || '0', 10);

      if (!outChanId || feeMsat <= 0) {
        skipped++;
        continue;
      }

      // Look up the assignment for the outbound channel
      const assignment = this._assignmentRegistry.getAssignment(outChanId);
      if (!assignment) {
        skipped++; // Not agent-managed — operator revenue
        continue;
      }

      const agentId = assignment.agent_id;

      // Update per-channel stats
      if (!this._channelRevenue[outChanId]) {
        this._channelRevenue[outChanId] = {
          total_fees_msat: 0, forward_count: 0, last_forward_at: 0, agent_id: agentId,
        };
      }
      this._channelRevenue[outChanId].total_fees_msat += feeMsat;
      this._channelRevenue[outChanId].forward_count++;
      this._channelRevenue[outChanId].last_forward_at = parseInt(event.timestamp || '0', 10);

      // Update per-agent stats
      if (!this._agentRevenue[agentId]) {
        this._agentRevenue[agentId] = { total_fees_msat: 0, total_credited_sats: 0, forward_count: 0 };
      }
      this._agentRevenue[agentId].total_fees_msat += feeMsat;
      this._agentRevenue[agentId].forward_count++;

      // Msat accumulation
      const pendingMsat = (this._pendingMsat[agentId] || 0) + feeMsat;
      const creditSats = Math.floor(pendingMsat / 1000);
      this._pendingMsat[agentId] = pendingMsat % 1000;

      if (creditSats > 0) {
        const reference = `forward:${event.timestamp || now}:${outChanId}`;
        try {
          await this._capitalLedger.creditRevenue(agentId, creditSats, reference);
          this._agentRevenue[agentId].total_credited_sats += creditSats;
          credited++;
        } catch (err) {
          console.error(`[RevenueTracker] creditRevenue failed for ${agentId}: ${err.message}`);
          // Put msat back to not lose it
          this._pendingMsat[agentId] += creditSats * 1000;
        }
      }
    }

    // Update cursor
    const lastEvent = events[events.length - 1];
    this._lastProcessedTimestamp = parseInt(lastEvent.timestamp || '0', 10) || now;
    this._lastProcessedIndex = parseInt(resp.last_offset_index || '0', 10);

    await this._persist();

    if (credited > 0 || skipped > 0) {
      console.log(
        `[RevenueTracker] Processed ${events.length} forwards: ` +
        `${credited} credited, ${skipped} skipped (non-agent)`
      );
    }
  }

  // ---------------------------------------------------------------------------
  // Revenue config
  // ---------------------------------------------------------------------------

  getRevenueConfig(agentId) {
    return this._revenueConfig[agentId] || { destination: 'capital' };
  }

  async setRevenueConfig(agentId, config) {
    const { destination } = config;
    if (destination !== 'capital') {
      return {
        success: false,
        error: 'Only "capital" destination is currently supported',
        hint: 'Cashu destination will be available when ecash reserve infrastructure ships.',
      };
    }

    this._revenueConfig[agentId] = { destination, updated_at: Date.now() };
    await this._persistConfig();

    return { success: true, config: this._revenueConfig[agentId] };
  }

  // ---------------------------------------------------------------------------
  // Query methods
  // ---------------------------------------------------------------------------

  getAgentRevenue(agentId) {
    const stats = this._agentRevenue[agentId] || {
      total_fees_msat: 0, total_credited_sats: 0, forward_count: 0,
    };
    const pending_msat = this._pendingMsat[agentId] || 0;
    const config = this.getRevenueConfig(agentId);

    // Find all channels for this agent
    const channels = [];
    for (const [chanId, rev] of Object.entries(this._channelRevenue)) {
      if (rev.agent_id === agentId) {
        channels.push({
          chan_id: chanId,
          total_fees_msat: rev.total_fees_msat,
          total_fees_sats: Math.floor(rev.total_fees_msat / 1000),
          forward_count: rev.forward_count,
          last_forward_at: rev.last_forward_at,
        });
      }
    }

    return {
      agent_id: agentId,
      total_fees_msat: stats.total_fees_msat,
      total_fees_sats: Math.floor(stats.total_fees_msat / 1000),
      total_credited_sats: stats.total_credited_sats,
      pending_msat,
      forward_count: stats.forward_count,
      destination: config.destination,
      channels,
      learn: stats.forward_count > 0
        ? `You have earned ${Math.floor(stats.total_fees_msat / 1000)} sats from ${stats.forward_count} forwards. ` +
          `Revenue is credited to your capital ledger. Sub-sat amounts accumulate until they reach 1 sat. ` +
          `You currently have ${pending_msat} pending msat.`
        : 'No routing revenue yet. Revenue is attributed when payments are forwarded through your outbound channels. ' +
          'Set competitive fees on your channels to attract routing traffic.',
    };
  }

  getChannelRevenue(chanId) {
    const rev = this._channelRevenue[chanId];
    if (!rev) {
      return {
        chan_id: chanId,
        total_fees_msat: 0,
        total_fees_sats: 0,
        forward_count: 0,
        last_forward_at: 0,
        learn: 'No revenue recorded for this channel. Revenue is attributed when payments are ' +
          'forwarded through your outbound channels.',
      };
    }

    return {
      chan_id: chanId,
      agent_id: rev.agent_id,
      total_fees_msat: rev.total_fees_msat,
      total_fees_sats: Math.floor(rev.total_fees_msat / 1000),
      forward_count: rev.forward_count,
      last_forward_at: rev.last_forward_at,
    };
  }

  getAllAgentRevenue() {
    return { ...this._agentRevenue };
  }

  getTotalRevenue() {
    let totalMsat = 0;
    let totalForwards = 0;
    for (const stats of Object.values(this._agentRevenue)) {
      totalMsat += stats.total_fees_msat;
      totalForwards += stats.forward_count;
    }
    return {
      total_fees_msat: totalMsat,
      total_fees_sats: Math.floor(totalMsat / 1000),
      total_forwards: totalForwards,
      agents_with_revenue: Object.keys(this._agentRevenue).length,
    };
  }
}
