import { randomUUID } from 'node:crypto';

const STATE_PATH = 'data/channel-market/lightning-capital-flows.json';

function nowIso() {
  return new Date().toISOString();
}

function nowMs() {
  return Date.now();
}

function isPositiveInteger(value) {
  return Number.isInteger(value) && value > 0;
}

function isInvoiceSettled(invoice) {
  if (!invoice || typeof invoice !== 'object') return false;
  return invoice.settled === true || invoice.state === 'SETTLED';
}

function extractInvoiceAmount(invoice) {
  const direct = Number.parseInt(invoice?.value || invoice?.value_sat || invoice?.amt_paid_sat || '0', 10);
  return Number.isFinite(direct) ? direct : 0;
}

function isTerminalStatus(status) {
  return ['confirmed', 'expired', 'loop_out_failed', 'recovery_required'].includes(status);
}

function isFailedSwapState(state) {
  return ['FAILED', 'FAIL_OFFCHAIN_PAYMENTS', 'FAIL_TIMEOUT', 'FAIL_INSUFFICIENT_VALUE'].includes(String(state || '').toUpperCase());
}

function describeFlowError(error) {
  const code = String(error || '').trim();
  if (!code) return null;
  if (code === 'FAILURE_REASON_OFFCHAIN') {
    return 'Loop could not route the off-chain swap payment (FAILURE_REASON_OFFCHAIN).';
  }
  if (code === 'FAILURE_REASON_NO_ROUTE') {
    return 'Loop could not find a Lightning route for the swap payment (FAILURE_REASON_NO_ROUTE).';
  }
  return code;
}

function isRetryableOffchainError(error) {
  const text = String(error || '');
  return text.includes('FAILURE_REASON_OFFCHAIN');
}

export class LightningCapitalFunder {
  constructor({
    nodeManager,
    depositTracker,
    capitalLedger,
    dataLayer,
    auditLog,
    mutex,
    loopClient,
    config = {},
  }) {
    if (!nodeManager) throw new Error('LightningCapitalFunder requires nodeManager');
    if (!depositTracker) throw new Error('LightningCapitalFunder requires depositTracker');
    if (!capitalLedger) throw new Error('LightningCapitalFunder requires capitalLedger');
    if (!dataLayer) throw new Error('LightningCapitalFunder requires dataLayer');
    if (!auditLog) throw new Error('LightningCapitalFunder requires auditLog');
    if (!mutex) throw new Error('LightningCapitalFunder requires mutex');
    if (!loopClient) throw new Error('LightningCapitalFunder requires loopClient');

    this._nodeManager = nodeManager;
    this._depositTracker = depositTracker;
    this._capitalLedger = capitalLedger;
    this._dataLayer = dataLayer;
    this._auditLog = auditLog;
    this._mutex = mutex;
    this._loopClient = loopClient;

    this._flows = {};
    this._pollTimer = null;
    this._stopping = false;
    this.config = {
      invoiceExpirySeconds: Number.isInteger(config.invoiceExpirySeconds) ? config.invoiceExpirySeconds : 3600,
      pollIntervalMs: Number.isInteger(config.pollIntervalMs) ? config.pollIntervalMs : 30_000,
      loopOutConfTarget: Number.isInteger(config.loopOutConfTarget) ? config.loopOutConfTarget : 9,
      loopOutMaxRoutingFeeSats: Number.isInteger(config.loopOutMaxRoutingFeeSats) ? config.loopOutMaxRoutingFeeSats : 100,
      maxStartAttempts: Number.isInteger(config.maxStartAttempts) ? config.maxStartAttempts : 10,
      startRetryWindowMs: Number.isInteger(config.startRetryWindowMs) ? config.startRetryWindowMs : 60 * 60 * 1000,
      pendingSwapTimeoutMs: Number.isInteger(config.pendingSwapTimeoutMs) ? config.pendingSwapTimeoutMs : 6 * 60 * 60 * 1000,
      retryBackoffMs: Number.isInteger(config.retryBackoffMs) ? config.retryBackoffMs : 60_000,
      fast: config.fast === true,
    };
  }

  async load() {
    try {
      this._flows = await this._dataLayer.readJSON(STATE_PATH);
    } catch (err) {
      if (err.code === 'ENOENT') {
        this._flows = {};
      } else {
        throw err;
      }
    }
    let changed = false;
    for (const flow of Object.values(this._flows)) {
      if (flow?.status !== 'loop_out_failed') continue;
      if (!isRetryableOffchainError(flow?.last_error)) continue;
      const paidAt = Date.parse(flow.invoice_paid_at || flow.created_at || '');
      if (!Number.isFinite(paidAt)) continue;
      if ((nowMs() - paidAt) > this.config.startRetryWindowMs) continue;
      if ((flow.loop_out_attempts || 0) >= this.config.maxStartAttempts) continue;
      flow.status = 'invoice_paid';
      flow.next_retry_at = new Date(nowMs() + this.config.retryBackoffMs).toISOString();
      flow.last_progress_at = nowIso();
      changed = true;
    }
    if (changed) {
      await this._persist();
    }
  }

  async _persist() {
    await this._dataLayer.writeJSON(STATE_PATH, this._flows);
  }

  startPolling(intervalMs = this.config.pollIntervalMs) {
    if (this._pollTimer) return;
    this._stopping = false;
    this._pollTimer = setInterval(() => {
      this._pollCycle().catch((err) => {
        if (!this._stopping) {
          console.error(`[LightningCapitalFunder] Poll error: ${err.message}`);
        }
      });
    }, intervalMs);
  }

  stopPolling() {
    this._stopping = true;
    if (this._pollTimer) {
      clearInterval(this._pollTimer);
      this._pollTimer = null;
    }
  }

  async createFlow(agentId, amountSats) {
    if (!agentId || typeof agentId !== 'string') {
      throw new Error('createFlow requires an agentId string');
    }
    if (!isPositiveInteger(amountSats)) {
      throw new Error('amount_sats must be a positive integer');
    }

    const invoiceClient =
      this._nodeManager.getScopedDefaultNodeOrNull('invoice')
      || this._nodeManager.getScopedDefaultNodeOrNull('wallet');
    if (!invoiceClient) {
      throw new Error('No invoice-capable node is connected for Lightning capital deposits');
    }

    await this._loopClient.quoteOut(amountSats, {
      confTarget: this.config.loopOutConfTarget,
      fast: this.config.fast,
    });

    const unlock = await this._mutex.acquire(`lightning-capital:${agentId}`);
    try {
      const flowId = randomUUID();
      const expiresAtMs = nowMs() + (this.config.invoiceExpirySeconds * 1000);
      const loopLabel = `lightning-capital:${flowId}`;
      const { address } = await this._depositTracker.generateAddress(agentId, {
        source: 'lightning_loop_out',
        flow_id: flowId,
      });
      const invoice = await invoiceClient.addInvoice(
        amountSats,
        `lightning capital deposit ${flowId}`,
        this.config.invoiceExpirySeconds,
      );

      const flow = {
        flow_id: flowId,
        agent_id: agentId,
        amount_sats: amountSats,
        deposit_address: address,
        status: 'invoice_created',
        created_at: nowIso(),
        expires_at: new Date(expiresAtMs).toISOString(),
        invoice_payment_request: invoice.payment_request,
        invoice_add_index: invoice.add_index != null ? String(invoice.add_index) : null,
        invoice_r_hash: invoice.r_hash || null,
        loop_out_label: loopLabel,
        loop_out_swap_id: null,
        loop_out_attempts: 0,
        loop_out_started_at: null,
        next_retry_at: null,
        last_error: null,
        last_progress_at: nowIso(),
      };

      this._flows[flowId] = flow;
      await this._persist();
      await this._capitalLedger.recordFundingEvent(agentId, 'lightning_invoice_created', {
        amount_sats: amountSats,
        source: 'lightning_loop_out',
        status: 'invoice_created',
        flow_id: flowId,
        address,
        reference: flowId,
      });

      return this._summarizeFlow(flow);
    } finally {
      unlock();
    }
  }

  async getFlow(agentId, flowId) {
    const flow = this._flows[flowId];
    if (!flow || flow.agent_id !== agentId) return null;
    return this._summarizeFlow(flow);
  }

  async retryFlow(agentId, flowId) {
    const flow = this._flows[flowId];
    if (!flow || flow.agent_id !== agentId) return null;
    if (!flow.invoice_paid_at) {
      throw new Error('This Lightning deposit has not been paid yet.');
    }
    if (!['loop_out_failed', 'recovery_required'].includes(flow.status)) {
      throw new Error('This Lightning deposit is not in a retryable state.');
    }
    flow.status = 'invoice_paid';
    flow.next_retry_at = nowIso();
    flow.last_progress_at = nowIso();
    await this._persist();
    await this._capitalLedger.recordFundingEvent(flow.agent_id, 'lightning_deposit_retrying', {
      amount_sats: flow.amount_sats,
      source: 'lightning_loop_out',
      status: 'invoice_paid',
      flow_id: flow.flow_id,
      address: flow.deposit_address,
      reason: describeFlowError(flow.last_error),
      loop_out_swap_id: flow.loop_out_swap_id,
      next_retry_at: flow.next_retry_at,
      reference: flow.flow_id,
    });
    return this._summarizeFlow(flow);
  }

  annotateDeposits(agentId, deposits) {
    const byAddress = new Map();
    for (const flow of Object.values(this._flows)) {
      if (flow.agent_id !== agentId) continue;
      byAddress.set(flow.deposit_address, flow);
    }
    return deposits.map((deposit) => {
      const flow = byAddress.get(deposit.address);
      if (!flow) return deposit;
      return {
        ...deposit,
        source: deposit.source || 'lightning_loop_out',
        flow_id: flow.flow_id,
        lightning_flow_status: this._deriveStatus(flow, deposit),
      };
    });
  }

  async _pollCycle() {
    const invoiceClient =
      this._nodeManager.getScopedDefaultNodeOrNull('invoice')
      || this._nodeManager.getScopedDefaultNodeOrNull('wallet');
    if (!invoiceClient) return;

    for (const flow of Object.values(this._flows)) {
      if (isTerminalStatus(flow.status)) continue;
      await this._advanceFlow(invoiceClient, flow);
    }
  }

  async _advanceFlow(invoiceClient, flow) {
    const deposit = this._getDepositForFlow(flow);
    const derivedStatus = this._deriveStatus(flow, deposit);

    if (derivedStatus !== flow.status) {
      const previousStatus = flow.status;
      flow.status = derivedStatus;
      flow.last_progress_at = nowIso();
      if (derivedStatus === 'onchain_pending' && previousStatus === 'loop_out_pending') {
        await this._capitalLedger.recordFundingEvent(flow.agent_id, 'loop_out_broadcast', {
          amount_sats: deposit?.amount_sats || flow.amount_sats,
          source: 'lightning_loop_out',
          status: 'onchain_pending',
          flow_id: flow.flow_id,
          address: flow.deposit_address,
          txid: deposit?.txid || null,
          confirmations: deposit?.confirmations || 0,
          required_confirmations: deposit?.confirmations_required || this._depositTracker._confirmationsRequired,
          loop_out_swap_id: flow.loop_out_swap_id,
          reference: deposit?.txid || flow.flow_id,
        });
      } else if (derivedStatus === 'confirmed') {
        await this._capitalLedger.recordFundingEvent(flow.agent_id, 'lightning_deposit_confirmed', {
          amount_sats: flow.amount_sats,
          source: 'lightning_loop_out',
          status: 'confirmed',
          flow_id: flow.flow_id,
          address: flow.deposit_address,
          txid: deposit?.txid || null,
          confirmations: deposit?.confirmations || 0,
          required_confirmations: deposit?.confirmations_required || this._depositTracker._confirmationsRequired,
          reference: deposit?.txid || flow.flow_id,
        });
      }
      await this._persist();
      if (isTerminalStatus(flow.status)) return;
    }

    if (flow.status === 'invoice_created') {
      const invoice = await this._findInvoice(invoiceClient, flow);
      if (isInvoiceSettled(invoice)) {
        flow.status = 'invoice_paid';
        flow.invoice_paid_at = nowIso();
        flow.last_error = null;
        flow.last_progress_at = nowIso();
        await this._persist();
        await this._capitalLedger.recordFundingEvent(flow.agent_id, 'lightning_paid', {
          amount_sats: extractInvoiceAmount(invoice) || flow.amount_sats,
          source: 'lightning_loop_out',
          status: 'invoice_paid',
          flow_id: flow.flow_id,
          address: flow.deposit_address,
          reference: flow.flow_id,
        });
        return;
      }
      if (Date.parse(flow.expires_at) <= nowMs()) {
        flow.status = 'expired';
        flow.last_error = 'The Lightning invoice expired before it was paid.';
        flow.last_progress_at = nowIso();
        await this._persist();
        await this._capitalLedger.recordFundingEvent(flow.agent_id, 'lightning_deposit_failed', {
          amount_sats: flow.amount_sats,
          source: 'lightning_loop_out',
          status: 'expired',
          flow_id: flow.flow_id,
          address: flow.deposit_address,
          reason: 'invoice_expired',
          reference: flow.flow_id,
        });
      }
      return;
    }

    if (flow.status === 'invoice_paid') {
      if (flow.next_retry_at && Date.parse(flow.next_retry_at) > nowMs()) {
        return;
      }
      if (flow.loop_out_attempts >= this.config.maxStartAttempts) {
        flow.status = 'recovery_required';
        flow.last_progress_at = nowIso();
        await this._persist();
        await this._capitalLedger.recordFundingEvent(flow.agent_id, 'lightning_deposit_recovery_required', {
          amount_sats: flow.amount_sats,
          source: 'lightning_loop_out',
          status: 'recovery_required',
          flow_id: flow.flow_id,
          address: flow.deposit_address,
          reason: flow.last_error || 'loop_out_retry_limit_reached',
          reference: flow.flow_id,
        });
        return;
      }

      try {
        flow.loop_out_attempts += 1;
        const started = await this._loopClient.startLoopOut({
          amountSats: flow.amount_sats,
          destinationAddress: flow.deposit_address,
          label: flow.loop_out_label,
          confTarget: this.config.loopOutConfTarget,
          maxSwapRoutingFeeSats: this.config.loopOutMaxRoutingFeeSats,
          fast: this.config.fast,
        });
        flow.status = 'loop_out_pending';
        flow.loop_out_started_at = nowIso();
        flow.next_retry_at = null;
        flow.loop_out_swap_id = started.swapId || flow.loop_out_swap_id || null;
        flow.last_error = null;
        flow.last_progress_at = nowIso();
        await this._persist();
        await this._capitalLedger.recordFundingEvent(flow.agent_id, 'loop_out_started', {
          amount_sats: flow.amount_sats,
          source: 'lightning_loop_out',
          status: 'loop_out_pending',
          flow_id: flow.flow_id,
          address: flow.deposit_address,
          loop_out_swap_id: flow.loop_out_swap_id,
          reference: flow.flow_id,
        });
      } catch (err) {
        flow.last_error = err.message;
        flow.last_progress_at = nowIso();
        if ((nowMs() - Date.parse(flow.invoice_paid_at || flow.created_at)) > this.config.startRetryWindowMs) {
          flow.status = 'recovery_required';
          await this._capitalLedger.recordFundingEvent(flow.agent_id, 'lightning_deposit_recovery_required', {
            amount_sats: flow.amount_sats,
            source: 'lightning_loop_out',
            status: 'recovery_required',
            flow_id: flow.flow_id,
            address: flow.deposit_address,
            reason: err.message,
            reference: flow.flow_id,
          });
        }
        await this._persist();
      }
      return;
    }

    if (flow.status === 'loop_out_pending') {
      const swap = await this._findLoopSwap(flow);
      if (swap?.id && !flow.loop_out_swap_id) {
        flow.loop_out_swap_id = swap.id;
      }
      if (swap && isFailedSwapState(swap.state)) {
        const reason = swap.failure_reason || `Loop Out failed with state ${swap.state}`;
        const described = describeFlowError(reason);
        const canRetry =
          String(reason) === 'FAILURE_REASON_OFFCHAIN'
          && flow.loop_out_attempts < this.config.maxStartAttempts
          && (nowMs() - Date.parse(flow.invoice_paid_at || flow.created_at)) <= this.config.startRetryWindowMs;
        flow.last_error = described;
        flow.last_progress_at = nowIso();
        if (canRetry) {
          flow.status = 'invoice_paid';
          flow.next_retry_at = new Date(nowMs() + this.config.retryBackoffMs).toISOString();
          await this._persist();
          await this._capitalLedger.recordFundingEvent(flow.agent_id, 'lightning_deposit_retrying', {
            amount_sats: flow.amount_sats,
            source: 'lightning_loop_out',
            status: 'invoice_paid',
            flow_id: flow.flow_id,
            address: flow.deposit_address,
            reason: flow.last_error,
            loop_out_swap_id: flow.loop_out_swap_id,
            next_retry_at: flow.next_retry_at,
            reference: flow.flow_id,
          });
        } else {
          flow.status = 'loop_out_failed';
          flow.next_retry_at = null;
          await this._persist();
          await this._capitalLedger.recordFundingEvent(flow.agent_id, 'lightning_deposit_failed', {
            amount_sats: flow.amount_sats,
            source: 'lightning_loop_out',
            status: 'loop_out_failed',
            flow_id: flow.flow_id,
            address: flow.deposit_address,
            reason: flow.last_error,
            loop_out_swap_id: flow.loop_out_swap_id,
            reference: flow.flow_id,
          });
        }
        return;
      }
      if (deposit?.status === 'pending_deposit') {
        flow.status = 'onchain_pending';
        flow.last_progress_at = nowIso();
        await this._persist();
        await this._capitalLedger.recordFundingEvent(flow.agent_id, 'loop_out_broadcast', {
          amount_sats: deposit.amount_sats || flow.amount_sats,
          source: 'lightning_loop_out',
          status: 'onchain_pending',
          flow_id: flow.flow_id,
          address: flow.deposit_address,
          txid: deposit.txid || null,
          confirmations: deposit.confirmations || 0,
          required_confirmations: deposit.confirmations_required || this._depositTracker._confirmationsRequired,
          loop_out_swap_id: flow.loop_out_swap_id,
          reference: deposit.txid || flow.flow_id,
        });
        return;
      }
      if (flow.loop_out_started_at && (nowMs() - Date.parse(flow.loop_out_started_at)) > this.config.pendingSwapTimeoutMs) {
        flow.status = 'recovery_required';
        flow.last_error = 'Loop Out did not produce an on-chain deposit before the timeout window ended.';
        flow.last_progress_at = nowIso();
        await this._persist();
        await this._capitalLedger.recordFundingEvent(flow.agent_id, 'lightning_deposit_recovery_required', {
          amount_sats: flow.amount_sats,
          source: 'lightning_loop_out',
          status: 'recovery_required',
          flow_id: flow.flow_id,
          address: flow.deposit_address,
          reason: flow.last_error,
          reference: flow.flow_id,
        });
      }
      return;
    }
  }

  async _findInvoice(walletClient, flow) {
    const baseOffset = Math.max(0, Number.parseInt(flow.invoice_add_index || '0', 10) - 5);
    const result = await walletClient.listInvoices(baseOffset, 50, false);
    const invoices = Array.isArray(result?.invoices) ? result.invoices : [];
    return invoices.find((invoice) => {
      if (flow.invoice_add_index && String(invoice?.add_index || '') === String(flow.invoice_add_index)) return true;
      if (flow.invoice_r_hash && invoice?.r_hash === flow.invoice_r_hash) return true;
      if (flow.invoice_payment_request && invoice?.payment_request === flow.invoice_payment_request) return true;
      return false;
    }) || null;
  }

  async _findLoopSwap(flow) {
    if (flow.loop_out_swap_id) {
      try {
        return await this._loopClient.getSwapInfo(flow.loop_out_swap_id);
      } catch {
        // Fall back to label scan.
      }
    }

    const result = await this._loopClient.listSwaps();
    const swaps = Array.isArray(result?.swaps) ? result.swaps : [];
    return swaps.find((swap) => swap?.label === flow.loop_out_label) || null;
  }

  _getDepositForFlow(flow) {
    const { deposits } = this._depositTracker.getDepositStatus(flow.agent_id);
    return deposits.find((deposit) => deposit.address === flow.deposit_address) || null;
  }

  _deriveStatus(flow, deposit) {
    if (!deposit) return flow.status;
    if (deposit.status === 'confirmed') return 'confirmed';
    if (deposit.status === 'pending_deposit') return 'onchain_pending';
    return flow.status;
  }

  _summarizeFlow(flow) {
    const deposit = this._getDepositForFlow(flow);
    const status = this._deriveStatus(flow, deposit);
    const describedError = describeFlowError(flow.last_error);
    return {
      flow_id: flow.flow_id,
      agent_id: flow.agent_id,
      amount_sats: flow.amount_sats,
      source: 'lightning_loop_out',
      status,
      payment_request: flow.invoice_payment_request,
      expires_at: flow.expires_at,
      deposit_address: flow.deposit_address,
      loop_out_swap_id: flow.loop_out_swap_id,
      onchain_txid: deposit?.txid || null,
      confirmations: deposit?.confirmations || 0,
      required_confirmations: deposit?.confirmations_required || this._depositTracker._confirmationsRequired,
      next_retry_at: flow.next_retry_at || null,
      last_error: describedError || null,
      hint: status === 'loop_out_failed' && describedError === describeFlowError('FAILURE_REASON_OFFCHAIN')
        ? 'Your node received the Lightning deposit, but Loop could not route its own swap payment onward.'
        : null,
      status_url: `/api/v1/capital/deposit-lightning/${encodeURIComponent(flow.flow_id)}`,
      learn: 'Pay the Lightning invoice, then wait for Loop Out to move those sats on-chain. Capital becomes usable only after the on-chain side confirms.',
    };
  }
}
