/**
 * Channel Opener — Validates, locks, opens, polls, and assigns Lightning channels.
 *
 * Handles the full lifecycle of agent-initiated channel opens:
 *   1. 12-step fail-fast validation pipeline (Ed25519 signed requests)
 *   2. Capital lock via CapitalLedger
 *   3. Peer connection + LND openChannel call
 *   4. Background polling: pending_open → active (auto-assign)
 *   5. Crash recovery: "submitting" entries reconciled on restart
 *
 * State persisted to disk — survives Express restarts.
 * Follows deposit-tracker pattern for state management.
 */

import { DedupCache } from '../channel-accountability/dedup-cache.js';
import { validateSignedInstruction } from '../channel-accountability/signed-instruction-validation.js';

const STATE_PATH = 'data/channel-market/pending-opens.json';

const CHANNEL_OPEN_CONFIG = {
  minChannelSizeSats: 100_000,
  maxChannelSizeSats: 500_000_000,     // 5 BTC — wumbo channels enabled
  maxTotalChannels: Infinity,
  maxPerAgent: Infinity,
  requiredConfirmations: 3,
  pendingOpenTimeoutBlocks: 2016,      // ~2 weeks
  connectPeerTimeoutMs: 15_000,
  defaultSatPerVbyte: null,            // null = let LND estimate
};

/**
 * LND error messages → agent-friendly explanations.
 */
const LND_ERROR_MAP = [
  {
    pattern: /not enough witness outputs to create funding transaction/i,
    message: "Node operator's wallet has insufficient funds for the mining fee. This is infrastructure, not your balance. Try later.",
  },
  {
    pattern: /peer is not connected|peer not online|unable to locate/i,
    message: 'Could not connect to peer. The node may be offline or unreachable.',
  },
  {
    pattern: /wallet is fully synced/i,
    message: 'Node is syncing. Try again in a few minutes.',
  },
  {
    pattern: /pending channels exceed maximum/i,
    message: 'Too many channels pending confirmation. Wait for current opens to confirm.',
  },
  {
    pattern: /chan size.*below min chan size/i,
    message: `Channel too small. Minimum: ${CHANNEL_OPEN_CONFIG.minChannelSizeSats} sats.`,
  },
];

function mapLndError(errMsg) {
  for (const { pattern, message } of LND_ERROR_MAP) {
    if (pattern.test(errMsg)) return message;
  }
  // Sanitize: strip internal paths, keep useful info
  return `Channel open failed: ${errMsg.replace(/\/[^\s]+/g, '[path]')}`;
}

/**
 * Educational hints for validation failures.
 */
const HINTS = {
  missing_payload:
    'Send { "instruction": { "action": "channel_open", ... }, "signature": "hex" }. ' +
    'The instruction must contain action, agent_id, timestamp, and params.',

  wrong_action:
    'Only "channel_open" accepted at this endpoint. ' +
    'For fee policy changes, use POST /api/v1/channels/instruct.',

  push_amount_rejected:
    'push_amount_sats gifts sats to the remote peer irrevocably the moment the channel opens. ' +
    'This is almost never what you want — it gives away your capital. Set to 0 or omit entirely.',

  amount_out_of_bounds: (min, max) =>
    `Channel size must be between ${min.toLocaleString()} and ${max.toLocaleString()} sats.`,

  insufficient_balance: (available, requested) =>
    `Your available capital is ${available.toLocaleString()} sats, but you requested ${requested.toLocaleString()} sats. ` +
    'Deposit more Bitcoin via POST /api/v1/capital/deposit-address.',

  channel_count_limit: (current, limit, scope) =>
    `${scope} channel limit: ${current}/${limit}. ` +
    'Close an existing channel or wait for the operator to raise the limit.',

  peer_not_in_graph:
    'Peer not found in the Lightning Network graph. ' +
    'Verify the pubkey is correct (66 hex chars). The node must be online and have announced itself.',
};

export class ChannelOpener {
  /**
   * @param {object} opts
   * @param {import('./capital-ledger.js').CapitalLedger} opts.capitalLedger
   * @param {import('../lnd/index.js').NodeManager} opts.nodeManager
   * @param {import('../data-layer.js').DataLayer} opts.dataLayer
   * @param {import('../channel-accountability/hash-chain-audit-log.js').HashChainAuditLog} opts.auditLog
   * @param {import('../identity/registry.js').AgentRegistry} opts.agentRegistry
   * @param {import('../channel-accountability/channel-assignment-registry.js').ChannelAssignmentRegistry} opts.assignmentRegistry
   * @param {{ acquire: (key: string) => Promise<() => void> }} opts.mutex
   */
  constructor({ capitalLedger, nodeManager, dataLayer, auditLog, agentRegistry, assignmentRegistry, mutex }) {
    if (!capitalLedger) throw new Error('ChannelOpener requires capitalLedger');
    if (!nodeManager) throw new Error('ChannelOpener requires nodeManager');
    if (!dataLayer) throw new Error('ChannelOpener requires dataLayer');
    if (!auditLog) throw new Error('ChannelOpener requires auditLog');
    if (!agentRegistry) throw new Error('ChannelOpener requires agentRegistry');
    if (!assignmentRegistry) throw new Error('ChannelOpener requires assignmentRegistry');
    if (!mutex) throw new Error('ChannelOpener requires mutex');

    this._capitalLedger = capitalLedger;
    this._nodeManager = nodeManager;
    this._dataLayer = dataLayer;
    this._auditLog = auditLog;
    this._agentRegistry = agentRegistry;
    this._assignmentRegistry = assignmentRegistry;
    this._mutex = mutex;

    // channel_point → pending open entry
    this._state = {};
    this._pollTimer = null;
    this._lastPollBlockHeight = 0;

    // Dedup cache (10-minute expiry window)
    this._dedup = new DedupCache(600_000);

    this.config = { ...CHANNEL_OPEN_CONFIG };
  }

  // ---------------------------------------------------------------------------
  // State persistence
  // ---------------------------------------------------------------------------

  async load() {
    try {
      const raw = await this._dataLayer.readJSON(STATE_PATH);
      if (raw._lastPollBlockHeight != null) {
        this._lastPollBlockHeight = raw._lastPollBlockHeight;
        delete raw._lastPollBlockHeight;
      }
      this._state = raw;

      const entries = Object.values(this._state);
      const pending = entries.filter(e => e.status === 'pending_open').length;
      const submitting = entries.filter(e => e.status === 'submitting').length;
      console.log(
        `[ChannelOpener] Loaded ${entries.length} entries ` +
        `(${pending} pending, ${submitting} submitting)`
      );

      // Crash recovery: reconcile "submitting" entries
      if (submitting > 0) {
        await this._recoverSubmittingEntries();
      }
    } catch (err) {
      if (err.code === 'ENOENT') {
        this._state = {};
        console.log('[ChannelOpener] No existing state — starting fresh');
      } else {
        throw err;
      }
    }
  }

  async _persist() {
    const data = { ...this._state };
    if (this._lastPollBlockHeight > 0) {
      data._lastPollBlockHeight = this._lastPollBlockHeight;
    }
    await this._dataLayer.writeJSON(STATE_PATH, data);
  }

  // ---------------------------------------------------------------------------
  // Crash recovery
  // ---------------------------------------------------------------------------

  async _recoverSubmittingEntries() {
    const client = this._nodeManager.getDefaultNodeOrNull();
    if (!client) {
      console.warn('[ChannelOpener] No LND client for crash recovery — will retry on next load');
      return;
    }

    const submitting = Object.entries(this._state).filter(([, e]) => e.status === 'submitting');
    if (submitting.length === 0) return;

    console.log(`[ChannelOpener] Recovering ${submitting.length} submitting entries...`);

    let pendingResp, activeResp;
    try {
      pendingResp = await client.pendingChannels();
      activeResp = await client.listChannels();
    } catch (err) {
      console.error(`[ChannelOpener] Recovery failed (LND unavailable): ${err.message}`);
      return;
    }

    // Build lookup of all pending and active channels by peer + amount
    const pendingChannels = [
      ...(pendingResp.pending_open_channels || []).map(c => c.channel),
    ].filter(Boolean);
    const activeChannels = activeResp.channels || [];

    let changed = false;
    for (const [key, entry] of submitting) {
      // Check if channel exists as pending or active
      const matchPending = pendingChannels.find(
        c => c.remote_node_pub === entry.peer_pubkey &&
             parseInt(c.capacity || c.local_balance, 10) >= entry.local_funding_amount * 0.9
      );
      const matchActive = activeChannels.find(
        c => c.remote_pubkey === entry.peer_pubkey &&
             parseInt(c.capacity, 10) >= entry.local_funding_amount * 0.9
      );

      if (matchPending) {
        entry.status = 'pending_open';
        entry.channel_point = matchPending.channel_point || key;
        console.log(`[ChannelOpener] Recovery: ${key} found as pending channel`);
        changed = true;
      } else if (matchActive) {
        entry.status = 'pending_open';
        entry.channel_point = matchActive.channel_point;
        console.log(`[ChannelOpener] Recovery: ${key} found as active channel`);
        changed = true;
      } else {
        // Not found — unlock funds
        try {
          await this._capitalLedger.unlockForFailedOpen(
            entry.agent_id,
            entry.local_funding_amount,
            `recovery:${key}`,
          );
        } catch (err) {
          console.error(`[ChannelOpener] Recovery unlock failed for ${entry.agent_id}: ${err.message}`);
        }
        entry.status = 'failed';
        entry.failed_reason = 'Crash recovery: channel not found in LND';
        console.log(`[ChannelOpener] Recovery: ${key} not found — unlocked funds`);
        changed = true;
      }
    }

    if (changed) await this._persist();
  }

  // ---------------------------------------------------------------------------
  // Validation pipeline (12 steps, fail-fast)
  // ---------------------------------------------------------------------------

  async _validate(agentId, payload) {
    // Steps 1–7: shared signed-instruction validation
    const shared = await validateSignedInstruction({
      agentId, payload, expectedAction: 'channel_open',
      agentRegistry: this._agentRegistry, dedup: this._dedup,
      actionHints: HINTS,
    });
    if (!shared.success) return shared;

    const { checks_passed, instrHash, params } = shared;

    // Step 8: push_amount_zero
    if (params.push_amount_sats !== undefined && params.push_amount_sats !== 0) {
      return {
        success: false,
        error: 'push_amount_sats must be 0 or omitted',
        hint: HINTS.push_amount_rejected,
        status: 400,
        failed_at: 'push_amount_zero',
        checks_passed,
      };
    }
    checks_passed.push('push_amount_zero');

    // Step 9: amount_in_bounds
    const amount = params.local_funding_amount_sats;
    if (!Number.isInteger(amount) || amount <= 0) {
      return {
        success: false,
        error: 'local_funding_amount_sats must be a positive integer',
        hint: HINTS.amount_out_of_bounds(this.config.minChannelSizeSats, this.config.maxChannelSizeSats),
        status: 400,
        failed_at: 'amount_in_bounds',
        checks_passed,
      };
    }
    if (amount < this.config.minChannelSizeSats || amount > this.config.maxChannelSizeSats) {
      return {
        success: false,
        error: `Channel size ${amount} sats outside allowed range [${this.config.minChannelSizeSats}, ${this.config.maxChannelSizeSats}]`,
        hint: HINTS.amount_out_of_bounds(this.config.minChannelSizeSats, this.config.maxChannelSizeSats),
        status: 400,
        failed_at: 'amount_in_bounds',
        checks_passed,
      };
    }
    checks_passed.push('amount_in_bounds');

    // Step 10: balance_sufficient
    const balance = await this._capitalLedger.getBalance(agentId);
    if (balance.available < amount) {
      return {
        success: false,
        error: `Insufficient available balance: have ${balance.available}, need ${amount}`,
        hint: HINTS.insufficient_balance(balance.available, amount),
        status: 400,
        failed_at: 'balance_sufficient',
        checks_passed,
      };
    }
    checks_passed.push('balance_sufficient');

    // Step 11: channel_count_under_limit
    const agentChannels = this._assignmentRegistry.getByAgent(agentId);
    const agentPending = Object.values(this._state).filter(
      e => e.agent_id === agentId && (e.status === 'pending_open' || e.status === 'submitting')
    );
    const agentTotal = agentChannels.length + agentPending.length;
    if (agentTotal >= this.config.maxPerAgent) {
      return {
        success: false,
        error: `Per-agent channel limit reached: ${agentTotal}/${this.config.maxPerAgent}`,
        hint: HINTS.channel_count_limit(agentTotal, this.config.maxPerAgent, 'Per-agent'),
        status: 400,
        failed_at: 'channel_count_under_limit',
        checks_passed,
      };
    }

    const globalTotal = this._assignmentRegistry.count() +
      Object.values(this._state).filter(e => e.status === 'pending_open' || e.status === 'submitting').length;
    if (globalTotal >= this.config.maxTotalChannels) {
      return {
        success: false,
        error: `Global channel limit reached: ${globalTotal}/${this.config.maxTotalChannels}`,
        hint: HINTS.channel_count_limit(globalTotal, this.config.maxTotalChannels, 'Global'),
        status: 400,
        failed_at: 'channel_count_under_limit',
        checks_passed,
      };
    }
    checks_passed.push('channel_count_under_limit');

    // Step 12: peer_in_graph
    const peerPubkey = params.peer_pubkey;
    if (!peerPubkey || typeof peerPubkey !== 'string' || !/^[0-9a-f]{66}$/i.test(peerPubkey)) {
      return {
        success: false,
        error: 'peer_pubkey must be a 66-character hex string',
        hint: HINTS.peer_not_in_graph,
        status: 400,
        failed_at: 'peer_in_graph',
        checks_passed,
      };
    }

    const client = this._nodeManager.getDefaultNodeOrNull();
    if (!client) {
      return {
        success: false,
        error: 'LND node not available',
        hint: 'The Lightning node is temporarily unreachable. Try again in 30-60 seconds.',
        status: 503,
        failed_at: 'peer_in_graph',
        checks_passed,
      };
    }

    let peerInfo;
    try {
      peerInfo = await client.getNodeInfo(peerPubkey);
    } catch {
      return {
        success: false,
        error: 'Peer not found in Lightning Network graph',
        hint: HINTS.peer_not_in_graph,
        status: 400,
        failed_at: 'peer_in_graph',
        checks_passed,
      };
    }
    checks_passed.push('peer_in_graph');

    return {
      success: true,
      checks_passed,
      instrHash,
      peerInfo,
      balance,
      params,
    };
  }

  // ---------------------------------------------------------------------------
  // Preview (dry-run)
  // ---------------------------------------------------------------------------

  async preview(agentId, payload) {
    const result = await this._validate(agentId, payload);

    if (!result.success) {
      return {
        valid: false,
        failed_at: result.failed_at,
        checks_passed: result.checks_passed,
        error: result.error,
        hint: result.hint,
      };
    }

    const { params, peerInfo, balance, checks_passed } = result;
    const peerAlias = peerInfo?.node?.alias || 'unknown';

    return {
      valid: true,
      checks_passed,
      would_execute: {
        peer_pubkey: params.peer_pubkey,
        peer_alias: peerAlias,
        local_funding_amount_sats: params.local_funding_amount_sats,
        private: params.private || false,
        fee_constraints: params.fee_constraints || null,
      },
      balance_after_lock: {
        available: balance.available - params.local_funding_amount_sats,
        locked: balance.locked + params.local_funding_amount_sats,
      },
      learn: 'Preview ran all 12 validation checks without executing. ' +
        'Submit the identical payload to POST /api/v1/market/open to execute for real. ' +
        'The channel open will lock your capital and submit a funding transaction to the Bitcoin network.',
    };
  }

  // ---------------------------------------------------------------------------
  // Execute channel open
  // ---------------------------------------------------------------------------

  async open(agentId, payload) {
    // Validate (steps 1-12)
    const validation = await this._validate(agentId, payload);
    if (!validation.success) {
      return validation;
    }

    const { instruction } = payload;
    const { instrHash, params, peerInfo } = validation;

    const amount = params.local_funding_amount_sats;
    const peerPubkey = params.peer_pubkey;
    const isPrivate = params.private || false;
    const feeConstraints = params.fee_constraints || null;
    const peerAlias = peerInfo?.node?.alias || 'unknown';

    // Acquire mutex for this agent's capital operations
    const unlock = await this._mutex.acquire(`channel-open:${agentId}`);
    try {
      // Lock funds in capital ledger
      const lockRef = `pending-open:${instrHash}`;
      try {
        await this._capitalLedger.lockForChannel(agentId, amount, lockRef);
      } catch (err) {
        return {
          success: false,
          error: `Failed to lock capital: ${err.message}`,
          hint: HINTS.insufficient_balance(
            (await this._capitalLedger.getBalance(agentId)).available,
            amount,
          ),
          status: 400,
          failed_at: 'capital_lock',
          checks_passed: validation.checks_passed,
        };
      }

      // Save submitting state (crash-safe checkpoint)
      const entryKey = `submitting:${instrHash}`;
      const blockHeight = this._lastPollBlockHeight || 0;
      this._state[entryKey] = {
        agent_id: agentId,
        peer_pubkey: peerPubkey,
        peer_alias: peerAlias,
        local_funding_amount: amount,
        status: 'submitting',
        requested_at: new Date().toISOString(),
        request_block_height: blockHeight,
        fee_constraints: feeConstraints,
        private: isPrivate,
        instruction_hash: instrHash,
      };
      await this._persist();

      // Mark instruction as seen (dedup)
      this._dedup.mark(instrHash);

      // Connect peer (best effort — may already be connected)
      const client = this._nodeManager.getDefaultNodeOrNull();
      if (client && peerInfo?.node?.addresses?.length > 0) {
        const addr = peerInfo.node.addresses[0];
        try {
          await client.connectPeer(peerPubkey, addr.addr);
        } catch {
          // Expected if already connected — ignore
        }
      }

      // Open channel via LND
      let openResult;
      try {
        openResult = await client.openChannel(peerPubkey, amount, 0, {
          private: isPrivate,
          satPerVbyte: this.config.defaultSatPerVbyte,
        });
      } catch (err) {
        // Rollback: unlock funds
        try {
          await this._capitalLedger.unlockForFailedOpen(agentId, amount, lockRef);
        } catch (unlockErr) {
          console.error(`[ChannelOpener] CRITICAL: unlock failed after open error: ${unlockErr.message}`);
        }

        // Update state to failed
        this._state[entryKey].status = 'failed';
        this._state[entryKey].failed_reason = err.message;
        await this._persist();

        await this._auditLog.append({
          domain: 'channel_market',
          type: 'channel_open_failed',
          agent_id: agentId,
          peer_pubkey: peerPubkey,
          amount,
          error: err.message,
          instruction_hash: instrHash,
        });

        return {
          success: false,
          error: mapLndError(err.message),
          status: 502,
          failed_at: 'lnd_open_channel',
          checks_passed: validation.checks_passed,
        };
      }

      // Extract channel_point from LND response
      const fundingTxidStr = openResult.funding_txid_str ||
        (openResult.funding_txid_bytes ? Buffer.from(openResult.funding_txid_bytes, 'base64').reverse().toString('hex') : null);
      const outputIndex = openResult.output_index ?? 0;
      const channelPoint = fundingTxidStr ? `${fundingTxidStr}:${outputIndex}` : entryKey;

      // Remove submitting entry, add pending_open with real channel_point
      const requestedAt = this._state[entryKey]?.requested_at || new Date().toISOString();
      delete this._state[entryKey];
      this._state[channelPoint] = {
        agent_id: agentId,
        peer_pubkey: peerPubkey,
        peer_alias: peerAlias,
        channel_point: channelPoint,
        local_funding_amount: amount,
        status: 'pending_open',
        requested_at: requestedAt,
        funding_txid: fundingTxidStr,
        request_block_height: blockHeight,
        fee_constraints: feeConstraints,
        private: isPrivate,
        instruction_hash: instrHash,
      };
      await this._persist();

      await this._auditLog.append({
        domain: 'channel_market',
        type: 'channel_open_requested',
        agent_id: agentId,
        peer_pubkey: peerPubkey,
        peer_alias: peerAlias,
        amount,
        channel_point: channelPoint,
        funding_txid: fundingTxidStr,
        private: isPrivate,
        fee_constraints: feeConstraints,
        instruction_hash: instrHash,
      });

      console.log(
        `[ChannelOpener] Channel open submitted: ${amount} sats to ${peerAlias} (${peerPubkey.slice(0, 12)}...) — ${channelPoint}`
      );

      return {
        success: true,
        result: {
          status: 'pending_open',
          channel_point: channelPoint,
          funding_txid: fundingTxidStr,
          peer_pubkey: peerPubkey,
          peer_alias: peerAlias,
          local_funding_amount_sats: amount,
          private: isPrivate,
        },
        learn: 'Your channel open has been submitted to the Bitcoin network. ' +
          `The funding transaction ${fundingTxidStr} needs ${this.config.requiredConfirmations} confirmations (~30 min) ` +
          'before the channel becomes active. Once confirmed, the channel will be auto-assigned to you ' +
          'and you can set fee policies via POST /api/v1/channels/instruct. ' +
          'Track progress: GET /api/v1/market/pending',
      };
    } finally {
      unlock();
    }
  }

  // ---------------------------------------------------------------------------
  // Polling: detect confirmed channels
  // ---------------------------------------------------------------------------

  startPolling(intervalMs = 30_000) {
    if (this._pollTimer) return;
    console.log(`[ChannelOpener] Starting channel confirmation polling every ${intervalMs / 1000}s`);
    this._pollTimer = setInterval(() => {
      this.pollPendingChannels().catch(err => {
        console.error(`[ChannelOpener] Poll error: ${err.message}`);
      });
    }, intervalMs);
  }

  stopPolling() {
    if (this._pollTimer) {
      clearInterval(this._pollTimer);
      this._pollTimer = null;
      console.log('[ChannelOpener] Polling stopped');
    }
  }

  async pollPendingChannels() {
    const pendingEntries = Object.entries(this._state).filter(
      ([, e]) => e.status === 'pending_open'
    );
    if (pendingEntries.length === 0) return;

    const client = this._nodeManager.getDefaultNodeOrNull();
    if (!client) return;

    // Call listChannels once and build lookup by channel_point
    let channelsResp;
    try {
      channelsResp = await client.listChannels();
    } catch (err) {
      console.error(`[ChannelOpener] listChannels failed: ${err.message}`);
      return;
    }

    const activeByPoint = new Map();
    for (const ch of (channelsResp.channels || [])) {
      activeByPoint.set(ch.channel_point, ch);
    }

    // Get current block height for timeout checks
    let currentBlockHeight = this._lastPollBlockHeight;
    try {
      const best = await client.getBestBlock();
      if (best?.block_height) {
        currentBlockHeight = best.block_height;
        this._lastPollBlockHeight = currentBlockHeight;
      }
    } catch { /* use cached height */ }

    let stateChanged = false;

    for (const [channelPoint, entry] of pendingEntries) {
      const activeChannel = activeByPoint.get(channelPoint);

      if (activeChannel) {
        // Channel confirmed and active
        const chanId = activeChannel.chan_id;

        try {
          await this._assignmentRegistry.assign(
            chanId,
            channelPoint,
            entry.agent_id,
            {
              remote_pubkey: entry.peer_pubkey,
              capacity: parseInt(activeChannel.capacity, 10),
            },
            entry.fee_constraints,
          );
        } catch (err) {
          // Already assigned (409) is OK — idempotent
          if (err.status !== 409) {
            console.error(`[ChannelOpener] Assignment failed for ${channelPoint}: ${err.message}`);
            continue;
          }
        }

        await this._auditLog.append({
          domain: 'channel_market',
          type: 'channel_opened',
          agent_id: entry.agent_id,
          chan_id: chanId,
          channel_point: channelPoint,
          peer_pubkey: entry.peer_pubkey,
          peer_alias: entry.peer_alias,
          capacity: parseInt(activeChannel.capacity, 10),
          local_funding_amount: entry.local_funding_amount,
        });

        entry.status = 'active';
        entry.chan_id = chanId;
        entry.confirmed_at = new Date().toISOString();
        stateChanged = true;

        console.log(`[ChannelOpener] Channel confirmed: ${channelPoint} (${entry.peer_alias}) — assigned to ${entry.agent_id}`);
      } else if (entry.request_block_height > 0 &&
                 currentBlockHeight - entry.request_block_height > this.config.pendingOpenTimeoutBlocks) {
        // Timed out — unlock funds
        try {
          await this._capitalLedger.unlockForFailedOpen(
            entry.agent_id,
            entry.local_funding_amount,
            channelPoint,
          );
        } catch (err) {
          console.error(`[ChannelOpener] Timeout unlock failed for ${entry.agent_id}: ${err.message}`);
        }

        await this._auditLog.append({
          domain: 'channel_market',
          type: 'channel_open_timeout',
          agent_id: entry.agent_id,
          channel_point: channelPoint,
          peer_pubkey: entry.peer_pubkey,
          blocks_elapsed: currentBlockHeight - entry.request_block_height,
        });

        entry.status = 'failed';
        entry.failed_reason = `Timed out after ${currentBlockHeight - entry.request_block_height} blocks`;
        stateChanged = true;

        console.warn(`[ChannelOpener] Channel open timed out: ${channelPoint} for ${entry.agent_id}`);
      }
      // else: still pending, do nothing
    }

    if (stateChanged) {
      await this._persist();
    }
  }

  // ---------------------------------------------------------------------------
  // Query
  // ---------------------------------------------------------------------------

  /**
   * Get pending channel opens for a specific agent.
   */
  getPendingForAgent(agentId) {
    const results = [];
    for (const [key, entry] of Object.entries(this._state)) {
      if (entry.agent_id !== agentId) continue;
      if (entry.status !== 'pending_open' && entry.status !== 'submitting') continue;
      results.push({
        channel_point: entry.channel_point || key,
        peer_pubkey: entry.peer_pubkey,
        peer_alias: entry.peer_alias,
        local_funding_amount_sats: entry.local_funding_amount,
        status: entry.status,
        requested_at: entry.requested_at,
        funding_txid: entry.funding_txid || null,
        private: entry.private,
      });
    }
    return results;
  }

  /**
   * Get public configuration for agents.
   */
  getConfig() {
    return {
      min_channel_size_sats: this.config.minChannelSizeSats,
      max_channel_size_sats: this.config.maxChannelSizeSats,
      max_channels_per_agent: this.config.maxPerAgent,
      max_total_channels: this.config.maxTotalChannels,
      required_confirmations: this.config.requiredConfirmations,
      operator_subsidizes_on_chain_fee: true,
      learn: 'These are the current limits for channel opens on this node. ' +
        'The on-chain mining fee is paid by the node operator (not deducted from your capital). ' +
        'Your local_funding_amount_sats becomes the channel capacity. ' +
        'To open a channel: POST /api/v1/market/open with a signed instruction. ' +
        'To preview (dry-run validation): POST /api/v1/market/preview.',
    };
  }

  /**
   * Get stats for monitoring.
   */
  getStats() {
    const counts = { submitting: 0, pending_open: 0, active: 0, failed: 0, total: 0 };
    for (const entry of Object.values(this._state)) {
      counts[entry.status] = (counts[entry.status] || 0) + 1;
      counts.total++;
    }
    return counts;
  }

  // ---------------------------------------------------------------------------
  // Internal helpers
  // ---------------------------------------------------------------------------

}
