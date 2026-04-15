/**
 * Channel Opener — Validates, locks, opens, polls, and assigns Lightning channels.
 *
 * Handles the full lifecycle of agent-initiated channel opens:
 *   1. 13-step fail-fast validation pipeline (secp256k1-signed requests)
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
import { appendSignedValidationFailure } from '../channel-accountability/signed-validation-fingerprint.js';
import { summarizeLndError } from '../lnd/agent-error-utils.js';
import { pickSafePublicPeerAddress } from '../identity/request-security.js';
import { createHash } from 'node:crypto';
import { canonicalProofJson } from '../proof-ledger/proof-ledger.js';

const STATE_PATH = 'data/channel-market/pending-opens.json';

const CHANNEL_OPEN_CONFIG = {
  openRequestTimeoutMs: 120_000,
};

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function sha256Hex(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function proofSafeKey(prefix, fields) {
  return `${prefix}:${sha256Hex(canonicalProofJson(fields))}`;
}

function withTimeout(promise, ms, label) {
  if (!Number.isFinite(ms) || ms <= 0) return promise;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    }),
  ]);
}

function readOptionalInteger(value) {
  return Number.isInteger(value) ? value : null;
}

function buildStartupPolicy(params = {}) {
  const startupPolicy = {};
  if (Number.isInteger(params.base_fee_msat)) startupPolicy.base_fee_msat = params.base_fee_msat;
  if (Number.isInteger(params.fee_rate_ppm)) startupPolicy.fee_rate_ppm = params.fee_rate_ppm;
  if (Number.isInteger(params.min_htlc_msat)) startupPolicy.min_htlc_msat = params.min_htlc_msat;
  if (Number.isInteger(params.max_htlc_msat)) startupPolicy.max_htlc_msat = params.max_htlc_msat;
  if (Number.isInteger(params.time_lock_delta)) startupPolicy.time_lock_delta = params.time_lock_delta;
  return Object.keys(startupPolicy).length > 0 ? startupPolicy : null;
}

function startupPolicyNeedsActivationStep(startupPolicy) {
  if (!startupPolicy) return false;
  return startupPolicy.time_lock_delta !== undefined || startupPolicy.max_htlc_msat !== undefined;
}

function parsePeerAllowlist() {
  const raw = process.env.CHANNEL_OPEN_PEER_ALLOWLIST;
  if (!raw || !raw.trim()) return null;
  const peers = raw
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .filter((entry) => /^[0-9a-f]{66}$/i.test(entry));
  return peers.length > 0 ? new Set(peers) : null;
}

function peerConnectFailureDetails(errMsg) {
  const text = `${errMsg || ''}`.trim();
  if (/already connected to peer/i.test(text)) {
    return {
      error: 'Peer connection is already open, but the node could not confirm it cleanly.',
      hint: 'Try the preview once more. If it keeps happening, try another peer.',
      status: 502,
    };
  }
  return {
    error: 'The node could not keep a live connection to that peer.',
    hint: 'Try another live peer, or retry after the peer comes back online.',
    status: 502,
  };
}

function mapLndError(errMsg) {
  return summarizeLndError(errMsg, {
    action: 'channel open',
    fallback: 'Channel open failed.',
  });
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
    'For fee policy changes, use the named channel-policy MCP tools.',

  push_amount_rejected:
    'push_amount_sats gifts sats to the remote peer irrevocably the moment the channel opens. ' +
    'This is almost never what you want — it gives away your capital. Set to 0 or omit entirely.',

  amount_out_of_bounds:
    'Channel size is outside this node’s current allowed range.',

  insufficient_balance: (available, requested) =>
    `Your available capital is ${available.toLocaleString()} sats, but you requested ${requested.toLocaleString()} sats. ` +
    'Stop the channel-open flow and fund channel capital first with aol_create_onchain_capital_deposit, ' +
    'aol_create_lightning_capital_deposit, or existing wallet ecash through aol_fund_channel_from_ecash.',

  channel_count_limit: (scope) =>
    `${scope} channel limit reached. ` +
    'Close an existing channel or wait for the operator to raise the limit.',

  peer_not_in_graph:
    'Peer not found in the Lightning Network graph. ' +
    'Verify the pubkey is correct (66 hex chars). The node must be online and have announced itself.',

  peer_requires_public_address:
    'This peer does not advertise a public routable address in the Lightning graph. ' +
    'Pick a peer with a public host:port, or ask the operator to connect manually first.',

  peer_connect_failed:
    'The node could not hold a live connection to this peer long enough to start a real channel open. ' +
    'Try another live peer, or retry after the peer comes back online.',

  peer_not_allowlisted:
    'This peer is not approved for direct opens on this node. ' +
    'Use aol_get_peer_safety to inspect the peer, or choose an approved peer.',

  peer_allowlist_required:
    'This node only opens channels to operator-approved peers. ' +
    'Use aol_get_peer_safety, then choose an approved peer or ask the operator to approve one.',

  peer_force_closes:
    'This peer has too much force-close history for this node’s current safety policy. ' +
    'Use aol_get_peer_safety and choose a cleaner peer.',

  peer_force_close_history_unavailable:
    'Peer safety history is temporarily unavailable, so this open needs review before it can proceed. ' +
    'Try again later or choose another approved peer.',

  peer_too_few_channels:
    'This peer has too few channels for this node’s current safety policy. ' +
    'Nodes with very few channels are risky — they may be ephemeral or poorly connected. ' +
    'Use aol_suggest_peers to find better-connected peers.',

  peer_stale_graph_update:
    'This peer looks stale in the network graph. ' +
    'Nodes that have not updated recently may be offline or abandoned. ' +
    'Try connecting to a peer that has been active more recently.',

  startup_policy_invalid:
    'Startup policy fields must use whole numbers. Supported fields: base_fee_msat, fee_rate_ppm, min_htlc_msat, max_htlc_msat, time_lock_delta.',

  startup_policy_base_fee:
    'base_fee_msat is outside this node’s current safe range.',

  startup_policy_fee_rate:
    'fee_rate_ppm is outside this node’s current safe range.',

  startup_policy_time_lock:
    'time_lock_delta is outside this node’s current safe range.',

  startup_policy_min_htlc:
    'min_htlc_msat must be a non-negative whole number and cannot exceed the channel capacity.',

  startup_policy_max_htlc:
    'max_htlc_msat must be a positive whole number and cannot exceed the channel capacity.',

  startup_policy_htlc_order:
    'min_htlc_msat must be less than or equal to max_htlc_msat.',
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
  constructor({ capitalLedger, nodeManager, dataLayer, auditLog, agentRegistry, assignmentRegistry, mutex, proofLedger = null, config = {} }) {
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
    this._proofLedger = proofLedger;

    // channel_point → pending open entry
    this._state = {};
    this._pollTimer = null;
    this._lastPollBlockHeight = 0;
    this._stopping = false;

    // Dedup cache (10-minute expiry window)
    this._dedup = new DedupCache(600_000, {
      dataLayer,
      path: 'data/channel-market/channel-open-dedup.json',
    });

    this.config = {
      ...CHANNEL_OPEN_CONFIG,
      ...config,
      maxTotalChannels: Number.isInteger(config.maxTotalChannels) ? config.maxTotalChannels : Infinity,
      maxPerAgent: Number.isInteger(config.maxPerAgent) ? config.maxPerAgent : Infinity,
      peerSafety: { ...(config.peerSafety || {}) },
      startupPolicyLimits: { ...(config.startupPolicyLimits || {}) },
    };
  }

  async _appendProof(input) {
    if (!this._proofLedger?.appendProof) return null;
    return this._proofLedger.appendProof(input);
  }

  async _appendProofBestEffort(input, context) {
    try {
      return await this._appendProof(input);
    } catch (err) {
      console.error(`[ChannelOpener] Proof lifecycle append failed for ${context}: ${err.message}`);
      return null;
    }
  }

  getStartupRules() {
    return {
      minChannelSizeSats: this.config.minChannelSizeSats,
      maxChannelSizeSats: this.config.maxChannelSizeSats,
      maxTotalChannels: Number.isFinite(this.config.maxTotalChannels) ? this.config.maxTotalChannels : 'unlimited',
      maxPerAgent: Number.isFinite(this.config.maxPerAgent) ? this.config.maxPerAgent : 'unlimited',
      pendingOpenTimeoutBlocks: this.config.pendingOpenTimeoutBlocks,
      connectPeerTimeoutMs: this.config.connectPeerTimeoutMs,
      openRequestTimeoutMs: this.config.openRequestTimeoutMs,
      defaultSatPerVbyte: this.config.defaultSatPerVbyte,
      peerSafety: {
        forceCloseLimit: this.config.peerSafety.forceCloseLimit,
        requireAllowlist: this.config.peerSafety.requireAllowlist,
        minPeerChannels: this.config.peerSafety.minPeerChannels,
        maxPeerLastUpdateAgeSeconds: this.config.peerSafety.maxPeerLastUpdateAgeSeconds,
      },
    };
  }

  logStartupRules() {
    console.log(`[ChannelOpener] Live open rules ${JSON.stringify(this.getStartupRules())}`);
  }

  // ---------------------------------------------------------------------------
  // State persistence
  // ---------------------------------------------------------------------------

  async load() {
    try {
      const raw = await this._dataLayer.readRuntimeStateJSON(STATE_PATH, { defaultValue: {} });
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
    const client = this._nodeManager.getScopedDefaultNodeOrNull('open');
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

  async _isPeerConnected(client, peerPubkey) {
    const peers = await client.listPeers();
    return Array.isArray(peers?.peers)
      ? peers.peers.some((peer) => peer?.pub_key === peerPubkey || peer?.pubkey === peerPubkey)
      : false;
  }

  async _checkPeerConnectReady(client, peerPubkey, safePeerAddress) {
    try {
      if (await this._isPeerConnected(client, peerPubkey)) {
        return { ok: true, alreadyConnected: true };
      }
    } catch (err) {
      return {
        ok: false,
        ...peerConnectFailureDetails(err.message),
      };
    }

    let connectError = null;
    try {
      await withTimeout(
        client.connectPeer(peerPubkey, safePeerAddress),
        this.config.connectPeerTimeoutMs,
        'peer connect',
      );
    } catch (err) {
      connectError = err;
    }

    const waitBudgetMs = Math.max(600, Math.min(this.config.connectPeerTimeoutMs, 2_500));
    const deadline = Date.now() + waitBudgetMs;
    while (Date.now() <= deadline) {
      try {
        if (await this._isPeerConnected(client, peerPubkey)) {
          return { ok: true, alreadyConnected: false };
        }
      } catch (err) {
        connectError ||= err;
      }
      await sleep(200);
    }

    const details = peerConnectFailureDetails(connectError?.message || 'peer not connected');
    return { ok: false, ...details };
  }

  async _validate(agentId, payload) {
    // Steps 1–7: shared signed-instruction validation
    const shared = await validateSignedInstruction({
      agentId, payload, expectedAction: 'channel_open',
      agentRegistry: this._agentRegistry, dedup: this._dedup,
      actionHints: HINTS,
      onFailureFingerprint: (fingerprint) => appendSignedValidationFailure({
        dataLayer: this._dataLayer,
        routeFamily: 'market_open',
        operation: 'validate',
        agentId,
        expectedAction: 'channel_open',
        fingerprint,
      }),
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
        hint: HINTS.amount_out_of_bounds,
        status: 400,
        failed_at: 'amount_in_bounds',
        checks_passed,
      };
    }
    if (amount < this.config.minChannelSizeSats || amount > this.config.maxChannelSizeSats) {
      return {
        success: false,
        error: 'Channel size outside allowed range',
        hint: HINTS.amount_out_of_bounds,
        status: 400,
        failed_at: 'amount_in_bounds',
        checks_passed,
      };
    }
    checks_passed.push('amount_in_bounds');

    const capacityMsat = amount * 1000;
    const startupPolicy = buildStartupPolicy(params);
    if (params.base_fee_msat !== undefined && !Number.isInteger(params.base_fee_msat)) {
      return {
        success: false,
        error: 'base_fee_msat must be an integer',
        hint: HINTS.startup_policy_invalid,
        status: 400,
        failed_at: 'startup_policy_valid',
        checks_passed,
      };
    }
    if (params.fee_rate_ppm !== undefined && !Number.isInteger(params.fee_rate_ppm)) {
      return {
        success: false,
        error: 'fee_rate_ppm must be an integer',
        hint: HINTS.startup_policy_invalid,
        status: 400,
        failed_at: 'startup_policy_valid',
        checks_passed,
      };
    }
    if (params.min_htlc_msat !== undefined && !Number.isInteger(params.min_htlc_msat)) {
      return {
        success: false,
        error: 'min_htlc_msat must be an integer',
        hint: HINTS.startup_policy_invalid,
        status: 400,
        failed_at: 'startup_policy_valid',
        checks_passed,
      };
    }
    if (params.max_htlc_msat !== undefined && !Number.isInteger(params.max_htlc_msat)) {
      return {
        success: false,
        error: 'max_htlc_msat must be an integer',
        hint: HINTS.startup_policy_invalid,
        status: 400,
        failed_at: 'startup_policy_valid',
        checks_passed,
      };
    }
    if (params.time_lock_delta !== undefined && !Number.isInteger(params.time_lock_delta)) {
      return {
        success: false,
        error: 'time_lock_delta must be an integer',
        hint: HINTS.startup_policy_invalid,
        status: 400,
        failed_at: 'startup_policy_valid',
        checks_passed,
      };
    }
    const startupPolicyLimits = this.config.startupPolicyLimits;
    if (params.base_fee_msat !== undefined &&
        (params.base_fee_msat < startupPolicyLimits.minBaseFeeMsat ||
         params.base_fee_msat > startupPolicyLimits.maxBaseFeeMsat)) {
      return {
        success: false,
        error: 'base_fee_msat outside safe range',
        hint: HINTS.startup_policy_base_fee,
        status: 400,
        failed_at: 'startup_policy_valid',
        checks_passed,
      };
    }
    if (params.fee_rate_ppm !== undefined &&
        (params.fee_rate_ppm < startupPolicyLimits.minFeeRatePpm ||
         params.fee_rate_ppm > startupPolicyLimits.maxFeeRatePpm)) {
      return {
        success: false,
        error: 'fee_rate_ppm outside safe range',
        hint: HINTS.startup_policy_fee_rate,
        status: 400,
        failed_at: 'startup_policy_valid',
        checks_passed,
      };
    }
    if (params.time_lock_delta !== undefined &&
        (params.time_lock_delta < startupPolicyLimits.minTimeLockDelta ||
         params.time_lock_delta > startupPolicyLimits.maxTimeLockDelta)) {
      return {
        success: false,
        error: 'time_lock_delta outside safe range',
        hint: HINTS.startup_policy_time_lock,
        status: 400,
        failed_at: 'startup_policy_valid',
        checks_passed,
      };
    }
    if (params.min_htlc_msat !== undefined &&
        (params.min_htlc_msat < 0 || params.min_htlc_msat > capacityMsat)) {
      return {
        success: false,
        error: 'min_htlc_msat outside allowed range',
        hint: HINTS.startup_policy_min_htlc,
        status: 400,
        failed_at: 'startup_policy_valid',
        checks_passed,
      };
    }
    if (params.max_htlc_msat !== undefined &&
        (params.max_htlc_msat <= 0 || params.max_htlc_msat > capacityMsat)) {
      return {
        success: false,
        error: 'max_htlc_msat outside allowed range',
        hint: HINTS.startup_policy_max_htlc,
        status: 400,
        failed_at: 'startup_policy_valid',
        checks_passed,
      };
    }
    if (params.min_htlc_msat !== undefined &&
        params.max_htlc_msat !== undefined &&
        params.min_htlc_msat > params.max_htlc_msat) {
      return {
        success: false,
        error: 'min_htlc_msat cannot exceed max_htlc_msat',
        hint: HINTS.startup_policy_htlc_order,
        status: 400,
        failed_at: 'startup_policy_valid',
        checks_passed,
      };
    }
    checks_passed.push('startup_policy_valid');

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
        error: 'Per-agent channel limit reached',
        hint: HINTS.channel_count_limit('Per-agent'),
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
        error: 'Global channel limit reached',
        hint: HINTS.channel_count_limit('Global'),
        status: 400,
        failed_at: 'channel_count_under_limit',
        checks_passed,
      };
    }
    checks_passed.push('channel_count_under_limit');

    // Step 12: peer_safe_for_open
    const peerPubkey = params.peer_pubkey;
    if (!peerPubkey || typeof peerPubkey !== 'string' || !/^[0-9a-f]{66}$/i.test(peerPubkey)) {
      return {
        success: false,
        error: 'peer_pubkey must be a 66-character hex string',
        hint: HINTS.peer_not_in_graph,
        status: 400,
        failed_at: 'peer_safe_for_open',
        checks_passed,
      };
    }

    const client = this._nodeManager.getScopedDefaultNodeOrNull('open');
    if (!client) {
      return {
        success: false,
        error: 'LND node not available',
        hint: 'The Lightning node is temporarily unreachable. Wait a bit and try again.',
        status: 503,
        failed_at: 'peer_safe_for_open',
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
        failed_at: 'peer_safe_for_open',
        checks_passed,
      };
    }
    const safePeerAddress = await pickSafePublicPeerAddress(peerInfo?.node?.addresses || []);
    if (!safePeerAddress) {
      return {
        success: false,
        error: 'Peer has no public routable address',
        hint: HINTS.peer_requires_public_address,
        status: 400,
        failed_at: 'peer_safe_for_open',
        checks_passed,
      };
    }

    // Peer quality: minimum channel count
    const minPeerChannels = this.config.peerSafety.minPeerChannels;
    const peerNumChannels = peerInfo.num_channels ?? peerInfo.node?.num_channels ?? 0;
    if (minPeerChannels > 0 && peerNumChannels < minPeerChannels) {
      return {
        success: false,
        error: 'Peer has too few channels for this node',
        hint: HINTS.peer_too_few_channels,
        status: 400,
        failed_at: 'peer_safe_for_open',
        checks_passed,
      };
    }

    // Peer quality: last update freshness (reject stale/dead nodes)
    const maxPeerLastUpdateAgeS = this.config.peerSafety.maxPeerLastUpdateAgeSeconds;
    const peerLastUpdate = peerInfo.node?.last_update;
    if (maxPeerLastUpdateAgeS > 0 && peerLastUpdate) {
      const now = Math.floor(Date.now() / 1000);
      const ageS = now - peerLastUpdate;
      if (ageS > maxPeerLastUpdateAgeS) {
        return {
          success: false,
          error: 'Peer looks stale in the network graph',
          hint: HINTS.peer_stale_graph_update,
          status: 400,
          failed_at: 'peer_safe_for_open',
          checks_passed,
        };
      }
    }

    const peerForceCloseLimit = this.config.peerSafety.forceCloseLimit;
    if (Number.isInteger(peerForceCloseLimit) && peerForceCloseLimit >= 0) {
      try {
        const closedResp = await client.closedChannels();
        const closedChannels = closedResp?.channels || [];
        const peerForceCloses = closedChannels.filter(
          (channel) => channel?.remote_pubkey === peerPubkey &&
            (channel?.close_type === 'REMOTE_FORCE_CLOSE' || channel?.close_type === 'LOCAL_FORCE_CLOSE'),
        ).length;
        if (peerForceCloses > peerForceCloseLimit) {
          return {
            success: false,
            error: 'Peer exceeds this node’s force-close safety policy',
            hint: HINTS.peer_force_closes,
            status: 403,
            failed_at: 'peer_safe_for_open',
            checks_passed,
          };
        }
      } catch {
        return {
          success: false,
          error: 'Peer safety history is temporarily unavailable',
          hint: HINTS.peer_force_close_history_unavailable,
          status: 503,
          failed_at: 'peer_safe_for_open',
          checks_passed,
        };
      }
    }

    const allowlist = parsePeerAllowlist();
    if (this.config.peerSafety.requireAllowlist && !allowlist) {
      return {
        success: false,
        error: 'Direct channel opens are paused until approved peers are configured on this node',
        hint: HINTS.peer_allowlist_required,
        status: 503,
        failed_at: 'peer_safe_for_open',
        checks_passed,
      };
    }
    if (allowlist && !allowlist.has(peerPubkey)) {
      return {
        success: false,
        error: 'Peer is not approved for direct channel opens on this node',
        hint: HINTS.peer_not_allowlisted,
        status: 403,
        failed_at: 'peer_safe_for_open',
        checks_passed,
      };
    }
    checks_passed.push('peer_safe_for_open');

    const peerConnect = await this._checkPeerConnectReady(client, peerPubkey, safePeerAddress);
    if (!peerConnect.ok) {
      return {
        success: false,
        error: peerConnect.error,
        hint: peerConnect.hint || HINTS.peer_connect_failed,
        status: peerConnect.status || 502,
        failed_at: 'peer_connect_ready',
        checks_passed,
      };
    }
    checks_passed.push('peer_connect_ready');

    return {
      success: true,
      checks_passed,
      instrHash,
      peerInfo,
      safePeerAddress,
      balance,
      startupPolicy,
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
        success: false,
        valid: false,
        status: result.status,
        failed_at: result.failed_at,
        checks_passed: result.checks_passed,
        error: result.error,
        hint: result.hint,
      };
    }

    const { params, peerInfo, balance, checks_passed, startupPolicy } = result;
    const peerAlias = peerInfo?.node?.alias || 'unknown';

    return {
      success: true,
      valid: true,
      checks_passed,
      would_execute: {
        peer_pubkey: params.peer_pubkey,
        peer_alias: peerAlias,
        local_funding_amount_sats: params.local_funding_amount_sats,
        private: params.private || false,
        fee_constraints: params.fee_constraints || null,
        startup_policy: startupPolicy,
      },
      balance_after_lock: {
        available: balance.available - params.local_funding_amount_sats,
        locked: balance.locked + params.local_funding_amount_sats,
      },
      learn: 'Preview ran all validation checks, including a live peer-connect check, without executing. ' +
        'Submit the identical signed instruction through aol_open_channel to execute for real. ' +
        'The channel open will lock your channel capital and submit a funding transaction to the Bitcoin network.',
    };
  }

  // ---------------------------------------------------------------------------
  // Execute channel open
  // ---------------------------------------------------------------------------

  async open(agentId, payload) {
    // Validate (steps 1-13)
    const validation = await this._validate(agentId, payload);
    if (!validation.success) {
      return validation;
    }

    const { instrHash, params, peerInfo, safePeerAddress, startupPolicy } = validation;

    const amount = params.local_funding_amount_sats;
    const peerPubkey = params.peer_pubkey;
    const isPrivate = params.private || false;
    const feeConstraints = params.fee_constraints || null;
    const peerAlias = peerInfo?.node?.alias || 'unknown';

    // Acquire mutex for this agent's capital operations
    const unlock = await this._mutex.acquire(`channel-open:${agentId}`);
    try {
      await this._appendProof({
        idempotency_key: proofSafeKey('channel_open_instruction_accepted', {
          agent_id: agentId,
          instruction_hash: instrHash,
        }),
        proof_record_type: 'money_lifecycle',
        money_event_type: 'channel_open_instruction_accepted',
        money_event_status: 'confirmed',
        agent_id: agentId,
        event_source: 'channel_open',
        authorization_method: 'agent_signed_instruction',
        primary_amount_sats: amount,
        public_safe_refs: {
          amount_sats: amount,
          instruction_hash: instrHash,
          peer_pubkey: peerPubkey,
          status: 'accepted',
        },
      });

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
        startup_policy: startupPolicy,
        startup_policy_apply_status: startupPolicyNeedsActivationStep(startupPolicy) ? 'pending' : null,
        private: isPrivate,
        instruction_hash: instrHash,
      };
      await this._persist();

      // Mark instruction as seen (dedup)
      await this._dedup.mark(instrHash);

      // Connect peer (best effort — may already be connected)
      const client = this._nodeManager.getScopedDefaultNodeOrNull('open');
      if (client && safePeerAddress) {
        try {
          await client.connectPeer(peerPubkey, safePeerAddress);
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
          baseFeeMsat: readOptionalInteger(startupPolicy?.base_fee_msat),
          feeRatePpm: readOptionalInteger(startupPolicy?.fee_rate_ppm),
          minHtlcMsat: readOptionalInteger(startupPolicy?.min_htlc_msat),
          timeoutMs: this.config.openRequestTimeoutMs,
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
        startup_policy: startupPolicy,
        startup_policy_apply_status: startupPolicyNeedsActivationStep(startupPolicy) ? 'pending' : null,
        private: isPrivate,
        instruction_hash: instrHash,
      };
      await this._persist();

      await this._appendProofBestEffort({
        idempotency_key: proofSafeKey('channel_open_submitted', {
          agent_id: agentId,
          channel_point: channelPoint,
          instruction_hash: instrHash,
        }),
        proof_record_type: 'money_lifecycle',
        money_event_type: 'channel_open_submitted',
        money_event_status: 'submitted',
        agent_id: agentId,
        event_source: 'channel_open',
        authorization_method: 'agent_signed_instruction',
        primary_amount_sats: amount,
        public_safe_refs: {
          amount_sats: amount,
          channel_point: channelPoint,
          txid: fundingTxidStr,
          instruction_hash: instrHash,
          peer_pubkey: peerPubkey,
          status: 'submitted',
        },
      }, 'channel_open_submitted');

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
        startup_policy: startupPolicy,
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
          instruction_hash: instrHash,
          peer_pubkey: peerPubkey,
          peer_alias: peerAlias,
          local_funding_amount_sats: amount,
          private: isPrivate,
          startup_policy: startupPolicy,
        },
        learn: 'Your channel open has been submitted to the Bitcoin network. ' +
          `Track funding transaction ${fundingTxidStr} and keep checking aol_get_market_pending. ` +
          'The channel becomes usable when LND marks it active; once that happens, it will be auto-assigned to you. ' +
          'Any startup policy fields that need an active channel will be applied automatically. ' +
          'Track progress with aol_get_market_pending.',
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
    this._stopping = false;
    console.log(`[ChannelOpener] Starting channel confirmation polling every ${intervalMs / 1000}s`);
    this._pollTimer = setInterval(() => {
      this.pollPendingChannels().catch(err => {
        if (!this._stopping) {
          console.error(`[ChannelOpener] Poll error: ${err.message}`);
        }
      });
    }, intervalMs);
  }

  stopPolling() {
    this._stopping = true;
    if (this._pollTimer) {
      clearInterval(this._pollTimer);
      this._pollTimer = null;
      console.log('[ChannelOpener] Polling stopped');
    }
  }

  async pollPendingChannels() {
    const pendingEntries = Object.entries(this._state).filter(([, e]) =>
      e.status === 'pending_open' ||
      (e.status === 'active' && e.startup_policy_apply_status === 'pending')
    );
    if (pendingEntries.length === 0) return;

    const client = this._nodeManager.getScopedDefaultNodeOrNull('open');
    if (!client) return;

    // Call listChannels once and build lookup by channel_point
    let channelsResp;
    try {
      channelsResp = await client.listChannels();
    } catch (err) {
      if (!this._stopping) {
        console.error(`[ChannelOpener] listChannels failed: ${err.message}`);
      }
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
        const activeCapacitySats = Number.parseInt(activeChannel.capacity || '0', 10);
        const safeActiveCapacitySats = Number.isSafeInteger(activeCapacitySats) ? activeCapacitySats : null;

        if (entry.status !== 'active') {
          try {
            await this._assignmentRegistry.assign(
              chanId,
              channelPoint,
              entry.agent_id,
              {
                remote_pubkey: entry.peer_pubkey,
                capacity: safeActiveCapacitySats,
              },
              entry.fee_constraints,
            );
          } catch (err) {
            // Already assigned (409) is OK — idempotent
            if (err.status !== 409) {
              if (!this._stopping) {
                console.error(`[ChannelOpener] Assignment failed for ${channelPoint}: ${err.message}`);
              }
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
            capacity: safeActiveCapacitySats,
            local_funding_amount: entry.local_funding_amount,
          });

          await this._appendProofBestEffort({
            idempotency_key: proofSafeKey('channel_open_active', {
              agent_id: entry.agent_id,
              chan_id: chanId,
              channel_point: channelPoint,
            }),
            proof_record_type: 'money_lifecycle',
            money_event_type: 'channel_open_active',
            money_event_status: 'confirmed',
            agent_id: entry.agent_id,
            event_source: 'channel_open',
            authorization_method: 'system_settlement',
            primary_amount_sats: safeActiveCapacitySats,
            public_safe_refs: {
              amount_sats: safeActiveCapacitySats,
              chan_id: chanId,
              channel_point: channelPoint,
              peer_pubkey: entry.peer_pubkey,
              status: 'active',
            },
          }, 'channel_open_active');

          entry.status = 'active';
          entry.chan_id = chanId;
          entry.confirmed_at = new Date().toISOString();
          stateChanged = true;

          console.log(`[ChannelOpener] Channel confirmed: ${channelPoint} (${entry.peer_alias}) — assigned to ${entry.agent_id}`);
        }

        if (entry.startup_policy_apply_status === 'pending' && entry.startup_policy) {
          try {
            const policyClient = this._nodeManager.getScopedDefaultNodeOrNull('policy');
            if (!policyClient) {
              throw new Error('LND fee-policy client not available');
            }
            await this._applyStartupPolicy(policyClient, channelPoint, activeChannel, entry.startup_policy);
            entry.startup_policy_apply_status = 'applied';
            delete entry.startup_policy_last_error;
            stateChanged = true;
            await this._auditLog.append({
              domain: 'channel_market',
              type: 'channel_open_startup_policy_applied',
              agent_id: entry.agent_id,
              chan_id: chanId,
              channel_point: channelPoint,
              startup_policy: entry.startup_policy,
            });
          } catch (err) {
            if (entry.startup_policy_last_error !== err.message && !this._stopping) {
              console.warn(`[ChannelOpener] Startup policy apply failed for ${channelPoint}: ${err.message}`);
            }
            entry.startup_policy_last_error = err.message;
            stateChanged = true;
          }
        }
      } else if (entry.status === 'pending_open' &&
                 entry.request_block_height > 0 &&
                 currentBlockHeight - entry.request_block_height > this.config.pendingOpenTimeoutBlocks) {
        // Timed out — unlock funds
        try {
          await this._capitalLedger.unlockForFailedOpen(
            entry.agent_id,
            entry.local_funding_amount,
            channelPoint,
          );
        } catch (err) {
          if (!this._stopping) {
            console.error(`[ChannelOpener] Timeout unlock failed for ${entry.agent_id}: ${err.message}`);
          }
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
        startup_policy: entry.startup_policy || null,
        startup_policy_apply_status: entry.startup_policy_apply_status || null,
      });
    }
    return results;
  }

  /**
   * Get public configuration for agents.
   */
  getConfig() {
    return {
      channel_size_policy: 'server_enforced',
      min_channel_size_sats: this.config.minChannelSizeSats,
      max_channel_size_sats: this.config.maxChannelSizeSats,
      channel_count_policy: 'server_enforced',
      activation_source: 'lnd_active',
      operator_subsidizes_on_chain_fee: false,
      on_chain_fee_policy: 'do_not_assume_operator_subsidy',
      peer_safety: {
        requires_public_address: true,
        force_close_policy: 'enforced',
        admission_policy: 'server_enforced',
      },
      startup_policy_support: {
        set_at_open: ['base_fee_msat', 'fee_rate_ppm', 'min_htlc_msat'],
        applied_after_activation: ['time_lock_delta', 'max_htlc_msat'],
      },
      learn: 'These are the current limits for channel opens on this node. ' +
        `The current channel size range is ${this.config.minChannelSizeSats} to ${this.config.maxChannelSizeSats} sats. ` +
        'Do not assume the operator subsidizes Bitcoin mining fees; live cost/proof results and policy fields are the source of truth. ' +
        'Your local_funding_amount_sats is the intended channel capacity and you need at least that much available channel capital before preview or open can succeed. ' +
        'If available capital is zero or below the requested channel size, stop and fund channel capital first. ' +
        'A pending open becomes usable when LND marks the channel active. ' +
        'At open time you may request base_fee_msat, fee_rate_ppm, and min_htlc_msat. ' +
        'If you also request time_lock_delta or max_htlc_msat, the app will apply them automatically after activation. ' +
        'Peer must advertise a public address and pass the peer-safety gate. ' +
        'Use aol_build_open_channel_instruction, aol_preview_open_channel, and aol_open_channel for the open flow.',
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

  async _applyStartupPolicy(client, channelPoint, activeChannel, startupPolicy) {
    const report = await client.feeReport();
    const current = report.channel_fees?.find((fee) => fee.channel_point === channelPoint);
    if (!current) {
      throw new Error('Channel not yet visible in LND fee report');
    }

    const baseFeeMsat = startupPolicy.base_fee_msat ?? parseInt(current.base_fee_msat || '0', 10);
    const feeRatePpm = startupPolicy.fee_rate_ppm ?? parseInt(current.fee_per_mil || '0', 10);
    const timeLockDelta = startupPolicy.time_lock_delta ?? current.time_lock_delta ?? 40;
    const minHtlcMsat = startupPolicy.min_htlc_msat ?? (
      current.min_htlc_msat != null ? parseInt(current.min_htlc_msat, 10) : null
    );
    const maxHtlcMsat = startupPolicy.max_htlc_msat ?? (
      current.max_htlc_msat != null ? parseInt(current.max_htlc_msat, 10) : null
    );

    const capacitySats = parseInt(activeChannel.capacity || '0', 10);
    const capacityMsat = capacitySats > 0 ? capacitySats * 1000 : null;
    if (capacityMsat != null && maxHtlcMsat != null && maxHtlcMsat > capacityMsat) {
      throw new Error(`max_htlc_msat ${maxHtlcMsat} exceeds channel capacity ${capacityMsat}`);
    }

    await client.updateChannelPolicy(
      channelPoint,
      baseFeeMsat,
      feeRatePpm,
      timeLockDelta,
      maxHtlcMsat,
      minHtlcMsat,
    );
  }

}
