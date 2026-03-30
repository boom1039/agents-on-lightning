/**
 * Rebalance Executor — Validates, locks, executes circular rebalances.
 *
 * Handles agent-initiated channel rebalancing:
 *   1. 10-step fail-fast validation pipeline (secp256k1-signed requests)
 *   2. Capital lock via CapitalLedger (max_fee_sats)
 *   3. Self-invoice creation + sendPaymentV2 (streaming)
 *   4. Fee deduction on success, full refund on failure
 *   5. Crash recovery: in-flight payments reconciled on restart
 *
 * A circular rebalance sends a payment from the node to itself:
 *   - Outbound channel: loses local balance (gains remote)
 *   - Inbound channel: gains local balance (loses remote)
 *   - Agent pays routing fees from their capital
 *
 * State persisted to disk — survives Express restarts.
 * Follows ChannelOpener/ChannelCloser patterns.
 */

import { DedupCache } from '../channel-accountability/dedup-cache.js';
import { validateSignedInstruction } from '../channel-accountability/signed-instruction-validation.js';

const STATE_PATH = 'data/channel-market/rebalance-state.json';
const HISTORY_PATH = 'data/channel-market/rebalance-history.jsonl';

const REBALANCE_CONFIG = {
  minAmountSats: 10_000,
  maxAmountSats: 16_777_215,
  maxFeeSats: 50_000,
  paymentTimeoutSeconds: 120,
  maxConcurrentPerAgent: 1,
};

/**
 * Educational hints for validation failures.
 */
const HINTS = {
  missing_payload:
    'Send { "instruction": { "action": "rebalance", ... }, "signature": "hex" }. ' +
    'The instruction must contain action, agent_id, timestamp, and params with ' +
    'outbound_chan_id, amount_sats, and max_fee_sats.',

  wrong_action:
    'Only "rebalance" accepted at this endpoint. ' +
    'For channel opens, use POST /api/v1/market/open.',

  missing_params:
    'params must include: outbound_chan_id (string), amount_sats (integer > 0), max_fee_sats (integer > 0).',

  amount_out_of_bounds: (min, max) =>
    `Rebalance amount must be between ${min.toLocaleString()} and ${max.toLocaleString()} sats.`,

  fee_too_high: (maxAllowed) =>
    `max_fee_sats exceeds the limit of ${maxAllowed.toLocaleString()} sats. ` +
    'Use POST /api/v1/market/rebalance/estimate to get a fee estimate first.',

  insufficient_balance: (available, requested) =>
    `Your available capital is ${available.toLocaleString()} sats, but max_fee_sats is ${requested.toLocaleString()} sats. ` +
    'You need enough available capital to cover the worst-case routing fee.',

  channel_not_owned:
    'You can only rebalance through outbound channels assigned to you. ' +
    'GET /api/v1/channels/mine to see your assigned channels.',

  concurrent_limit:
    'You already have a rebalance in flight. Wait for it to complete before starting another.',
};

export class RebalanceExecutor {
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
    if (!capitalLedger) throw new Error('RebalanceExecutor requires capitalLedger');
    if (!nodeManager) throw new Error('RebalanceExecutor requires nodeManager');
    if (!dataLayer) throw new Error('RebalanceExecutor requires dataLayer');
    if (!auditLog) throw new Error('RebalanceExecutor requires auditLog');
    if (!agentRegistry) throw new Error('RebalanceExecutor requires agentRegistry');
    if (!assignmentRegistry) throw new Error('RebalanceExecutor requires assignmentRegistry');
    if (!mutex) throw new Error('RebalanceExecutor requires mutex');

    this._capitalLedger = capitalLedger;
    this._nodeManager = nodeManager;
    this._dataLayer = dataLayer;
    this._auditLog = auditLog;
    this._agentRegistry = agentRegistry;
    this._assignmentRegistry = assignmentRegistry;
    this._mutex = mutex;

    // payment_hash → in-flight rebalance entry
    this._state = {};

    // Dedup cache (10-minute expiry window)
    this._dedup = new DedupCache(600_000, {
      dataLayer,
      path: 'data/channel-market/rebalance-dedup.json',
    });

    this.config = { ...REBALANCE_CONFIG };
  }

  // ---------------------------------------------------------------------------
  // State persistence
  // ---------------------------------------------------------------------------

  async load() {
    try {
      const raw = await this._dataLayer.readJSON(STATE_PATH);
      this._state = raw || {};

      const entries = Object.values(this._state);
      const inflight = entries.filter(e => e.status === 'in_flight').length;
      console.log(
        `[RebalanceExecutor] Loaded ${entries.length} entries (${inflight} in-flight)`
      );

      // Crash recovery: reconcile in-flight payments
      if (inflight > 0) {
        await this._recoverInflightPayments();
      }
    } catch (err) {
      if (err.code === 'ENOENT') {
        this._state = {};
        console.log('[RebalanceExecutor] No existing state — starting fresh');
      } else {
        throw err;
      }
    }
  }

  async _persist() {
    await this._dataLayer.writeJSON(STATE_PATH, this._state);
  }

  // ---------------------------------------------------------------------------
  // Crash recovery
  // ---------------------------------------------------------------------------

  async _recoverInflightPayments() {
    const client = this._nodeManager.getDefaultNodeOrNull();
    if (!client) {
      console.warn('[RebalanceExecutor] No LND client for crash recovery — will retry on next load');
      return;
    }

    const inflight = Object.entries(this._state).filter(([, e]) => e.status === 'in_flight');
    console.log(`[RebalanceExecutor] Recovering ${inflight.length} in-flight payments...`);

    for (const [paymentHash, entry] of inflight) {
      try {
        const result = await client.trackPaymentV2(paymentHash);
        await this._reconcilePayment(paymentHash, entry, result);
      } catch (err) {
        console.error(
          `[RebalanceExecutor] Recovery failed for ${paymentHash}: ${err.message}. ` +
          'Refunding locked capital as safety measure.'
        );
        // Safety: refund if we can't determine status
        try {
          await this._capitalLedger.settleRebalance(
            entry.agent_id, entry.max_fee_sats, 0, `recovery-refund:${paymentHash}`
          );
        } catch (refundErr) {
          console.error(`[RebalanceExecutor] Recovery refund failed: ${refundErr.message}`);
        }
        entry.status = 'failed';
        entry.failed_reason = `Recovery failed: ${err.message}`;
      }
    }

    await this._persist();
  }

  async _reconcilePayment(paymentHash, entry, result) {
    if (result.status === 'SUCCEEDED') {
      const actualFee = parseInt(result.fee_sat || '0', 10);
      await this._capitalLedger.settleRebalance(
        entry.agent_id, entry.max_fee_sats, actualFee, `rebalance:${paymentHash}`
      );
      entry.status = 'succeeded';
      entry.actual_fee_sats = actualFee;
      entry.completed_at = Date.now();
      console.log(`[RebalanceExecutor] Recovery: ${paymentHash} succeeded (fee: ${actualFee} sats)`);
    } else {
      // FAILED — full refund
      await this._capitalLedger.settleRebalance(
        entry.agent_id, entry.max_fee_sats, 0, `rebalance-failed:${paymentHash}`
      );
      entry.status = 'failed';
      entry.failed_reason = result.failure_reason || 'Payment failed';
      entry.completed_at = Date.now();
      console.log(`[RebalanceExecutor] Recovery: ${paymentHash} failed — refunded`);
    }

    await this._logHistory(entry);
  }

  // ---------------------------------------------------------------------------
  // Validation pipeline (10 steps, fail-fast)
  // ---------------------------------------------------------------------------

  async _validate(agentId, payload) {
    // Steps 1–7: shared signed-instruction validation
    const shared = await validateSignedInstruction({
      agentId, payload, expectedAction: 'rebalance',
      agentRegistry: this._agentRegistry, dedup: this._dedup,
      actionHints: HINTS,
    });
    if (!shared.success) return shared;

    const { checks_passed, instrHash, params } = shared;

    // Step 8: params_valid
    const { outbound_chan_id, amount_sats, max_fee_sats } = params;

    if (!outbound_chan_id || typeof outbound_chan_id !== 'string') {
      return {
        success: false, error: 'outbound_chan_id is required',
        hint: HINTS.missing_params, status: 400,
        failed_at: 'params_valid', checks_passed,
      };
    }
    if (!Number.isInteger(amount_sats) || amount_sats <= 0) {
      return {
        success: false, error: 'amount_sats must be a positive integer',
        hint: HINTS.missing_params, status: 400,
        failed_at: 'params_valid', checks_passed,
      };
    }
    if (!Number.isInteger(max_fee_sats) || max_fee_sats <= 0) {
      return {
        success: false, error: 'max_fee_sats must be a positive integer',
        hint: HINTS.missing_params, status: 400,
        failed_at: 'params_valid', checks_passed,
      };
    }
    if (amount_sats < this.config.minAmountSats || amount_sats > this.config.maxAmountSats) {
      return {
        success: false,
        error: `amount_sats ${amount_sats} outside allowed range`,
        hint: HINTS.amount_out_of_bounds(this.config.minAmountSats, this.config.maxAmountSats),
        status: 400, failed_at: 'params_valid', checks_passed,
      };
    }
    if (max_fee_sats > this.config.maxFeeSats) {
      return {
        success: false,
        error: `max_fee_sats ${max_fee_sats} exceeds limit of ${this.config.maxFeeSats}`,
        hint: HINTS.fee_too_high(this.config.maxFeeSats),
        status: 400, failed_at: 'params_valid', checks_passed,
      };
    }
    checks_passed.push('params_valid');

    // Step 9: outbound_channel_owned
    const assignment = this._assignmentRegistry.getAssignment(outbound_chan_id);
    if (!assignment) {
      return {
        success: false, error: 'Outbound channel not found in assignment registry',
        hint: HINTS.channel_not_owned, status: 403,
        failed_at: 'outbound_channel_owned', checks_passed,
      };
    }
    if (assignment.agent_id !== agentId) {
      return {
        success: false, error: 'Outbound channel is assigned to a different agent',
        hint: HINTS.channel_not_owned, status: 403,
        failed_at: 'outbound_channel_owned', checks_passed,
      };
    }
    checks_passed.push('outbound_channel_owned');

    // Step 10: balance_sufficient (for max_fee_sats)
    const balance = await this._capitalLedger.getBalance(agentId);
    if (balance.available < max_fee_sats) {
      return {
        success: false,
        error: `Insufficient available balance for routing fee: have ${balance.available}, need ${max_fee_sats}`,
        hint: HINTS.insufficient_balance(balance.available, max_fee_sats),
        status: 400, failed_at: 'balance_sufficient', checks_passed,
      };
    }
    checks_passed.push('balance_sufficient');

    return {
      success: true,
      checks_passed,
      instrHash,
      params,
      assignment,
      balance,
    };
  }

  async validateRequest(agentId, payload) {
    return this._validate(agentId, payload);
  }

  // ---------------------------------------------------------------------------
  // Execute rebalance
  // ---------------------------------------------------------------------------

  async requestRebalance(agentId, payload) {
    // Validate (steps 1-10)
    const validation = await this._validate(agentId, payload);
    if (!validation.success) return validation;

    const { instrHash, params } = validation;
    const { outbound_chan_id, inbound_chan_id, amount_sats, max_fee_sats } = params;

    // Check concurrency limit
    const agentInflight = Object.values(this._state).filter(
      e => e.agent_id === agentId && e.status === 'in_flight'
    );
    if (agentInflight.length >= this.config.maxConcurrentPerAgent) {
      return {
        success: false, error: 'Concurrent rebalance limit reached',
        hint: HINTS.concurrent_limit, status: 429,
      };
    }

    // Get LND client
    const client = this._nodeManager.getDefaultNodeOrNull();
    if (!client) {
      return { success: false, error: 'LND node not available', status: 503 };
    }

    // Lock max_fee_sats in capital ledger
    const lockRef = `rebalance-lock:${instrHash}`;
    const unlock = await this._mutex.acquire(`rebalance:${agentId}`);
    try {
      await this._capitalLedger.lockForChannel(agentId, max_fee_sats, lockRef);
    } catch (err) {
      unlock();
      return {
        success: false,
        error: `Failed to lock capital for routing fee: ${err.message}`,
        status: 400, failed_at: 'capital_lock',
        checks_passed: validation.checks_passed,
      };
    }

    // Mark instruction as seen (dedup)
    await this._dedup.mark(instrHash);

    // Create self-invoice
    let invoice;
    try {
      invoice = await client.addInvoice(amount_sats, `rebalance:${instrHash.slice(0, 16)}`, 600);
    } catch (err) {
      // Refund on invoice creation failure
      try {
        await this._capitalLedger.settleRebalance(agentId, max_fee_sats, 0, `invoice-fail:${instrHash}`);
      } catch (refundErr) {
        console.error(`[RebalanceExecutor] CRITICAL: refund after invoice fail: ${refundErr.message}`);
      }
      unlock();
      return {
        success: false,
        error: `Failed to create self-invoice: ${err.message}`,
        status: 502, failed_at: 'create_invoice',
        checks_passed: validation.checks_passed,
      };
    }

    // Record in-flight state
    const paymentHash = invoice.r_hash;
    const entry = {
      agent_id: agentId,
      outbound_chan_id,
      inbound_chan_id: inbound_chan_id || null,
      amount_sats,
      max_fee_sats,
      payment_hash: paymentHash,
      payment_request: invoice.payment_request,
      status: 'in_flight',
      instruction_hash: instrHash,
      started_at: Date.now(),
    };
    this._state[paymentHash] = entry;
    await this._persist();
    unlock();

    // Execute circular payment via streaming sendPaymentV2
    let paymentResult;
    try {
      paymentResult = await client.sendPaymentV2({
        payment_request: invoice.payment_request,
        timeout_seconds: this.config.paymentTimeoutSeconds,
        fee_limit_sat: max_fee_sats,
        outgoing_chan_id: outbound_chan_id,
        allow_self_payment: true,
      });
    } catch (err) {
      // Stream error — refund
      try {
        await this._capitalLedger.settleRebalance(agentId, max_fee_sats, 0, `stream-fail:${paymentHash}`);
      } catch (refundErr) {
        console.error(`[RebalanceExecutor] CRITICAL: refund after stream fail: ${refundErr.message}`);
      }
      entry.status = 'failed';
      entry.failed_reason = err.message;
      entry.completed_at = Date.now();
      await this._persist();
      await this._logHistory(entry);

      return {
        success: false,
        error: `Rebalance payment failed: ${err.message}`,
        status: 502,
      };
    }

    // Process terminal status
    if (paymentResult.status === 'SUCCEEDED') {
      const actualFee = parseInt(paymentResult.fee_sat || '0', 10);

      await this._capitalLedger.settleRebalance(
        agentId, max_fee_sats, actualFee, `rebalance:${paymentHash}`
      );

      entry.status = 'succeeded';
      entry.actual_fee_sats = actualFee;
      entry.completed_at = Date.now();
      await this._persist();

      await this._auditLog.append({
        domain: 'channel_market',
        type: 'rebalance_succeeded',
        agent_id: agentId,
        outbound_chan_id,
        inbound_chan_id: inbound_chan_id || null,
        amount_sats,
        actual_fee_sats: actualFee,
        max_fee_sats,
        payment_hash: paymentHash,
      });

      await this._logHistory(entry);

      const feePercent = amount_sats > 0 ? ((actualFee / amount_sats) * 100).toFixed(3) : '0';
      const refunded = max_fee_sats - actualFee;

      console.log(
        `[RebalanceExecutor] Rebalance succeeded: ${amount_sats} sats via ${outbound_chan_id}, fee ${actualFee} sats (${feePercent}%)`
      );

      return {
        success: true,
        status: 'succeeded',
        outbound_chan_id,
        inbound_chan_id: inbound_chan_id || null,
        amount_sats,
        routing_fee_sats: actualFee,
        max_fee_sats,
        capital_refunded_sats: refunded,
        learn: `Your rebalance shifted ${amount_sats.toLocaleString()} sats from your outbound channel's ` +
          `remote side to its local side. Routing cost was ${actualFee} sats (${feePercent}%). ` +
          `Your outbound channel now has more local balance for routing payments outward.`,
      };
    } else {
      // FAILED
      await this._capitalLedger.settleRebalance(
        agentId, max_fee_sats, 0, `rebalance-failed:${paymentHash}`
      );

      const reason = paymentResult.failure_reason || 'Payment failed';
      entry.status = 'failed';
      entry.failed_reason = reason;
      entry.completed_at = Date.now();
      await this._persist();

      await this._auditLog.append({
        domain: 'channel_market',
        type: 'rebalance_failed',
        agent_id: agentId,
        outbound_chan_id,
        amount_sats,
        max_fee_sats,
        failure_reason: reason,
        payment_hash: paymentHash,
      });

      await this._logHistory(entry);

      console.log(
        `[RebalanceExecutor] Rebalance failed: ${amount_sats} sats via ${outbound_chan_id} — ${reason}`
      );

      return {
        success: false,
        status: 'failed',
        outbound_chan_id,
        amount_sats,
        failure_reason: reason,
        capital_refunded_sats: max_fee_sats,
        learn: `Rebalance failed: ${reason}. Your locked routing fee of ${max_fee_sats} sats ` +
          'has been fully refunded to your available balance. Common causes: no route found, ' +
          'insufficient liquidity on the return path, or channel partner offline.',
      };
    }
  }

  // ---------------------------------------------------------------------------
  // Fee estimation
  // ---------------------------------------------------------------------------

  async estimateRebalanceFee(agentId, params) {
    const { outbound_chan_id, amount_sats } = params || {};

    if (!outbound_chan_id || !Number.isInteger(amount_sats) || amount_sats <= 0) {
      return {
        success: false,
        error: 'outbound_chan_id and amount_sats (positive integer) are required',
        status: 400,
      };
    }

    const assignment = this._assignmentRegistry.getAssignment(outbound_chan_id);
    if (!assignment || assignment.agent_id !== agentId) {
      return {
        success: false,
        error: 'Outbound channel not found in assignment registry',
        status: 404,
        learn: 'You can only estimate a rebalance for an outbound channel assigned to you. GET /api/v1/channels/mine to see your assigned channels.',
      };
    }

    const client = this._nodeManager.getDefaultNodeOrNull();
    if (!client) {
      return { success: false, error: 'LND node not available', status: 503 };
    }

    // Get our own pubkey for self-route query
    let nodeInfo;
    try {
      nodeInfo = await client.getInfo();
    } catch (err) {
      return { success: false, error: `LND error: ${err.message}`, status: 503 };
    }

    // queryRoutes to self — note: this is approximate since it can't
    // constrain the outgoing channel (only sendPaymentV2 supports that)
    try {
      const routes = await client.queryRoutes(nodeInfo.identity_pubkey, amount_sats, {
        feeLimit: this.config.maxFeeSats,
      });

      const routeList = routes.routes || [];
      if (routeList.length === 0) {
        return {
          success: true,
          outbound_chan_id,
          amount_sats,
          estimated_fee_sats: null,
          routes_found: 0,
          learn: 'No circular routes found. This could mean: no path exists back to this node, ' +
            'channels lack sufficient liquidity, or the amount is too large for available paths.',
        };
      }

      // Take the lowest-fee route
      const bestRoute = routeList.reduce((best, r) => {
        const fee = parseInt(r.total_fees || '0', 10);
        return fee < (best.fee || Infinity) ? { route: r, fee } : best;
      }, { fee: Infinity });

      return {
        success: true,
        outbound_chan_id,
        amount_sats,
        estimated_fee_sats: bestRoute.fee,
        routes_found: routeList.length,
        learn: 'Fee estimate is approximate — actual fee may differ because the estimate ' +
          'cannot constrain the outgoing channel. Set max_fee_sats slightly above the estimate.',
      };
    } catch (err) {
      return {
        success: false,
        error: `Route query failed: ${err.message}`,
        status: 502,
      };
    }
  }

  // ---------------------------------------------------------------------------
  // History
  // ---------------------------------------------------------------------------

  async getRebalanceHistory(agentId, limit = 50) {
    try {
      const all = await this._dataLayer.readLog(HISTORY_PATH);
      const filtered = all
        .filter(e => e.agent_id === agentId)
        .reverse() // newest first
        .slice(0, Math.min(limit, 200));
      return {
        agent_id: agentId,
        rebalances: filtered,
        count: filtered.length,
        learn: filtered.length > 0
          ? 'Your past rebalances are listed above (newest first). ' +
            'Track routing costs to optimize your rebalancing strategy.'
          : 'No rebalance history yet. Use POST /api/v1/market/rebalance to rebalance your channels.',
      };
    } catch (err) {
      if (err.code === 'ENOENT') {
        return { agent_id: agentId, rebalances: [], count: 0, learn: 'No rebalance history yet.' };
      }
      throw err;
    }
  }

  async _logHistory(entry) {
    await this._dataLayer.appendLog(HISTORY_PATH, {
      agent_id: entry.agent_id,
      outbound_chan_id: entry.outbound_chan_id,
      inbound_chan_id: entry.inbound_chan_id,
      amount_sats: entry.amount_sats,
      max_fee_sats: entry.max_fee_sats,
      actual_fee_sats: entry.actual_fee_sats || 0,
      status: entry.status,
      payment_hash: entry.payment_hash,
      started_at: entry.started_at,
      completed_at: entry.completed_at,
      failed_reason: entry.failed_reason || null,
    });
  }

  // ---------------------------------------------------------------------------
  // Query
  // ---------------------------------------------------------------------------

  getConfig() {
    return {
      min_amount_sats: this.config.minAmountSats,
      max_amount_sats: this.config.maxAmountSats,
      max_fee_sats: this.config.maxFeeSats,
      payment_timeout_seconds: this.config.paymentTimeoutSeconds,
      max_concurrent_per_agent: this.config.maxConcurrentPerAgent,
      learn: 'Rebalancing shifts liquidity between your channels by sending a circular payment. ' +
        'You pay routing fees from your capital balance. The outbound channel must be assigned to you. ' +
        'Any active channel on the node can serve as the inbound (return) path.',
    };
  }
}
