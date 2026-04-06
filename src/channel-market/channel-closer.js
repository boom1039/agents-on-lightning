/**
 * Channel Closer — Validates, initiates, polls, and settles channel closes.
 *
 * Handles the full lifecycle of agent-initiated and peer-initiated channel closes:
 *   1. 8-step fail-fast validation pipeline (secp256k1-signed requests)
 *   2. Capital ledger initiateClose (locked → pending_close)
 *   3. LND closeChannel call (cooperative or force)
 *   4. Background polling: closedChannels() → settlement detection
 *   5. Capital ledger settleClose (pending_close → available)
 *   6. Assignment registry cleanup
 *   7. Crash recovery for in-flight closes
 *
 * State persisted to disk — survives Express restarts.
 * Follows ChannelOpener pattern for state management.
 */

import { DedupCache } from '../channel-accountability/dedup-cache.js';
import { validateSignedInstruction } from '../channel-accountability/signed-instruction-validation.js';
import { appendSignedValidationFailure } from '../channel-accountability/signed-validation-fingerprint.js';

const STATE_PATH = 'data/channel-market/pending-closes.json';

const CHANNEL_CLOSE_CONFIG = {
  cooperativeTimeoutMs: 600_000,       // 10m for cooperative close attempt
  pollIntervalMs: 15_000,             // 15s — closer state should refresh quickly
  maxPendingCloses: 50,
  defaultSatPerVbyte: null,           // null = let LND estimate
};

function parsePositiveSats(value) {
  if (Number.isInteger(value) && value > 0) return value;
  if (typeof value === 'string' && /^\d+$/.test(value)) {
    const parsed = Number.parseInt(value, 10);
    if (Number.isSafeInteger(parsed) && parsed > 0) return parsed;
  }
  return null;
}

function isUntrackedPeerCloseLedgerError(err) {
  return /Insufficient locked balance/i.test(String(err?.message || ''));
}

function isIndeterminateCloseError(err) {
  const code = String(err?.code || '').trim();
  const message = String(err?.message || '').trim();
  if (['ETIMEDOUT', 'ECONNRESET', 'EPIPE', 'UND_ERR_SOCKET'].includes(code)) return true;
  return /timed out|timeout|socket|hang up|connection reset|network/i.test(message);
}

function normalizeCloseErrorMessage(err) {
  const raw = String(err?.message || 'Channel close failed').trim();
  if (/timed out|timeout/i.test(raw)) {
    return 'The node did not answer before the close timeout. The channel may still be closing.';
  }
  if (/peer .*disconnected/i.test(raw)) {
    return 'The node lost the peer during the real channel-close attempt.';
  }
  if (/channel not found/i.test(raw)) {
    return 'The node could not find that channel.';
  }
  return raw || 'Channel close failed.';
}

/**
 * Educational hints for validation failures.
 */
const HINTS = {
  missing_payload:
    'Send { "instruction": { "action": "channel_close", ... }, "signature": "hex" }. ' +
    'The instruction must contain action, agent_id, timestamp, and params with channel_point.',

  wrong_action:
    'Only "channel_close" accepted at this endpoint. ' +
    'For channel opens, use POST /api/v1/market/open.',

  channel_not_found:
    'Channel not found in assignment registry. You can only close channels assigned to you. ' +
    'GET /api/v1/channels/mine to see your assigned channels.',

  channel_not_yours:
    'This channel is assigned to a different agent. You can only close your own channels.',

  missing_channel_point:
    'params.channel_point is required. Format: "txid:vout" (e.g., "abc123...def:0").',
};

export class ChannelCloser {
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
  constructor({ capitalLedger, nodeManager, dataLayer, auditLog, agentRegistry, assignmentRegistry, mutex, config = {} }) {
    if (!capitalLedger) throw new Error('ChannelCloser requires capitalLedger');
    if (!nodeManager) throw new Error('ChannelCloser requires nodeManager');
    if (!dataLayer) throw new Error('ChannelCloser requires dataLayer');
    if (!auditLog) throw new Error('ChannelCloser requires auditLog');
    if (!agentRegistry) throw new Error('ChannelCloser requires agentRegistry');
    if (!assignmentRegistry) throw new Error('ChannelCloser requires assignmentRegistry');
    if (!mutex) throw new Error('ChannelCloser requires mutex');

    this._capitalLedger = capitalLedger;
    this._nodeManager = nodeManager;
    this._dataLayer = dataLayer;
    this._auditLog = auditLog;
    this._agentRegistry = agentRegistry;
    this._assignmentRegistry = assignmentRegistry;
    this._mutex = mutex;

    // channel_point → pending close entry
    this._state = {};
    this._pollTimer = null;
    this._stopping = false;
    this._refreshInFlight = null;
    this._lastRefreshAt = 0;

    // Dedup cache (10-minute expiry window)
    this._dedup = new DedupCache(600_000, {
      dataLayer,
      path: 'data/channel-market/channel-close-dedup.json',
    });

    this.config = { ...CHANNEL_CLOSE_CONFIG, ...config };
  }

  logStartupRules() {
    console.log(`[ChannelCloser] Live close rules ${JSON.stringify({
      cooperativeTimeoutMs: this.config.cooperativeTimeoutMs,
      pollIntervalMs: this.config.pollIntervalMs,
      defaultSatPerVbyte: this.config.defaultSatPerVbyte,
      maxPendingCloses: this.config.maxPendingCloses,
    })}`);
  }

  // ---------------------------------------------------------------------------
  // State persistence
  // ---------------------------------------------------------------------------

  async load() {
    try {
      const raw = await this._dataLayer.readJSON(STATE_PATH);
      this._state = raw || {};

      const entries = Object.values(this._state);
      const pending = entries.filter(e => e.status === 'pending_close' || e.status === 'close_submitted_unknown').length;
      const settling = entries.filter(e => e.status === 'settling').length;
      console.log(
        `[ChannelCloser] Loaded ${entries.length} entries ` +
        `(${pending} pending, ${settling} settling)`
      );
    } catch (err) {
      if (err.code === 'ENOENT') {
        this._state = {};
        console.log('[ChannelCloser] No existing state — starting fresh');
      } else {
        throw err;
      }
    }
  }

  async _persist() {
    await this._dataLayer.writeJSON(STATE_PATH, this._state);
  }

  _logError(message) {
    if (!this._stopping) console.error(message);
  }

  _logWarn(message) {
    if (!this._stopping) console.warn(message);
  }

  // ---------------------------------------------------------------------------
  // Polling
  // ---------------------------------------------------------------------------

  startPolling(intervalMs = this.config.pollIntervalMs) {
    if (this._pollTimer) return;
    this._stopping = false;
    this._pollTimer = setInterval(() => this._pollCycle(), intervalMs);
    console.log(`[ChannelCloser] Polling every ${intervalMs / 1000}s`);
  }

  stopPolling() {
    this._stopping = true;
    if (this._pollTimer) {
      clearInterval(this._pollTimer);
      this._pollTimer = null;
    }
  }

  async _pollCycle() {
    if (this._stopping) return;
    try {
      await this._detectSettledCloses();
      await this._detectPeerInitiatedCloses();
    } catch (err) {
      this._logError(`[ChannelCloser] Poll error: ${err.message}`);
    }
  }

  async refreshNow({ force = false } = {}) {
    const now = Date.now();
    if (!force && this._refreshInFlight) return this._refreshInFlight;
    if (!force && (now - this._lastRefreshAt) < 5_000) return;
    this._refreshInFlight = (async () => {
      await this._pollCycle();
      this._lastRefreshAt = Date.now();
    })().finally(() => {
      this._refreshInFlight = null;
    });
    return this._refreshInFlight;
  }

  // ---------------------------------------------------------------------------
  // Detect settled closes (agent-initiated)
  // ---------------------------------------------------------------------------

  async _detectSettledCloses() {
    const pendingEntries = Object.entries(this._state).filter(
      ([, e]) => e.status === 'pending_close'
        || e.status === 'settling'
        || e.status === 'close_submitted_unknown'
        || e.status === 'close_failed'
    );
    if (pendingEntries.length === 0) return;

    const client = this._nodeManager.getScopedDefaultNodeOrNull('operator');
    if (!client) return;

    let closedResp;
    try {
      closedResp = await client.closedChannels();
    } catch (err) {
      this._logError(`[ChannelCloser] closedChannels() failed: ${err.message}`);
      return;
    }

    const closedChannels = closedResp.channels || [];
    const closedByPoint = new Map();
    for (const ch of closedChannels) {
      if (ch.channel_point) {
        closedByPoint.set(ch.channel_point, ch);
      }
    }

    let changed = false;
    for (const [channelPoint, entry] of pendingEntries) {
      const closed = closedByPoint.get(channelPoint);
      if (!closed) continue;

      // Channel has been closed on-chain
      const settledBalance = parseInt(closed.settled_balance || '0', 10);
      const closingTxid = closed.closing_tx_hash || 'unknown';

      try {
        await this._capitalLedger.reconcileClosedChannel(entry.agent_id, {
          settledAmount: settledBalance,
          txid: closingTxid,
          channelPoint,
          originalLocked: parsePositiveSats(entry.original_locked) || 0,
          localBalanceAtClose: Math.max(0, Number(entry.local_balance_at_close || 0)),
        });
      } catch (err) {
        this._logError(`[ChannelCloser] settleClose failed for ${entry.agent_id}: ${err.message}`);
        continue;
      }

      // Revoke assignment
      try {
        await this._assignmentRegistry.revoke(channelPoint);
      } catch (err) {
        // Already revoked or not found — not fatal
        if (err.status !== 404) {
          this._logWarn(`[ChannelCloser] revoke warning for ${channelPoint}: ${err.message}`);
        }
      }

      await this._auditLog.append({
        type: 'channel_closed',
        agent_id: entry.agent_id,
        channel_point: channelPoint,
        settled_balance_sats: settledBalance,
        close_type: closed.close_type || entry.close_type || 'unknown',
        closing_txid: closingTxid,
        original_funding_sats: entry.original_locked || 0,
        local_balance_at_close: entry.local_balance_at_close || 0,
      });

      entry.status = 'settled';
      entry.settled_at = Date.now();
      entry.settled_balance = settledBalance;
      entry.closing_txid = closingTxid;
      delete entry.error;
      changed = true;

      console.log(
        `[ChannelCloser] Settled close: ${channelPoint} → ${settledBalance} sats to ${entry.agent_id}`
      );
    }

    if (changed) await this._persist();
  }

  // ---------------------------------------------------------------------------
  // Detect peer-initiated closes (not requested by agent)
  // ---------------------------------------------------------------------------

  async _detectPeerInitiatedCloses() {
    const client = this._nodeManager.getScopedDefaultNodeOrNull('operator');
    if (!client) return;

    let closedResp;
    try {
      closedResp = await client.closedChannels();
    } catch (err) {
      return; // Already logged above
    }

    const closedChannels = closedResp.channels || [];
    const assignedPoints = this._assignmentRegistry.getAssignedChannelPoints();

    let changed = false;
    for (const ch of closedChannels) {
      if (!ch.channel_point || !assignedPoints.has(ch.channel_point)) continue;
      // Skip if we already have a pending/settled entry for this channel
      if (this._state[ch.channel_point]) continue;

      const assignment = this._assignmentRegistry.getAssignmentByPoint(ch.channel_point);
      if (!assignment) continue;

      const settledBalance = parseInt(ch.settled_balance || '0', 10);
      const closingTxid = ch.closing_tx_hash || 'unknown';
      const originalLocked = parsePositiveSats(assignment.capacity);
      if (originalLocked == null) {
        this._logError(
          `[ChannelCloser] Peer-initiated close skipped for ${assignment.agent_id}: ` +
          `invalid assignment capacity ${assignment.capacity}`
        );
        continue;
      }

      // Initiate + settle in one step (close already happened)
      try {
        await this._capitalLedger.initiateClose(
          assignment.agent_id, settledBalance, originalLocked, ch.channel_point
        );
        await this._capitalLedger.settleClose(assignment.agent_id, settledBalance, closingTxid);
      } catch (err) {
        if (isUntrackedPeerCloseLedgerError(err)) {
          await this._auditLog.append({
            type: 'channel_closed_by_peer_untracked',
            agent_id: assignment.agent_id,
            channel_point: ch.channel_point,
            settled_balance_sats: settledBalance,
            close_type: ch.close_type || 'peer_initiated',
            closing_txid: closingTxid,
            note: 'No matching locked capital was present in the ledger.',
          });
          try {
            await this._assignmentRegistry.revoke(ch.channel_point);
          } catch (revokeErr) {
            if (revokeErr.status !== 404) {
              this._logWarn(`[ChannelCloser] revoke warning: ${revokeErr.message}`);
            }
          }
          this._state[ch.channel_point] = {
            agent_id: assignment.agent_id,
            channel_point: ch.channel_point,
            status: 'external_settled',
            close_type: 'peer_initiated',
            settled_balance: settledBalance,
            closing_txid: closingTxid,
            detected_at: Date.now(),
            settled_at: Date.now(),
          };
          changed = true;
          this._logWarn(
            `[ChannelCloser] Recorded external peer close for ${assignment.agent_id} on ${ch.channel_point}; no locked capital was available to settle.`
          );
          continue;
        }
        this._logError(
          `[ChannelCloser] Peer-initiated close ledger error for ${assignment.agent_id}: ${err.message}`
        );
        continue;
      }

      try {
        await this._assignmentRegistry.revoke(ch.channel_point);
      } catch (err) {
        if (err.status !== 404) {
          this._logWarn(`[ChannelCloser] revoke warning: ${err.message}`);
        }
      }

      await this._auditLog.append({
        type: 'channel_closed_by_peer',
        agent_id: assignment.agent_id,
        channel_point: ch.channel_point,
        settled_balance_sats: settledBalance,
        close_type: ch.close_type || 'peer_initiated',
        closing_txid: closingTxid,
      });

      this._state[ch.channel_point] = {
        agent_id: assignment.agent_id,
        channel_point: ch.channel_point,
        status: 'settled',
        close_type: 'peer_initiated',
        settled_balance: settledBalance,
        closing_txid: closingTxid,
        detected_at: Date.now(),
        settled_at: Date.now(),
      };
      changed = true;

      console.log(
        `[ChannelCloser] Peer-initiated close detected: ${ch.channel_point} → ` +
        `${settledBalance} sats to ${assignment.agent_id}`
      );
    }

    if (changed) await this._persist();
  }

  // ---------------------------------------------------------------------------
  // Validation pipeline (8 steps, fail-fast)
  // ---------------------------------------------------------------------------

  async _validate(agentId, payload) {
    // Steps 1–7: shared signed-instruction validation
    const shared = await validateSignedInstruction({
      agentId, payload, expectedAction: 'channel_close',
      agentRegistry: this._agentRegistry, dedup: this._dedup,
      actionHints: HINTS,
      onFailureFingerprint: (fingerprint) => appendSignedValidationFailure({
        dataLayer: this._dataLayer,
        routeFamily: 'market_close',
        operation: 'validate',
        agentId,
        expectedAction: 'channel_close',
        fingerprint,
      }),
    });
    if (!shared.success) return shared;

    const { checks_passed, instrHash, params } = shared;

    // Step 8: channel_ownership
    if (!params.channel_point || typeof params.channel_point !== 'string') {
      return {
        success: false, error: 'params.channel_point is required',
        hint: HINTS.missing_channel_point, status: 400,
        failed_at: 'channel_ownership', checks_passed,
      };
    }

    const assignment = this._assignmentRegistry.getAssignmentByPoint(params.channel_point);
    if (!assignment) {
      return {
        success: false, error: 'Channel not found in assignment registry',
        hint: HINTS.channel_not_found, status: 404,
        failed_at: 'channel_ownership', checks_passed,
      };
    }
    if (assignment.agent_id !== agentId) {
      return {
        success: false, error: 'Channel is assigned to a different agent',
        hint: HINTS.channel_not_yours, status: 403,
        failed_at: 'channel_ownership', checks_passed,
      };
    }
    checks_passed.push('channel_ownership');

    // Mark instruction used
    await this._dedup.mark(instrHash);

    return {
      success: true,
      checks_passed,
      assignment,
      params,
      instrHash,
    };
  }

  // ---------------------------------------------------------------------------
  // Close request
  // ---------------------------------------------------------------------------

  async requestClose(agentId, payload) {
    const validation = await this._validate(agentId, payload);
    if (!validation.success) return validation;

    const { assignment, params } = validation;
    const channelPoint = params.channel_point;
    const force = params.force === true;

    // Already pending close?
    if (this._state[channelPoint] && (
      this._state[channelPoint].status === 'pending_close'
      || this._state[channelPoint].status === 'settling'
      || this._state[channelPoint].status === 'close_submitted_unknown'
    )) {
      return {
        success: false,
        error: 'Channel close already in progress',
        status: 409,
        pending_since: this._state[channelPoint].requested_at,
      };
    }

    // Get current local balance from LND
    const client = this._nodeManager.getScopedDefaultNodeOrNull('operator');
    if (!client) {
      return { success: false, error: 'LND not available', status: 503 };
    }

    let localBalance = 0;
    let channelActive = false;
    try {
      const listResp = await client.listChannels();
      const channels = listResp.channels || [];
      const match = channels.find(c => c.channel_point === channelPoint);
      if (match) {
        localBalance = parseInt(match.local_balance || '0', 10);
        channelActive = match.active !== false;
      } else {
        // Check pending channels — might be pending open still
        const pendingResp = await client.pendingChannels();
        const pendingOpen = (pendingResp.pending_open_channels || []).find(
          p => p.channel?.channel_point === channelPoint
        );
        if (pendingOpen) {
          return {
            success: false,
            error: 'Channel is still pending confirmation — cannot close yet',
            hint: 'Wait until LND marks the channel active before closing.',
            status: 400,
          };
        }
        return {
          success: false,
          error: 'Channel not found in LND',
          hint: 'The channel may have already been closed. Check GET /api/v1/market/closes.',
          status: 404,
        };
      }
    } catch (err) {
      return { success: false, error: `LND query failed: ${err.message}`, status: 503 };
    }

    const originalLocked = assignment.capacity || 0;

    // Capital ledger: initiateClose
    const unlock = await this._mutex.acquire(`close:${channelPoint}`);
    try {
      await this._capitalLedger.initiateClose(agentId, localBalance, originalLocked, channelPoint);
    } catch (err) {
      unlock();
      return {
        success: false,
        error: `Capital ledger error: ${err.message}`,
        status: 500,
      };
    }

    // Record pending close state BEFORE calling LND
    const entry = {
      agent_id: agentId,
      channel_point: channelPoint,
      status: 'pending_close',
      close_type: force ? 'force' : 'cooperative',
      local_balance_at_close: localBalance,
      original_locked: originalLocked,
      routing_pnl: originalLocked - localBalance,
      requested_at: Date.now(),
      peer_pubkey: assignment.remote_pubkey,
    };
    this._state[channelPoint] = entry;
    await this._persist();
    unlock();

    // Initiate LND close
    try {
      await client.closeChannel(channelPoint, force, this.config.defaultSatPerVbyte, {
        timeoutMs: this.config.cooperativeTimeoutMs,
      });
    } catch (err) {
      const normalizedError = normalizeCloseErrorMessage(err);
      if (isIndeterminateCloseError(err)) {
        entry.status = 'close_submitted_unknown';
        entry.error = normalizedError;
        entry.last_error_at = Date.now();
        await this._persist();

        await this._auditLog.append({
          type: 'channel_close_submission_unknown',
          agent_id: agentId,
          channel_point: channelPoint,
          close_type: force ? 'force' : 'cooperative',
          error: normalizedError,
          original_error: String(err?.message || ''),
        });

        return {
          success: true,
          http_status: 202,
          status: 'close_submitted_unknown',
          channel_point: channelPoint,
          close_type: force ? 'force' : 'cooperative',
          local_balance_at_close: localBalance,
          original_funding_sats: originalLocked,
          routing_pnl_sats: -(originalLocked - localBalance),
          message: normalizedError,
          hint: 'Check GET /api/v1/market/closes and GET /api/v1/capital/balance. Do not retry the close right away.',
          learn: 'Channel closes can finish after the first request times out. The system will keep checking the node and settle your balance when the close shows up.',
        };
      }

      // Close call failed and looks definitive — roll the ledger back.
      entry.status = 'close_failed';
      entry.error = normalizedError;
      entry.last_error_at = Date.now();
      await this._persist();

      try {
        await this._capitalLedger.rollbackInitiatedClose(
          agentId,
          localBalance,
          originalLocked,
          channelPoint,
          'lnd-close-failed',
        );
      } catch (ledgerErr) {
        this._logError(`[ChannelCloser] Failed to roll back ledger for ${channelPoint}: ${ledgerErr.message}`);
      }

      return {
        success: false,
        error: `Channel close failed: ${normalizedError}`,
        status: 500,
      };
    }

    await this._auditLog.append({
      type: 'channel_close_requested',
      agent_id: agentId,
      channel_point: channelPoint,
      close_type: force ? 'force' : 'cooperative',
      local_balance_sats: localBalance,
      original_locked_sats: originalLocked,
    });

    const routingPnl = originalLocked - localBalance;
    return {
      success: true,
      status: 'pending_close',
      channel_point: channelPoint,
      close_type: force ? 'force' : 'cooperative',
      local_balance_at_close: localBalance,
      original_funding_sats: originalLocked,
      routing_pnl_sats: -routingPnl,
      message: `Channel close initiated. ` +
        (force
          ? 'Force close may take 144+ blocks (~24 hours) to settle.'
          : 'Cooperative close typically confirms within 1-2 blocks.') +
        ` Your local balance of ${localBalance.toLocaleString()} sats will be credited after confirmation.`,
      learn: routingPnl !== 0
        ? `Your channel was funded with ${originalLocked.toLocaleString()} sats but your local balance is ` +
          `now ${localBalance.toLocaleString()}. The difference (${(-routingPnl).toLocaleString()} sats) is routing P&L — ` +
          `this means ${routingPnl > 0 ? `${routingPnl.toLocaleString()} more sats were routed outbound than inbound` : `${Math.abs(routingPnl).toLocaleString()} more sats were routed inbound than outbound`} ` +
          `through this channel. This is normal. Fee revenue earned on those forwards is tracked separately ` +
          `(see GET /api/v1/market/revenue).`
        : 'Your local balance matches your original funding — the channel had balanced routing or no routing activity.',
    };
  }

  // ---------------------------------------------------------------------------
  // Query methods
  // ---------------------------------------------------------------------------

  getPendingForAgent(agentId) {
    return Object.values(this._state).filter(
      e => e.agent_id === agentId && (
        e.status === 'pending_close'
        || e.status === 'settling'
        || e.status === 'close_submitted_unknown'
      )
    );
  }

  getClosesForAgent(agentId) {
    return Object.values(this._state).filter(e => e.agent_id === agentId);
  }

  getAllPending() {
    return Object.values(this._state).filter(
      e => e.status === 'pending_close'
        || e.status === 'settling'
        || e.status === 'close_submitted_unknown'
    );
  }
}
