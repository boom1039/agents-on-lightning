/**
 * Capital Ledger — Double-entry accounting for agent channel capital.
 *
 * Tracks on-chain Bitcoin deposited by agents for channel operations.
 * Separate from the Cashu wallet (ecash proofs). This handles real
 * on-chain capital: deposits, locks, unlocks, withdrawals, revenue credits.
 *
 * Invariant enforced on every write:
 *   total_deposited + total_revenue_credited + total_ecash_funded =
 *     available + locked + pending_deposit + pending_close +
 *     total_withdrawn + total_routing_pnl
 *
 * Every state change is:
 *   1. Mutex-protected (per-agent)
 *   2. Validated (no negative balances)
 *   3. Atomically written (write-to-tmp + rename)
 *   4. Activity-logged (JSONL)
 *   5. Audit-chained (tamper-evident hash chain)
 */

const STATE_DIR = 'data/channel-market/capital';
const MAX_PROCESSED_REFS = 10_000;

/**
 * Creates a fresh zero-balance state object.
 */
function emptyState() {
  return {
    available: 0,
    locked: 0,
    pending_deposit: 0,
    pending_close: 0,
    total_deposited: 0,
    total_withdrawn: 0,
    total_revenue_credited: 0,
    total_ecash_funded: 0,
    total_routing_pnl: 0,
    processed_refs: [],
    last_updated: new Date().toISOString(),
  };
}

/**
 * Validate agent ID format. Must be non-empty string, alphanumeric + hyphens.
 */
function assertAgentId(agentId) {
  if (!agentId || typeof agentId !== 'string') {
    throw new Error('Invalid agent ID: must be a non-empty string');
  }
  if (!/^[a-zA-Z0-9_-]+$/.test(agentId)) {
    throw new Error('Invalid agent ID: only alphanumeric, hyphens, and underscores allowed');
  }
}

/**
 * Validate sat amount. Must be a positive integer.
 */
function assertPositiveSats(amount, label) {
  if (!Number.isInteger(amount) || amount <= 0) {
    throw new Error(`${label}: must be a positive integer (got ${amount})`);
  }
}

/**
 * Validate sat amount. Must be a non-negative integer.
 */
function assertNonNegativeSats(amount, label) {
  if (!Number.isInteger(amount) || amount < 0) {
    throw new Error(`${label}: must be a non-negative integer (got ${amount})`);
  }
}

/**
 * Verify the double-entry invariant. Throws if violated.
 *
 * total_deposited + total_revenue_credited + total_ecash_funded =
 *   available + locked + pending_deposit + pending_close +
 *   total_withdrawn + total_routing_pnl
 */
function assertInvariant(state, context) {
  const lhs = state.total_deposited + state.total_revenue_credited + state.total_ecash_funded;
  const rhs = state.available + state.locked + state.pending_deposit +
              state.pending_close + state.total_withdrawn + state.total_routing_pnl;
  if (lhs !== rhs) {
    throw new Error(
      `INVARIANT VIOLATION [${context}]: ` +
      `total_deposited(${state.total_deposited}) + total_revenue_credited(${state.total_revenue_credited}) + ` +
      `total_ecash_funded(${state.total_ecash_funded}) = ${lhs} != ` +
      `available(${state.available}) + locked(${state.locked}) + pending_deposit(${state.pending_deposit}) + ` +
      `pending_close(${state.pending_close}) + total_withdrawn(${state.total_withdrawn}) + ` +
      `total_routing_pnl(${state.total_routing_pnl}) = ${rhs}`
    );
  }
}

/**
 * Assert that no balance field is negative.
 */
function assertNoNegativeBalances(state, context) {
  const fields = ['available', 'locked', 'pending_deposit', 'pending_close',
                  'total_deposited', 'total_withdrawn', 'total_revenue_credited',
                  'total_ecash_funded'];
  for (const field of fields) {
    if (state[field] < 0) {
      throw new Error(`NEGATIVE BALANCE [${context}]: ${field} = ${state[field]}`);
    }
  }
  // total_routing_pnl can be negative (agent gained from routing)
  // but we still validate it's a finite number
  if (!Number.isFinite(state.total_routing_pnl)) {
    throw new Error(`INVALID [${context}]: total_routing_pnl = ${state.total_routing_pnl}`);
  }
}

/**
 * Check idempotency — reject duplicate refs. Adds ref on success.
 * Caps processed_refs at MAX_PROCESSED_REFS (sliding window).
 */
function assertNotDuplicate(state, ref, context) {
  if (!state.processed_refs) state.processed_refs = [];
  if (state.processed_refs.includes(ref)) {
    throw new Error(`Duplicate operation [${context}]: ref '${ref}' already processed`);
  }
  state.processed_refs.push(ref);
  if (state.processed_refs.length > MAX_PROCESSED_REFS) {
    state.processed_refs = state.processed_refs.slice(-MAX_PROCESSED_REFS);
  }
}

export class CapitalLedger {
  /**
   * @param {object} opts
   * @param {import('../data-layer.js').DataLayer} opts.dataLayer
   * @param {import('../channel-accountability/hash-chain-audit-log.js').HashChainAuditLog} opts.auditLog
   * @param {{ acquire: (key: string) => Promise<() => void> }} opts.mutex
   */
  constructor({ dataLayer, auditLog, mutex }) {
    if (!dataLayer) throw new Error('CapitalLedger requires dataLayer');
    if (!auditLog) throw new Error('CapitalLedger requires auditLog');
    if (!mutex) throw new Error('CapitalLedger requires mutex');

    this._dataLayer = dataLayer;
    this._auditLog = auditLog;
    this._mutex = mutex;
  }

  // ---------------------------------------------------------------------------
  // Internal helpers
  // ---------------------------------------------------------------------------

  _statePath(agentId) {
    return `${STATE_DIR}/${agentId}.json`;
  }

  /**
   * Read agent state, returning empty state if file doesn't exist.
   * Does NOT acquire mutex — caller must hold it.
   */
  async _readState(agentId) {
    try {
      const state = await this._dataLayer.readJSON(this._statePath(agentId));
      // Validate loaded state has all required fields
      const required = ['available', 'locked', 'pending_deposit', 'pending_close',
                        'total_deposited', 'total_withdrawn', 'total_revenue_credited',
                        'total_ecash_funded', 'total_routing_pnl'];
      for (const field of required) {
        if (typeof state[field] !== 'number' || !Number.isFinite(state[field])) {
          // Migration: accept old field name total_routing_losses
          if (field === 'total_routing_pnl' && typeof state.total_routing_losses === 'number') {
            state.total_routing_pnl = state.total_routing_losses;
            delete state.total_routing_losses;
            continue;
          }
          // Migration: total_ecash_funded added in Plan J — default to 0
          if (field === 'total_ecash_funded' && state[field] === undefined) {
            state.total_ecash_funded = 0;
            continue;
          }
          throw new Error(`Corrupt state for ${agentId}: field '${field}' is ${state[field]}`);
        }
      }
      // Ensure processed_refs array exists (migration for old state files)
      if (!Array.isArray(state.processed_refs)) {
        state.processed_refs = [];
      }
      return state;
    } catch (err) {
      if (err.code === 'ENOENT') {
        return emptyState();
      }
      throw err;
    }
  }

  /**
   * Write state atomically (via DataLayer's write-to-tmp + rename).
   * Verifies invariant and no-negative-balances before writing.
   * Does NOT acquire mutex — caller must hold it.
   */
  async _writeState(agentId, state, context) {
    state.last_updated = new Date().toISOString();
    assertNoNegativeBalances(state, context);
    assertInvariant(state, context);
    await this._dataLayer.writeJSON(this._statePath(agentId), state);
  }

  /**
   * Append an entry to the per-agent activity log.
   */
  async _logActivity(entry) {
    const agentId = entry.agent_id;
    const logPath = `${STATE_DIR}/${agentId}/activity.jsonl`;
    await this._dataLayer.appendLog(logPath, {
      ...entry,
      _ts: Date.now(),
    });
  }

  /**
   * Append an entry to the audit chain.
   */
  async _logAudit(entry) {
    await this._auditLog.append({
      domain: 'capital',
      ...entry,
    });
  }

  /**
   * Extract the balance summary (public-facing fields only).
   */
  _balanceSummary(state) {
    return {
      available: state.available,
      locked: state.locked,
      pending_deposit: state.pending_deposit,
      pending_close: state.pending_close,
      total_deposited: state.total_deposited,
      total_withdrawn: state.total_withdrawn,
      total_revenue_credited: state.total_revenue_credited,
      total_ecash_funded: state.total_ecash_funded,
      total_routing_pnl: state.total_routing_pnl,
    };
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /**
   * Get an agent's capital balance. No mutex needed for reads —
   * reads are atomic (single file read). Returns zero state for new agents.
   */
  async getBalance(agentId) {
    assertAgentId(agentId);
    const state = await this._readState(agentId);
    return this._balanceSummary(state);
  }

  /**
   * Get all agents' capital balances. Reads per-agent state dir.
   */
  async getAllBalances() {
    const entries = await this._dataLayer.listDir(STATE_DIR);
    const results = {};
    for (const entry of entries) {
      if (!entry.name.endsWith('.json')) continue;
      const agentId = entry.name.replace('.json', '');
      try {
        const state = await this._readState(agentId);
        results[agentId] = this._balanceSummary(state);
      } catch (err) {
        results[agentId] = { error: err.message };
      }
    }
    return results;
  }

  /**
   * Record a pending deposit (detected but not yet confirmed).
   * pending_deposit += amount, total_deposited += amount
   */
  async recordDeposit(agentId, amount, txid) {
    assertAgentId(agentId);
    assertPositiveSats(amount, 'deposit amount');
    if (!txid || typeof txid !== 'string') {
      throw new Error('recordDeposit requires a txid string');
    }

    const unlock = await this._mutex.acquire(`capital:${agentId}`);
    try {
      const state = await this._readState(agentId);
      assertNotDuplicate(state, `deposit:${txid}`, `recordDeposit:${agentId}`);

      state.pending_deposit += amount;
      state.total_deposited += amount;

      await this._writeState(agentId, state, `recordDeposit:${agentId}`);

      const activity = {
        agent_id: agentId,
        type: 'deposit_pending',
        amount_sats: amount,
        from_bucket: null,
        to_bucket: 'pending_deposit',
        reference: txid,
        balance_after: this._balanceSummary(state),
      };
      await this._logActivity(activity);
      await this._logAudit({
        type: 'deposit_pending',
        agent_id: agentId,
        amount_sats: amount,
        txid,
        balance_after: this._balanceSummary(state),
      });

      return this._balanceSummary(state);
    } finally {
      unlock();
    }
  }

  /**
   * Confirm a previously pending deposit.
   * pending_deposit -= amount, available += amount
   */
  async confirmDeposit(agentId, amount, txid) {
    assertAgentId(agentId);
    assertPositiveSats(amount, 'confirm deposit amount');
    if (!txid || typeof txid !== 'string') {
      throw new Error('confirmDeposit requires a txid string');
    }

    const unlock = await this._mutex.acquire(`capital:${agentId}`);
    try {
      const state = await this._readState(agentId);
      assertNotDuplicate(state, `confirm:${txid}`, `confirmDeposit:${agentId}`);

      if (state.pending_deposit < amount) {
        throw new Error(
          `Insufficient pending_deposit for ${agentId}: ` +
          `has ${state.pending_deposit}, need ${amount}`
        );
      }

      state.pending_deposit -= amount;
      state.available += amount;

      await this._writeState(agentId, state, `confirmDeposit:${agentId}`);

      const activity = {
        agent_id: agentId,
        type: 'deposit_confirmed',
        amount_sats: amount,
        from_bucket: 'pending_deposit',
        to_bucket: 'available',
        reference: txid,
        balance_after: this._balanceSummary(state),
      };
      await this._logActivity(activity);
      await this._logAudit({
        type: 'deposit_confirmed',
        agent_id: agentId,
        amount_sats: amount,
        txid,
        balance_after: this._balanceSummary(state),
      });

      return this._balanceSummary(state);
    } finally {
      unlock();
    }
  }

  /**
   * Lock capital for a channel open.
   * available -= amount, locked += amount
   */
  async lockForChannel(agentId, amount, channelPoint) {
    assertAgentId(agentId);
    assertPositiveSats(amount, 'lock amount');
    if (!channelPoint || typeof channelPoint !== 'string') {
      throw new Error('lockForChannel requires a channelPoint string');
    }

    const unlock = await this._mutex.acquire(`capital:${agentId}`);
    try {
      const state = await this._readState(agentId);

      if (state.available < amount) {
        throw new Error(
          `Insufficient available balance for ${agentId}: ` +
          `has ${state.available}, need ${amount}`
        );
      }

      state.available -= amount;
      state.locked += amount;

      await this._writeState(agentId, state, `lockForChannel:${agentId}`);

      const activity = {
        agent_id: agentId,
        type: 'lock_for_channel',
        amount_sats: amount,
        from_bucket: 'available',
        to_bucket: 'locked',
        reference: channelPoint,
        balance_after: this._balanceSummary(state),
      };
      await this._logActivity(activity);
      await this._logAudit({
        type: 'lock_for_channel',
        agent_id: agentId,
        amount_sats: amount,
        channel_point: channelPoint,
        balance_after: this._balanceSummary(state),
      });

      return this._balanceSummary(state);
    } finally {
      unlock();
    }
  }

  /**
   * Unlock capital after a failed channel open.
   * locked -= amount, available += amount
   */
  async unlockForFailedOpen(agentId, amount, reference) {
    assertAgentId(agentId);
    assertPositiveSats(amount, 'unlock amount');
    if (!reference || typeof reference !== 'string') {
      throw new Error('unlockForFailedOpen requires a reference string');
    }

    const unlock = await this._mutex.acquire(`capital:${agentId}`);
    try {
      const state = await this._readState(agentId);

      if (state.locked < amount) {
        throw new Error(
          `Insufficient locked balance for ${agentId}: ` +
          `has ${state.locked}, need ${amount}`
        );
      }

      state.locked -= amount;
      state.available += amount;

      await this._writeState(agentId, state, `unlockForFailedOpen:${agentId}`);

      const activity = {
        agent_id: agentId,
        type: 'unlock_failed_open',
        amount_sats: amount,
        from_bucket: 'locked',
        to_bucket: 'available',
        reference,
        balance_after: this._balanceSummary(state),
      };
      await this._logActivity(activity);
      await this._logAudit({
        type: 'unlock_failed_open',
        agent_id: agentId,
        amount_sats: amount,
        reference,
        balance_after: this._balanceSummary(state),
      });

      return this._balanceSummary(state);
    } finally {
      unlock();
    }
  }

  /**
   * Initiate a channel close. Moves capital from locked to pending_close
   * and records routing P&L.
   *
   * locked -= originalLocked
   * pending_close += localBalance
   * total_routing_pnl += (originalLocked - localBalance)
   *   - positive = loss (routing shifted balance away)
   *   - negative = gain (routing shifted balance toward us)
   */
  async initiateClose(agentId, localBalance, originalLocked, channelPoint) {
    assertAgentId(agentId);
    assertNonNegativeSats(localBalance, 'localBalance');
    assertPositiveSats(originalLocked, 'originalLocked');
    if (!channelPoint || typeof channelPoint !== 'string') {
      throw new Error('initiateClose requires a channelPoint string');
    }
    // Bound: localBalance cannot exceed 3x originalLocked (generous upper bound).
    // In single-funded channels localBalance <= capacity = originalLocked.
    // 3x allows for dual-funded edge cases.
    if (localBalance > originalLocked * 3) {
      throw new Error(
        `localBalance (${localBalance}) exceeds 3x originalLocked (${originalLocked}). ` +
        `This suggests bad data — a channel's local balance cannot exceed its capacity.`
      );
    }
    if (localBalance > originalLocked) {
      console.warn(
        `[CapitalLedger] localBalance (${localBalance}) > originalLocked (${originalLocked}) ` +
        `for ${agentId} channel ${channelPoint} — routing gain or dual-funded channel`
      );
    }

    const unlock = await this._mutex.acquire(`capital:${agentId}`);
    try {
      const state = await this._readState(agentId);

      if (state.locked < originalLocked) {
        throw new Error(
          `Insufficient locked balance for ${agentId}: ` +
          `has ${state.locked}, need ${originalLocked}`
        );
      }

      const routingPnl = originalLocked - localBalance;

      state.locked -= originalLocked;
      state.pending_close += localBalance;
      state.total_routing_pnl += routingPnl;

      await this._writeState(agentId, state, `initiateClose:${agentId}`);

      const activity = {
        agent_id: agentId,
        type: 'unlock_from_channel',
        amount_sats: originalLocked,
        local_balance_sats: localBalance,
        routing_pnl_sats: routingPnl,
        from_bucket: 'locked',
        to_bucket: 'pending_close',
        reference: channelPoint,
        balance_after: this._balanceSummary(state),
      };
      await this._logActivity(activity);

      // Also log the routing P&L separately if non-zero
      if (routingPnl !== 0) {
        await this._logActivity({
          agent_id: agentId,
          type: 'routing_pnl',
          amount_sats: Math.abs(routingPnl),
          direction: routingPnl > 0 ? 'loss' : 'gain',
          from_bucket: routingPnl > 0 ? 'locked' : null,
          to_bucket: routingPnl > 0 ? null : 'available',
          reference: channelPoint,
          balance_after: this._balanceSummary(state),
        });
      }

      await this._logAudit({
        type: 'initiate_close',
        agent_id: agentId,
        original_locked_sats: originalLocked,
        local_balance_sats: localBalance,
        routing_pnl_sats: routingPnl,
        channel_point: channelPoint,
        balance_after: this._balanceSummary(state),
      });

      return this._balanceSummary(state);
    } finally {
      unlock();
    }
  }

  /**
   * Settle a closed channel (on-chain confirmation received).
   * pending_close -= settledAmount, available += settledAmount
   */
  async settleClose(agentId, settledAmount, txid) {
    assertAgentId(agentId);
    assertNonNegativeSats(settledAmount, 'settledAmount');
    if (!txid || typeof txid !== 'string') {
      throw new Error('settleClose requires a txid string');
    }

    const unlock = await this._mutex.acquire(`capital:${agentId}`);
    try {
      const state = await this._readState(agentId);

      if (state.pending_close < settledAmount) {
        throw new Error(
          `Insufficient pending_close for ${agentId}: ` +
          `has ${state.pending_close}, need ${settledAmount}`
        );
      }

      state.pending_close -= settledAmount;
      state.available += settledAmount;

      await this._writeState(agentId, state, `settleClose:${agentId}`);

      const activity = {
        agent_id: agentId,
        type: 'close_settled',
        amount_sats: settledAmount,
        from_bucket: 'pending_close',
        to_bucket: 'available',
        reference: txid,
        balance_after: this._balanceSummary(state),
      };
      await this._logActivity(activity);
      await this._logAudit({
        type: 'close_settled',
        agent_id: agentId,
        amount_sats: settledAmount,
        txid,
        balance_after: this._balanceSummary(state),
      });

      return this._balanceSummary(state);
    } finally {
      unlock();
    }
  }

  /**
   * Reconcile a channel close after the node closed it but the first close
   * request timed out or rolled back too early.
   *
   * If the ledger still has pending_close, settle from there.
   * If the ledger was rolled back to locked, settle from locked instead.
   */
  async reconcileClosedChannel(agentId, {
    settledAmount,
    txid,
    channelPoint,
    originalLocked,
    localBalanceAtClose,
  }) {
    assertAgentId(agentId);
    assertNonNegativeSats(settledAmount, 'settledAmount');
    assertPositiveSats(originalLocked, 'originalLocked');
    assertNonNegativeSats(localBalanceAtClose, 'localBalanceAtClose');
    if (!txid || typeof txid !== 'string') {
      throw new Error('reconcileClosedChannel requires a txid string');
    }
    if (!channelPoint || typeof channelPoint !== 'string') {
      throw new Error('reconcileClosedChannel requires a channelPoint string');
    }

    const unlock = await this._mutex.acquire(`capital:${agentId}`);
    try {
      const state = await this._readState(agentId);
      let sourceBucket = null;
      let closeFeeSats = 0;

      if (state.pending_close >= localBalanceAtClose && localBalanceAtClose > 0) {
        state.pending_close -= localBalanceAtClose;
        state.available += settledAmount;
        closeFeeSats = Math.max(0, localBalanceAtClose - settledAmount);
        state.total_routing_pnl += closeFeeSats;
        sourceBucket = 'pending_close';
      } else if (state.locked >= originalLocked) {
        state.locked -= originalLocked;
        state.available += settledAmount;
        state.total_routing_pnl += (originalLocked - settledAmount);
        closeFeeSats = Math.max(0, localBalanceAtClose - settledAmount);
        sourceBucket = 'locked';
      } else {
        throw new Error(
          `Unable to reconcile closed channel for ${agentId}: ` +
          `locked=${state.locked}, pending_close=${state.pending_close}, ` +
          `originalLocked=${originalLocked}, localBalanceAtClose=${localBalanceAtClose}`
        );
      }

      await this._writeState(agentId, state, `reconcileClosedChannel:${agentId}`);

      await this._logActivity({
        agent_id: agentId,
        type: 'close_settled',
        amount_sats: settledAmount,
        from_bucket: sourceBucket,
        to_bucket: 'available',
        reference: txid,
        balance_after: this._balanceSummary(state),
      });

      if (closeFeeSats > 0) {
        await this._logActivity({
          agent_id: agentId,
          type: 'close_fee',
          amount_sats: closeFeeSats,
          from_bucket: sourceBucket,
          to_bucket: null,
          reference: channelPoint,
          balance_after: this._balanceSummary(state),
        });
      }

      await this._logAudit({
        type: 'close_settled',
        agent_id: agentId,
        amount_sats: settledAmount,
        txid,
        channel_point: channelPoint,
        source_bucket: sourceBucket,
        close_fee_sats: closeFeeSats,
        balance_after: this._balanceSummary(state),
      });

      return this._balanceSummary(state);
    } finally {
      unlock();
    }
  }

  /**
   * Undo initiateClose when the close request never actually reached LND.
   * pending_close -= localBalance, locked += originalLocked, routing_pnl reversal
   */
  async rollbackInitiatedClose(agentId, localBalance, originalLocked, channelPoint, reason) {
    assertAgentId(agentId);
    assertNonNegativeSats(localBalance, 'localBalance');
    assertPositiveSats(originalLocked, 'originalLocked');
    if (!channelPoint || typeof channelPoint !== 'string') {
      throw new Error('rollbackInitiatedClose requires a channelPoint string');
    }
    if (!reason || typeof reason !== 'string') {
      throw new Error('rollbackInitiatedClose requires a reason string');
    }

    const unlock = await this._mutex.acquire(`capital:${agentId}`);
    try {
      const state = await this._readState(agentId);

      if (state.pending_close < localBalance) {
        throw new Error(
          `Insufficient pending_close for ${agentId}: ` +
          `has ${state.pending_close}, need ${localBalance}`
        );
      }

      const routingPnl = originalLocked - localBalance;

      state.pending_close -= localBalance;
      state.locked += originalLocked;
      state.total_routing_pnl -= routingPnl;

      await this._writeState(agentId, state, `rollbackInitiatedClose:${agentId}`);

      const activity = {
        agent_id: agentId,
        type: 'close_rollback',
        amount_sats: originalLocked,
        local_balance_sats: localBalance,
        routing_pnl_sats: routingPnl,
        from_bucket: 'pending_close',
        to_bucket: 'locked',
        reference: `${channelPoint}:${reason}`,
        balance_after: this._balanceSummary(state),
      };
      await this._logActivity(activity);
      await this._logAudit({
        type: 'close_rollback',
        agent_id: agentId,
        original_locked_sats: originalLocked,
        local_balance_sats: localBalance,
        routing_pnl_sats: routingPnl,
        channel_point: channelPoint,
        reason,
        balance_after: this._balanceSummary(state),
      });

      return this._balanceSummary(state);
    } finally {
      unlock();
    }
  }

  /**
   * Withdraw available capital to an external Bitcoin address.
   * available -= amount, total_withdrawn += amount
   */
  async withdraw(agentId, amount, destinationAddress) {
    assertAgentId(agentId);
    assertPositiveSats(amount, 'withdrawal amount');
    if (!destinationAddress || typeof destinationAddress !== 'string') {
      throw new Error('withdraw requires a destinationAddress string');
    }

    const unlock = await this._mutex.acquire(`capital:${agentId}`);
    try {
      const state = await this._readState(agentId);

      if (state.available < amount) {
        throw new Error(
          `Insufficient available balance for ${agentId}: ` +
          `has ${state.available}, need ${amount}`
        );
      }

      state.available -= amount;
      state.total_withdrawn += amount;

      await this._writeState(agentId, state, `withdraw:${agentId}`);

      const activity = {
        agent_id: agentId,
        type: 'withdrawal',
        amount_sats: amount,
        from_bucket: 'available',
        to_bucket: 'withdrawn',
        reference: destinationAddress,
        balance_after: this._balanceSummary(state),
      };
      await this._logActivity(activity);
      await this._logAudit({
        type: 'withdrawal',
        agent_id: agentId,
        amount_sats: amount,
        destination_address: destinationAddress,
        balance_after: this._balanceSummary(state),
      });

      return this._balanceSummary(state);
    } finally {
      unlock();
    }
  }

  /**
   * Credit revenue to an agent (from fee revenue attribution, Plan F).
   * available += amount, total_revenue_credited += amount
   */
  async creditRevenue(agentId, amount, reference) {
    assertAgentId(agentId);
    assertPositiveSats(amount, 'revenue credit amount');
    if (!reference || typeof reference !== 'string') {
      throw new Error('creditRevenue requires a reference string');
    }
    if (!/^forward:\d+:\d+$/.test(reference)) {
      throw new Error(`creditRevenue reference must match forward:{timestamp}:{chanId}, got: ${reference}`);
    }

    const unlock = await this._mutex.acquire(`capital:${agentId}`);
    try {
      const state = await this._readState(agentId);
      assertNotDuplicate(state, `rev:${reference}`, `creditRevenue:${agentId}`);

      state.available += amount;
      state.total_revenue_credited += amount;

      await this._writeState(agentId, state, `creditRevenue:${agentId}`);

      const activity = {
        agent_id: agentId,
        type: 'credit_revenue',
        amount_sats: amount,
        from_bucket: null,
        to_bucket: 'available',
        reference,
        balance_after: this._balanceSummary(state),
      };
      await this._logActivity(activity);
      await this._logAudit({
        type: 'credit_revenue',
        agent_id: agentId,
        amount_sats: amount,
        reference,
        balance_after: this._balanceSummary(state),
      });

      return this._balanceSummary(state);
    } finally {
      unlock();
    }
  }

  /**
   * Credit ecash funding to an agent (from ecash-to-capital conversion, Plan J).
   * available += amount, total_ecash_funded += amount
   */
  async creditEcashFunding(agentId, amount, reference) {
    assertAgentId(agentId);
    assertPositiveSats(amount, 'ecash funding amount');
    if (!reference || typeof reference !== 'string') {
      throw new Error('creditEcashFunding requires a reference string');
    }

    const unlock = await this._mutex.acquire(`capital:${agentId}`);
    try {
      const state = await this._readState(agentId);
      assertNotDuplicate(state, `ecf:${reference}`, `creditEcashFunding:${agentId}`);

      state.available += amount;
      state.total_ecash_funded += amount;

      await this._writeState(agentId, state, `creditEcashFunding:${agentId}`);

      const activity = {
        agent_id: agentId,
        type: 'credit_ecash_funding',
        amount_sats: amount,
        from_bucket: null,
        to_bucket: 'available',
        reference,
        balance_after: this._balanceSummary(state),
      };
      await this._logActivity(activity);
      await this._logAudit({
        type: 'credit_ecash_funding',
        agent_id: agentId,
        amount_sats: amount,
        reference,
        balance_after: this._balanceSummary(state),
      });

      return this._balanceSummary(state);
    } finally {
      unlock();
    }
  }

  /**
   * Settle a rebalance: deduct actual routing fee from locked capital,
   * refund remainder to available.
   *
   * locked -= maxFeeLocked
   * available += (maxFeeLocked - actualFee)
   * total_routing_pnl += actualFee
   *
   * On failure (actualFee = 0): equivalent to full refund.
   * Maintains the double-entry invariant.
   */
  async settleRebalance(agentId, maxFeeLocked, actualFee, reference) {
    assertAgentId(agentId);
    assertPositiveSats(maxFeeLocked, 'maxFeeLocked');
    assertNonNegativeSats(actualFee, 'actualFee');
    if (actualFee > maxFeeLocked) {
      throw new Error(`actualFee (${actualFee}) cannot exceed maxFeeLocked (${maxFeeLocked})`);
    }
    if (!reference || typeof reference !== 'string') {
      throw new Error('settleRebalance requires a reference string');
    }

    const unlock = await this._mutex.acquire(`capital:${agentId}`);
    try {
      const state = await this._readState(agentId);

      if (state.locked < maxFeeLocked) {
        throw new Error(
          `Insufficient locked balance for ${agentId}: ` +
          `has ${state.locked}, need ${maxFeeLocked}`
        );
      }

      const refunded = maxFeeLocked - actualFee;

      state.locked -= maxFeeLocked;
      state.available += refunded;
      state.total_routing_pnl += actualFee;

      await this._writeState(agentId, state, `settleRebalance:${agentId}`);

      const activity = {
        agent_id: agentId,
        type: 'settle_rebalance',
        max_fee_locked_sats: maxFeeLocked,
        actual_fee_sats: actualFee,
        refunded_sats: refunded,
        from_bucket: 'locked',
        to_bucket: 'available',
        reference,
        balance_after: this._balanceSummary(state),
      };
      await this._logActivity(activity);
      await this._logAudit({
        type: 'settle_rebalance',
        agent_id: agentId,
        max_fee_locked_sats: maxFeeLocked,
        actual_fee_sats: actualFee,
        refunded_sats: refunded,
        reference,
        balance_after: this._balanceSummary(state),
      });

      return this._balanceSummary(state);
    } finally {
      unlock();
    }
  }

  // ---------------------------------------------------------------------------
  // Aggregate solvency check (B4)
  // ---------------------------------------------------------------------------

  /**
   * Verify that the sum of all agents' capital balances does not exceed
   * the node's actual on-chain balance.
   *
   * @param {object} nodeClient - LND client with walletBalance()
   * @returns {Promise<{ total_committed_sats: number, on_chain_balance_sats: number, is_solvent: boolean, shortfall_sats: number }>}
   */
  async checkAggregateBalance(nodeClient) {
    if (!nodeClient || typeof nodeClient.walletBalance !== 'function') {
      throw new Error('checkAggregateBalance requires an LND client with walletBalance()');
    }

    const allBalances = await this.getAllBalances();
    let totalCommitted = 0;
    for (const balance of Object.values(allBalances)) {
      if (balance.error) continue;
      totalCommitted += (balance.available || 0) + (balance.locked || 0) +
                        (balance.pending_deposit || 0) + (balance.pending_close || 0);
    }

    const walletResult = await nodeClient.walletBalance();
    const onChainSats = parseInt(walletResult.confirmed_balance || '0', 10);

    const result = {
      total_committed_sats: totalCommitted,
      on_chain_balance_sats: onChainSats,
      is_solvent: totalCommitted <= onChainSats,
      shortfall_sats: Math.max(0, totalCommitted - onChainSats),
      agent_count: Object.keys(allBalances).length,
    };

    if (!result.is_solvent) {
      console.warn(
        `[CapitalLedger] SOLVENCY WARNING: Agents hold ${totalCommitted} sats ` +
        `but on-chain balance is only ${onChainSats} sats ` +
        `(shortfall: ${result.shortfall_sats} sats)`
      );
    }

    return result;
  }

  // ---------------------------------------------------------------------------
  // Activity log
  // ---------------------------------------------------------------------------

  /**
   * Read the activity log. Supports pagination.
   * @param {object} opts
   * @param {string} [opts.agentId] - Filter by agent. If null, returns all.
   * @param {number} [opts.limit=50]
   * @param {number} [opts.offset=0]
   * @returns {Promise<{ entries: object[], total: number }>}
   */
  async readActivity({ agentId, limit = 50, offset = 0 } = {}) {
    const clampedLimit = Math.min(Math.max(1, limit), 500);
    const clampedOffset = Math.max(0, offset);

    let all;
    if (agentId) {
      // Read only this agent's activity log (O(1) per agent, not O(n) global)
      try {
        all = await this._dataLayer.readLog(`${STATE_DIR}/${agentId}/activity.jsonl`);
      } catch { all = []; }
    } else {
      // Aggregate: iterate per-agent dirs
      all = [];
      try {
        const entries = await this._dataLayer.listDir(STATE_DIR);
        for (const entry of entries) {
          if (!entry.isDir) continue;
          try {
            const agentEntries = await this._dataLayer.readLog(`${STATE_DIR}/${entry.name}/activity.jsonl`);
            all.push(...agentEntries);
          } catch { /* skip */ }
        }
      } catch { /* no data yet */ }
    }

    // Return newest-first for API consumers
    const reversed = [...all].reverse();
    const page = reversed.slice(clampedOffset, clampedOffset + clampedLimit);

    return {
      entries: page,
      total: all.length,
    };
  }
}
