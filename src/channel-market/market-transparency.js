/**
 * Market Transparency — Public market data endpoints.
 *
 * Aggregates data from assignment registry, LND, and agent registry
 * to serve public market information. No auth required (rate limited).
 *
 * Privacy boundary:
 *   PUBLIC:  channel assignments, fee policies, forward counts, capacity, agent profiles
 *   PRIVATE: capital balances, deposit addresses, Cashu wallet, withdrawal history
 */

import { classifyBalanceHealth } from './lnd-cache.js';

export class MarketTransparency {
  /**
   * @param {object} opts
   * @param {import('../channel-accountability/channel-assignment-registry.js').ChannelAssignmentRegistry} opts.assignmentRegistry
   * @param {import('../identity/registry.js').AgentRegistry} opts.agentRegistry
   * @param {import('./lnd-cache.js').LndCache} opts.lndCache
   * @param {import('./revenue-attribution-tracker.js').RevenueAttributionTracker} [opts.revenueTracker]
   * @param {import('../channel-accountability/hash-chain-audit-log.js').HashChainAuditLog} [opts.auditLog]
   */
  constructor({ assignmentRegistry, agentRegistry, lndCache, revenueTracker, auditLog }) {
    if (!assignmentRegistry) throw new Error('MarketTransparency requires assignmentRegistry');
    if (!agentRegistry) throw new Error('MarketTransparency requires agentRegistry');
    if (!lndCache) throw new Error('MarketTransparency requires lndCache');

    this._assignmentRegistry = assignmentRegistry;
    this._agentRegistry = agentRegistry;
    this._lndCache = lndCache;
    this._revenueTracker = revenueTracker || null;
    this._auditLog = auditLog || null;
  }

  // ---------------------------------------------------------------------------
  // Market Overview
  // ---------------------------------------------------------------------------

  async getOverview() {
    const assignments = this._assignmentRegistry.getAllAssignments();
    const channels = await this._lndCache.getChannels();

    // Unique agents with channels
    const agentIds = new Set(assignments.map(a => a.agent_id));

    // Total capacity of agent-managed channels
    let totalCapacity = 0;
    for (const a of assignments) {
      totalCapacity += a.capacity || 0;
    }

    // Revenue stats (if tracker available)
    const revenueStats = this._revenueTracker
      ? this._revenueTracker.getTotalRevenue()
      : { total_fees_sats: 0, total_forwards: 0 };

    const avgChannelSize = assignments.length > 0
      ? Math.round(totalCapacity / assignments.length)
      : 0;

    const registeredAgents = this._agentRegistry.count();

    return {
      registered_agents: registeredAgents,
      total_agents: agentIds.size,
      total_channels: assignments.length,
      total_capacity_sats: totalCapacity,
      average_channel_size_sats: avgChannelSize,
      total_revenue_sats: revenueStats.total_fees_sats,
      total_forwards: revenueStats.total_forwards,
      total_node_channels: channels.length,
      learn: `${registeredAgents.toLocaleString()} agents registered on the platform. ` +
        `The channel market has ${agentIds.size} active agent(s) managing ` +
        `${assignments.length} channel(s) with ${totalCapacity.toLocaleString()} sats total capacity. ` +
        `${revenueStats.total_forwards} forwards have generated ${revenueStats.total_fees_sats.toLocaleString()} sats in fees.`,
    };
  }

  // ---------------------------------------------------------------------------
  // All Agent Channels (paginated)
  // ---------------------------------------------------------------------------

  async getChannels({ limit = 50, offset = 0 } = {}) {
    const assignments = this._assignmentRegistry.getAllAssignments();
    const channels = await this._lndCache.getChannels();
    const feeReport = await this._lndCache.getFeeReport();

    // Build fee lookup by chan_id
    const feeByPoint = new Map();
    for (const f of feeReport) {
      if (f.channel_point) feeByPoint.set(f.channel_point, f);
    }

    // Build LND channel lookup by channel_point
    const lndByPoint = new Map();
    for (const c of channels) {
      if (c.channel_point) lndByPoint.set(c.channel_point, c);
    }

    const results = assignments.map(a => {
      const lndCh = lndByPoint.get(a.channel_point);
      const fee = feeByPoint.get(a.channel_point);
      const agentProfile = this._agentRegistry.getById(a.agent_id);

      const localBalance = lndCh ? parseInt(lndCh.local_balance || '0', 10) : 0;
      const capacity = a.capacity || (lndCh ? parseInt(lndCh.capacity || '0', 10) : 0);

      return {
        agent_id: a.agent_id,
        agent_name: agentProfile?.name || 'Unknown',
        channel_point: a.channel_point,
        chan_id: a.chan_id,
        peer_pubkey: a.remote_pubkey,
        capacity_sats: capacity,
        balance_health: classifyBalanceHealth(localBalance, capacity),
        base_fee_msat: fee ? parseInt(fee.base_fee_msat || '0', 10) : null,
        fee_rate_ppm: fee ? parseInt(fee.fee_per_mil || '0', 10) : null,
        active: lndCh ? lndCh.active !== false : false,
        assigned_at: a.assigned_at,
      };
    });

    // Sort by assigned_at descending (newest first)
    results.sort((a, b) => (b.assigned_at || 0) - (a.assigned_at || 0));

    const paginated = results.slice(offset, offset + limit);
    return {
      channels: paginated,
      total: results.length,
      limit,
      offset,
      has_more: offset + limit < results.length,
    };
  }

  // ---------------------------------------------------------------------------
  // Agent Public Profile
  // ---------------------------------------------------------------------------

  async getAgentProfile(agentId) {
    const profile = this._agentRegistry.getById(agentId);
    if (!profile) {
      return { success: false, error: 'Agent not found', status: 404 };
    }

    const agentChannels = this._assignmentRegistry.getByAgent(agentId);
    const revenueStats = this._revenueTracker
      ? this._revenueTracker.getAgentRevenue(agentId)
      : { total_fees_sats: 0, forward_count: 0 };

    return {
      agent_id: agentId,
      name: profile.name || 'Unknown',
      badge: profile.badge || null,
      registered_at: profile.registered_at || null,
      channels_count: agentChannels.length,
      total_revenue_sats: revenueStats.total_fees_sats || Math.floor((revenueStats.total_fees_msat || 0) / 1000),
      total_forwards: revenueStats.forward_count || 0,
      // Privacy: do NOT expose capital balances, deposit addresses, Cashu wallet
    };
  }

  // ---------------------------------------------------------------------------
  // Peer Safety
  // ---------------------------------------------------------------------------

  async getPeerSafety(pubkey) {
    if (!pubkey || typeof pubkey !== 'string' || pubkey.length !== 66) {
      return { success: false, error: 'Invalid pubkey (expected 66-char hex)', status: 400 };
    }

    const assignments = this._assignmentRegistry.getAllAssignments();
    const channelsToThisPeer = assignments.filter(a => a.remote_pubkey === pubkey);
    const closedChannels = await this._lndCache.getClosedChannels();

    // Count force closes involving this peer
    const peerForceCloses = closedChannels.filter(
      c => c.remote_pubkey === pubkey &&
        (c.close_type === 'REMOTE_FORCE_CLOSE' || c.close_type === 'LOCAL_FORCE_CLOSE')
    ).length;

    let totalCapacity = 0;
    for (const ch of channelsToThisPeer) {
      totalCapacity += ch.capacity || 0;
    }

    const warnings = [];
    if (peerForceCloses > 0) {
      warnings.push(`${peerForceCloses} force close(s) involving this peer`);
    }

    // Get peer info from LND
    let peerAlias = null;
    const info = await this._lndCache.getNodeInfo(pubkey);
    if (info) {
      peerAlias = info?.node?.alias || null;
    }

    return {
      peer_pubkey: pubkey,
      peer_alias: peerAlias,
      agents_with_channels: channelsToThisPeer.length,
      total_capacity_sats: totalCapacity,
      force_closes: peerForceCloses,
      warnings,
      safe: warnings.length === 0,
      learn: warnings.length > 0
        ? `This peer has ${peerForceCloses} force close(s). Force closes are expensive ` +
          `(higher on-chain fees, delayed fund return). Consider this when choosing peers.`
        : 'No warnings for this peer. Clean history.',
    };
  }

  // ---------------------------------------------------------------------------
  // Fee Competition
  // ---------------------------------------------------------------------------

  async getFeeCompetition(peerPubkey) {
    if (!peerPubkey || typeof peerPubkey !== 'string' || peerPubkey.length !== 66) {
      return { success: false, error: 'Invalid pubkey (expected 66-char hex)', status: 400 };
    }

    const assignments = this._assignmentRegistry.getAllAssignments();
    const channelsToThisPeer = assignments.filter(a => a.remote_pubkey === peerPubkey);

    if (channelsToThisPeer.length === 0) {
      return {
        peer_pubkey: peerPubkey,
        channels: [],
        count: 0,
        learn: 'No agent channels to this peer. You would be the first!',
      };
    }

    const feeReport = await this._lndCache.getFeeReport();
    const feeByPoint = new Map();
    for (const f of feeReport) {
      if (f.channel_point) feeByPoint.set(f.channel_point, f);
    }

    const results = channelsToThisPeer.map(a => {
      const fee = feeByPoint.get(a.channel_point);
      const agentProfile = this._agentRegistry.getById(a.agent_id);
      return {
        agent_id: a.agent_id,
        agent_name: agentProfile?.name || 'Unknown',
        channel_point: a.channel_point,
        capacity_sats: a.capacity || 0,
        base_fee_msat: fee ? parseInt(fee.base_fee_msat || '0', 10) : null,
        fee_rate_ppm: fee ? parseInt(fee.fee_per_mil || '0', 10) : null,
      };
    });

    return {
      peer_pubkey: peerPubkey,
      channels: results,
      count: results.length,
      learn: `${results.length} agent(s) have channels to this peer. ` +
        'Compare fee rates to set competitive pricing. ' +
        'Lower fees attract more routing volume but earn less per forward.',
    };
  }
}
