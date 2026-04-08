import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { ECPairFactory } from 'ecpair';
import * as ecc from 'tiny-secp256k1';
import { address as btcAddress, initEccLib, networks as btcNetworks } from 'bitcoinjs-lib';
import { Musig, OutputType, SwapTreeSerializer, TaprootUtils, constructClaimTransaction, targetFee } from 'boltz-core';
import { SigHash, Transaction as RawTransaction } from '@scure/btc-signer';

const STATE_PATH = 'data/channel-market/lightning-capital-flows.json';
const BOLTZ_API_BASE = 'https://api.boltz.exchange/v2';
const LIGHTNING_BRIDGE_SOURCE = 'lightning_capital_bridge';
const ECPair = ECPairFactory(ecc);

initEccLib(ecc);

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

function isRouteFailure(error) {
  const text = String(error || '');
  return text.includes('FAILURE_REASON_OFFCHAIN') || text.includes('FAILURE_REASON_NO_ROUTE');
}

function isTransientLoopError(error) {
  const text = String(error || '').toLowerCase();
  return text.includes('timed out')
    || text.includes('timeout')
    || text.includes('temporarily unavailable')
    || text.includes('code = unavailable')
    || text.includes('connection reset')
    || text.includes('connection refused')
    || text.includes('econnrefused')
    || text.includes('socket');
}

function isBoltzFinalFailure(status) {
  return ['transaction.failed', 'transaction.refunded', 'invoice.expired', 'swap.expired'].includes(String(status || '').trim());
}

function bridgeSourceForMode(mode) {
  if (mode === 'wallet_fallback') return 'lightning_wallet_bridge';
  if (mode === 'boltz_reverse') return 'lightning_boltz_reverse';
  return 'lightning_loop_out';
}

function preferredProviderFromPreflight(preflight) {
  const ready = Array.isArray(preflight?.providers)
    ? preflight.providers.filter((entry) => entry?.available && entry?.executable !== false)
    : [];
  return ready[0]?.provider || null;
}

function toInt(value, fallback = 0) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function hexToBytes(hex) {
  return Buffer.from(String(hex || ''), 'hex');
}

function parseLoopQuoteText(result = {}) {
  const text = [result.stdout, result.stderr].filter(Boolean).join('\n');
  const send = /Send off-chain:\s+(\d+)\s+sat/i.exec(text);
  const receive = /Receive on-chain:\s+(\d+)\s+sat/i.exec(text);
  const fee = /Estimated total fee:\s+(\d+)\s+sat/i.exec(text);
  return {
    send_offchain_sats: send ? toInt(send[1]) : null,
    receive_onchain_sats: receive ? toInt(receive[1]) : null,
    estimated_total_fee_sats: fee ? toInt(fee[1]) : null,
    raw_quote: text || null,
  };
}

class BridgePreflightError extends Error {
  constructor(message, preflight) {
    super(message);
    this.name = 'BridgePreflightError';
    this.statusCode = 409;
    this.preflight = preflight;
  }
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
      enableWalletFallback: config.enableWalletFallback !== false,
      boltzApiBase: config.boltzApiBase || BOLTZ_API_BASE,
      boltzClaimFeeSatPerVbyte: Number.isFinite(config.boltzClaimFeeSatPerVbyte) ? Number(config.boltzClaimFeeSatPerVbyte) : 2,
      boltzPaymentTimeoutSeconds: Number.isInteger(config.boltzPaymentTimeoutSeconds) ? config.boltzPaymentTimeoutSeconds : 60,
      boltzMaxRoutingFeeSats: Number.isInteger(config.boltzMaxRoutingFeeSats) ? config.boltzMaxRoutingFeeSats : 250,
      providerProbePubkeys: config.providerProbePubkeys && typeof config.providerProbePubkeys === 'object'
        ? config.providerProbePubkeys
        : {},
      routeProbeFeeLimitSats: Number.isInteger(config.routeProbeFeeLimitSats) ? config.routeProbeFeeLimitSats : 100,
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

    const flowId = randomUUID();
    const bridgePreflight = await this._buildBridgePreflight(amountSats);
    if (!bridgePreflight.any_available) {
      await this._capitalLedger.recordFundingEvent(agentId, 'lightning_bridge_preflight_rejected', {
        amount_sats: amountSats,
        source: 'lightning_bridge_preflight',
        status: 'rejected',
        flow_id: flowId,
        providers: bridgePreflight.providers,
        reference: flowId,
      });
      throw new BridgePreflightError('No Lightning-to-capital bridge is ready right now for this amount.', bridgePreflight);
    }

    const unlock = await this._mutex.acquire(`lightning-capital:${agentId}`);
    try {
      const expiresAtMs = nowMs() + (this.config.invoiceExpirySeconds * 1000);
      const loopLabel = `lightning-capital:${flowId}`;
      const { address } = await this._depositTracker.generateAddress(agentId, {
        source: LIGHTNING_BRIDGE_SOURCE,
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
        bridge_mode: preferredProviderFromPreflight(bridgePreflight) || 'wallet_fallback',
        wallet_bridge_label: `lightning-capital-wallet:${flowId}`,
        wallet_bridge_txid: null,
        boltz_swap_id: null,
        boltz_status: null,
        boltz_started_at: null,
        boltz_invoice: null,
        boltz_lockup_address: null,
        boltz_lockup_txid: null,
        boltz_preimage_hex: null,
        boltz_claim_private_key: null,
        boltz_claim_public_key: null,
        boltz_refund_public_key: null,
        boltz_swap_tree: null,
        boltz_claim_tx_hex: null,
        boltz_claim_txid: null,
        boltz_claim_broadcast_at: null,
        bridge_preflight: bridgePreflight,
      };

      this._flows[flowId] = flow;
      await this._persist();
      await this._capitalLedger.recordFundingEvent(agentId, 'lightning_bridge_preflight', {
        amount_sats: amountSats,
        source: 'lightning_bridge_preflight',
        status: 'ready',
        flow_id: flowId,
        address,
        providers: bridgePreflight.providers,
        preferred_provider: bridgePreflight.preferred_provider,
        reference: flowId,
      });
      await this._capitalLedger.recordFundingEvent(agentId, 'lightning_invoice_created', {
        amount_sats: amountSats,
        source: bridgeSourceForMode(flow.bridge_mode),
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
      source: bridgeSourceForMode(flow.bridge_mode),
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
        source: deposit.source || LIGHTNING_BRIDGE_SOURCE,
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
          source: bridgeSourceForMode(flow.bridge_mode),
          status: 'onchain_pending',
          flow_id: flow.flow_id,
          address: flow.deposit_address,
          txid: deposit?.txid || null,
          gross_amount_sats: deposit?.gross_amount_sats || flow.amount_sats,
          actual_fee_sats: deposit?.bridge_fee_sats || 0,
          confirmations: deposit?.confirmations || 0,
          required_confirmations: deposit?.confirmations_required || this._depositTracker._confirmationsRequired,
          loop_out_swap_id: flow.loop_out_swap_id,
          reference: deposit?.txid || flow.flow_id,
        });
      } else if (derivedStatus === 'confirmed') {
        await this._capitalLedger.recordFundingEvent(flow.agent_id, 'lightning_deposit_confirmed', {
          amount_sats: deposit?.amount_sats || flow.amount_sats,
          source: bridgeSourceForMode(flow.bridge_mode),
          status: 'confirmed',
          flow_id: flow.flow_id,
          address: flow.deposit_address,
          txid: deposit?.txid || null,
          gross_amount_sats: deposit?.gross_amount_sats || flow.amount_sats,
          actual_fee_sats: deposit?.bridge_fee_sats || 0,
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
          source: bridgeSourceForMode(flow.bridge_mode),
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
          source: bridgeSourceForMode(flow.bridge_mode),
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
          source: bridgeSourceForMode(flow.bridge_mode),
          status: 'recovery_required',
          flow_id: flow.flow_id,
          address: flow.deposit_address,
          reason: flow.last_error || 'loop_out_retry_limit_reached',
          reference: flow.flow_id,
        });
        return;
      }

      await this._startBridge(flow);
      return;
    }

    if (flow.status === 'loop_out_pending') {
      if (flow.bridge_mode === 'boltz_reverse') {
        let boltzStatus = null;
        try {
          boltzStatus = await this._getBoltzStatus(flow);
        } catch (err) {
          flow.last_error = err.message;
          flow.last_progress_at = nowIso();
          await this._persist();
          return;
        }

        flow.boltz_status = boltzStatus?.status || flow.boltz_status;
        flow.last_progress_at = nowIso();
        await this._persist();

        if (isBoltzFinalFailure(flow.boltz_status)) {
          flow.last_error = `Boltz reverse swap failed with status ${flow.boltz_status}.`;
          flow.last_progress_at = nowIso();
          if (await this._startWalletFallback(flow, flow.last_error)) {
            return;
          }
          flow.status = 'loop_out_failed';
          await this._persist();
          await this._capitalLedger.recordFundingEvent(flow.agent_id, 'lightning_deposit_failed', {
            amount_sats: flow.amount_sats,
            source: 'lightning_boltz_reverse',
            status: 'loop_out_failed',
            flow_id: flow.flow_id,
            address: flow.deposit_address,
            boltz_swap_id: flow.boltz_swap_id,
            reason: flow.last_error,
            reference: flow.flow_id,
          });
          return;
        }

        if (['transaction.mempool', 'transaction.claim.pending'].includes(flow.boltz_status)) {
          await this._claimBoltzSwap(flow, boltzStatus);
        }
        if (deposit?.status === 'pending_deposit') {
          flow.status = 'onchain_pending';
          flow.last_progress_at = nowIso();
          await this._persist();
          await this._capitalLedger.recordFundingEvent(flow.agent_id, 'loop_out_broadcast', {
            amount_sats: deposit.amount_sats || flow.amount_sats,
            source: 'lightning_boltz_reverse',
            status: 'onchain_pending',
            flow_id: flow.flow_id,
            address: flow.deposit_address,
            txid: deposit.txid || flow.boltz_claim_txid || null,
            confirmations: deposit.confirmations || 0,
            required_confirmations: deposit.confirmations_required || this._depositTracker._confirmationsRequired,
            boltz_swap_id: flow.boltz_swap_id,
            claim_txid: flow.boltz_claim_txid,
            reference: deposit.txid || flow.boltz_claim_txid || flow.flow_id,
          });
          return;
        }
        if (flow.boltz_started_at && (nowMs() - Date.parse(flow.boltz_started_at)) > this.config.pendingSwapTimeoutMs) {
          flow.status = 'recovery_required';
          flow.last_error = 'Boltz did not produce an on-chain deposit before the timeout window ended.';
          flow.last_progress_at = nowIso();
          await this._persist();
          await this._capitalLedger.recordFundingEvent(flow.agent_id, 'lightning_deposit_recovery_required', {
            amount_sats: flow.amount_sats,
            source: 'lightning_boltz_reverse',
            status: 'recovery_required',
            flow_id: flow.flow_id,
            address: flow.deposit_address,
            boltz_swap_id: flow.boltz_swap_id,
            reason: flow.last_error,
            reference: flow.flow_id,
          });
          return;
        }
        return;
      }

      const swap = await this._findLoopSwap(flow);
      if (swap?.id && !flow.loop_out_swap_id) {
        flow.loop_out_swap_id = swap.id;
      }
      if (swap && isFailedSwapState(swap.state)) {
        const reason = swap.failure_reason || `Loop Out failed with state ${swap.state}`;
        const described = describeFlowError(reason);
        if (isRouteFailure(reason) && await this._startBoltzBridge(flow, described)) {
          return;
        }
        if (isRouteFailure(reason) && await this._startWalletFallback(flow, described)) {
          return;
        }
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
            source: bridgeSourceForMode(flow.bridge_mode),
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
            source: bridgeSourceForMode(flow.bridge_mode),
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
          source: bridgeSourceForMode(flow.bridge_mode),
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
          source: bridgeSourceForMode(flow.bridge_mode),
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
    if (!this._loopClient) return null;
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

  _getWalletClient() {
    if (!this.config.enableWalletFallback) return null;
    return this._nodeManager.getScopedDefaultNodeOrNull('withdraw')
      || this._nodeManager.getScopedDefaultNodeOrNull('wallet')
      || null;
  }

  _getWalletBalanceClient() {
    if (!this.config.enableWalletFallback) return null;
    return this._nodeManager.getScopedDefaultNodeOrNull('wallet')
      || this._nodeManager.getScopedDefaultNodeOrNull('read')
      || this._nodeManager.getScopedDefaultNodeOrNull('withdraw')
      || null;
  }

  _getRouteProbeClient() {
    return [
      this._nodeManager.getScopedDefaultNodeOrNull('read'),
      this._nodeManager.getScopedDefaultNodeOrNull('wallet'),
      this._nodeManager.getScopedDefaultNodeOrNull('open'),
      this._nodeManager.getScopedDefaultNodeOrNull('swap'),
      this._nodeManager.getScopedDefaultNodeOrNull('invoice'),
    ].filter(Boolean);
  }

  _getSwapPaymentClient() {
    return this._nodeManager.getScopedDefaultNodeOrNull('swap')
      || this._nodeManager.getScopedDefaultNodeOrNull('wallet')
      || this._nodeManager.getScopedDefaultNodeOrNull('invoice')
      || null;
  }

  async _buildBridgePreflight(amountSats) {
    const providers = [];
    providers.push(await this._quoteLoopBridge(amountSats));
    providers.push(await this._quoteBoltzBridge(amountSats));
    providers.push(await this._quoteWalletFallback(amountSats));
    const executable = providers.filter((entry) => entry.available && entry.executable !== false);
    return {
      checked_at: nowIso(),
      amount_sats: amountSats,
      any_available: executable.length > 0,
      preferred_provider: executable[0]?.provider || null,
      providers,
    };
  }

  async _probeRouteToProvider(provider, amountSats) {
    const pubkey = this.config.providerProbePubkeys?.[provider] || null;
    if (!pubkey) {
      return {
        status: 'unknown',
        pubkey: null,
        reason: 'No provider route probe pubkey is configured.',
      };
    }

    const clients = this._getRouteProbeClient();
    if (!Array.isArray(clients) || clients.length === 0) {
      return {
        status: 'unknown',
        pubkey,
        reason: 'No route-probe-capable node client is connected.',
      };
    }

    let lastError = null;
    let sawPermissionDenied = false;
    try {
      for (const client of clients) {
        if (!client || typeof client.queryRoutes !== 'function') continue;
        try {
          const result = await client.queryRoutes(pubkey, amountSats, {
            feeLimit: this.config.routeProbeFeeLimitSats,
          });
          const routes = Array.isArray(result?.routes) ? result.routes : [];
          const best = routes[0] || null;
          if (!best) {
            lastError = new Error(`No public route found to provider node for ${amountSats} sats.`);
            continue;
          }
          return {
            status: 'reachable',
            pubkey,
            fee_sats: toInt(best.total_fees),
          };
        } catch (err) {
          lastError = err;
          if (String(err?.message || '').toLowerCase().includes('permission denied')) {
            sawPermissionDenied = true;
            continue;
          }
          return {
            status: 'unreachable',
            pubkey,
            reason: err.message,
          };
        }
      }
      return {
        status: 'unreachable',
        pubkey,
        reason: sawPermissionDenied && lastError
          ? `All configured route-probe clients were denied or had no route. Last error: ${lastError.message}`
          : (lastError?.message || `No public route found to provider node for ${amountSats} sats.`),
      };
    } catch (err) {
      return {
        status: 'unreachable',
        pubkey,
        reason: err.message,
      };
    }
  }

  async _quoteLoopBridge(amountSats) {
    if (!this._loopClient) {
      return {
        provider: 'loop_out',
        available: false,
        executable: true,
        route_probe: {
          status: 'unknown',
          pubkey: this.config.providerProbePubkeys?.loop_out || null,
          reason: 'Loop client is not configured.',
        },
        reason: 'Loop client is not configured.',
      };
    }
    let lastError = null;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const result = await this._loopClient.quoteOut(amountSats, {
          confTarget: this.config.loopOutConfTarget,
          fast: this.config.fast,
        });
        const parsed = parseLoopQuoteText(result);
        const routeProbe = await this._probeRouteToProvider('loop_out', amountSats);
        const routeBlocked = routeProbe.status === 'unreachable';
        return {
          provider: 'loop_out',
          available: !routeBlocked,
          executable: true,
          estimated_total_fee_sats: parsed.estimated_total_fee_sats,
          receive_amount_sats: parsed.receive_onchain_sats,
          route_probe: routeProbe,
          reason: routeBlocked ? routeProbe.reason : null,
          details: parsed.raw_quote,
        };
      } catch (err) {
        lastError = err;
        if (!isTransientLoopError(err?.message || err) || attempt > 0) {
          break;
        }
      }
    }
    {
      return {
        provider: 'loop_out',
        available: false,
        executable: true,
        route_probe: await this._probeRouteToProvider('loop_out', amountSats),
        reason: lastError?.message || 'Loop quote failed.',
      };
    }
  }

  async _quoteBoltzBridge(amountSats) {
    try {
      const resp = await fetch(`${this.config.boltzApiBase}/swap/reverse`);
      if (!resp.ok) {
        return {
          provider: 'boltz_reverse',
          available: false,
          executable: false,
          reason: `Boltz quote failed: ${resp.status}`,
        };
      }
      const data = await resp.json();
      const btc = data?.BTC?.BTC;
      if (!btc) {
        return {
          provider: 'boltz_reverse',
          available: false,
          executable: false,
          reason: 'Boltz BTC reverse quote missing.',
        };
      }
      const minimal = toInt(btc.limits?.minimal);
      const maximal = toInt(btc.limits?.maximal);
      if ((minimal && amountSats < minimal) || (maximal && amountSats > maximal)) {
        return {
          provider: 'boltz_reverse',
          available: false,
          executable: false,
          reason: `Amount must be between ${minimal} and ${maximal} sats for Boltz.`,
        };
      }
      const percentage = Number(btc.fees?.percentage || 0);
      const claim = toInt(btc.fees?.minerFees?.claim);
      const lockup = toInt(btc.fees?.minerFees?.lockup);
      const serviceFee = Math.ceil(amountSats * percentage / 100);
      const totalFee = serviceFee + claim + lockup;
      const routeProbe = await this._probeRouteToProvider('boltz_reverse', amountSats);
      const routeBlocked = routeProbe.status === 'unreachable';
      return {
        provider: 'boltz_reverse',
        available: !routeBlocked,
        executable: true,
        estimated_total_fee_sats: totalFee,
        receive_amount_sats: Math.max(0, amountSats - totalFee),
        claim_fee_sats: claim,
        lockup_fee_sats: lockup,
        service_fee_percent: percentage,
        route_probe: routeProbe,
        reason: routeBlocked ? routeProbe.reason : null,
        details: `Boltz BTC reverse quote: ${percentage}% service fee, claim ${claim} sats, lockup ${lockup} sats.`,
      };
    } catch (err) {
      return {
        provider: 'boltz_reverse',
        available: false,
        executable: false,
        route_probe: await this._probeRouteToProvider('boltz_reverse', amountSats),
        reason: err.message,
      };
    }
  }

  async _quoteWalletFallback(amountSats) {
    const walletClient = this._getWalletBalanceClient();
    if (!walletClient) {
      return {
        provider: 'wallet_fallback',
        available: false,
        executable: true,
        reason: 'No withdraw-capable wallet node is connected.',
      };
    }
    try {
      const wallet = await walletClient.walletBalance();
      const confirmed = toInt(wallet?.confirmed_balance);
      return {
        provider: 'wallet_fallback',
        available: confirmed >= amountSats,
        executable: true,
        confirmed_balance_sats: confirmed,
        estimated_total_fee_sats: null,
        receive_amount_sats: amountSats,
        route_probe: {
          status: 'not_needed',
          reason: 'This provider uses the node wallet directly.',
        },
        reason: confirmed >= amountSats ? null : `Need ${amountSats} confirmed on-chain sats, have ${confirmed}.`,
      };
    } catch (err) {
      return {
        provider: 'wallet_fallback',
        available: false,
        executable: true,
        route_probe: {
          status: 'not_needed',
          reason: 'This provider uses the node wallet directly.',
        },
        reason: err.message,
      };
    }
  }

  async _findTransactionByLabel(client, label) {
    const txs = await client.getTransactions();
    const list = Array.isArray(txs?.transactions) ? txs.transactions : [];
    return list.find((tx) => tx?.label === label) || null;
  }

  async _startBridge(flow) {
    if (flow.bridge_mode === 'wallet_fallback') {
      const started = await this._startWalletFallback(flow);
      if (started) return;
    }
    if (flow.bridge_mode === 'boltz_reverse') {
      const started = await this._startBoltzBridge(flow);
      if (started) return;
      if (await this._startWalletFallback(flow, flow.last_error || 'Boltz bridge could not start.')) {
        return;
      }
      await this._persist();
      return;
    }
    if (!this._loopClient) {
      flow.last_error = 'Loop client is not configured.';
      flow.last_progress_at = nowIso();
      if (await this._startBoltzBridge(flow, flow.last_error)) {
        return;
      }
      if (await this._startWalletFallback(flow, flow.last_error)) {
        return;
      }
      await this._persist();
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
      flow.bridge_mode = 'loop_out';
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
      if (await this._startBoltzBridge(flow, err.message)) {
        return;
      }
      if (await this._startWalletFallback(flow, err.message)) {
        return;
      }
      if ((nowMs() - Date.parse(flow.invoice_paid_at || flow.created_at)) > this.config.startRetryWindowMs) {
        flow.status = 'recovery_required';
      await this._capitalLedger.recordFundingEvent(flow.agent_id, 'lightning_deposit_recovery_required', {
        amount_sats: flow.amount_sats,
        source: bridgeSourceForMode(flow.bridge_mode),
          status: 'recovery_required',
          flow_id: flow.flow_id,
          address: flow.deposit_address,
          reason: err.message,
          reference: flow.flow_id,
        });
      }
      await this._persist();
    }
  }

  _getBoltzQuote(flow) {
    return Array.isArray(flow?.bridge_preflight?.providers)
      ? flow.bridge_preflight.providers.find((entry) => entry?.provider === 'boltz_reverse') || null
      : null;
  }

  async _getBoltzStatus(flow) {
    if (!flow.boltz_swap_id) return null;
    const resp = await fetch(`${this.config.boltzApiBase}/swap/${encodeURIComponent(flow.boltz_swap_id)}`);
    if (!resp.ok) {
      throw new Error(`Boltz status failed: ${resp.status}`);
    }
    return resp.json();
  }

  async _startBoltzBridge(flow, reason = null) {
    const boltzQuote = this._getBoltzQuote(flow);
    if (!boltzQuote?.available || boltzQuote.executable === false) {
      return false;
    }

    const paymentClient = this._getSwapPaymentClient();
    const walletClient = this._getWalletClient();
    if (!paymentClient || !walletClient || typeof walletClient.publishTransaction !== 'function') {
      return false;
    }

    const claimKeys = ECPair.makeRandom();
    const preimage = randomBytes(32);
    const preimageHash = createHash('sha256').update(preimage).digest('hex');

    let created = null;
    try {
      const createResp = await fetch(`${this.config.boltzApiBase}/swap/reverse`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          invoiceAmount: flow.amount_sats,
          from: 'BTC',
          to: 'BTC',
          claimPublicKey: Buffer.from(claimKeys.publicKey).toString('hex'),
          preimageHash,
        }),
      });
      if (!createResp.ok) {
        flow.last_error = `Boltz create failed: ${createResp.status}`;
        flow.last_progress_at = nowIso();
        return false;
      }
      created = await createResp.json();
    } catch (err) {
      flow.last_error = `Boltz create failed: ${err.message}`;
      flow.last_progress_at = nowIso();
      return false;
    }

    if (!created?.id || !created?.invoice || !created?.refundPublicKey || !created?.swapTree) {
      flow.last_error = 'Boltz create response was missing claim data.';
      flow.last_progress_at = nowIso();
      return false;
    }

    try {
      flow.loop_out_attempts += 1;
      const payment = await paymentClient.sendPayment(
        created.invoice,
        this.config.boltzPaymentTimeoutSeconds,
        this.config.boltzMaxRoutingFeeSats,
      );
      if (payment?.payment_error) {
        flow.last_error = payment.payment_error;
        flow.last_progress_at = nowIso();
        return false;
      }
    } catch (err) {
      flow.last_error = err.message;
      flow.last_progress_at = nowIso();
      return false;
    }

    flow.bridge_mode = 'boltz_reverse';
    flow.status = 'loop_out_pending';
    flow.next_retry_at = null;
    flow.boltz_swap_id = created.id;
    flow.boltz_status = 'swap.created';
    flow.boltz_started_at = nowIso();
    flow.boltz_invoice = created.invoice;
    flow.boltz_lockup_address = created.lockupAddress || null;
    flow.boltz_preimage_hex = preimage.toString('hex');
    flow.boltz_claim_private_key = Buffer.from(claimKeys.privateKey).toString('hex');
    flow.boltz_claim_public_key = Buffer.from(claimKeys.publicKey).toString('hex');
    flow.boltz_refund_public_key = created.refundPublicKey;
    flow.boltz_swap_tree = created.swapTree;
    flow.last_error = null;
    flow.last_progress_at = nowIso();
    await this._persist();
    await this._capitalLedger.recordFundingEvent(flow.agent_id, 'boltz_swap_started', {
      amount_sats: flow.amount_sats,
      source: 'lightning_boltz_reverse',
      status: 'loop_out_pending',
      flow_id: flow.flow_id,
      address: flow.deposit_address,
      boltz_swap_id: flow.boltz_swap_id,
      gross_amount_sats: flow.amount_sats,
      actual_fee_sats: boltzQuote.estimated_total_fee_sats || null,
      reason: reason ? describeFlowError(reason) || reason : null,
      reference: flow.boltz_swap_id,
    });
    return true;
  }

  async _publishBoltzClaim(flow) {
    if (!flow.boltz_claim_tx_hex || flow.boltz_claim_broadcast_at) return true;
    const walletClient = this._getWalletClient();
    if (!walletClient || typeof walletClient.publishTransaction !== 'function') {
      flow.last_error = 'No wallet client can broadcast the Boltz claim transaction.';
      flow.last_progress_at = nowIso();
      await this._persist();
      return false;
    }
    try {
      await walletClient.publishTransaction(flow.boltz_claim_tx_hex, null, { timeoutMs: 120_000 });
      flow.boltz_claim_broadcast_at = nowIso();
      flow.last_error = null;
      flow.last_progress_at = nowIso();
      await this._persist();
      await this._capitalLedger.recordFundingEvent(flow.agent_id, 'boltz_claim_broadcast', {
        amount_sats: flow.amount_sats,
        source: 'lightning_boltz_reverse',
        status: 'onchain_pending',
        flow_id: flow.flow_id,
        address: flow.deposit_address,
        boltz_swap_id: flow.boltz_swap_id,
        claim_txid: flow.boltz_claim_txid,
        reference: flow.boltz_claim_txid || flow.boltz_swap_id,
      });
      return true;
    } catch (err) {
      flow.last_error = `Boltz claim broadcast failed: ${err.message}`;
      flow.last_progress_at = nowIso();
      await this._persist();
      return false;
    }
  }

  async _claimBoltzSwap(flow, statusData) {
    if (flow.boltz_claim_tx_hex && !flow.boltz_claim_broadcast_at) {
      return this._publishBoltzClaim(flow);
    }

    const lockupHex = statusData?.transaction?.hex || null;
    const lockupTxid = statusData?.transaction?.id || null;
    if (!lockupHex || !flow.boltz_refund_public_key || !flow.boltz_claim_public_key || !flow.boltz_claim_private_key || !flow.boltz_swap_tree) {
      flow.last_error = 'Boltz lockup details are incomplete, so the claim transaction could not be built yet.';
      flow.last_progress_at = nowIso();
      await this._persist();
      return false;
    }

    const lockupTx = RawTransaction.fromRaw(hexToBytes(lockupHex));
    const lockupScript = btcAddress.toOutputScript(flow.boltz_lockup_address, btcNetworks.bitcoin);
    let swapOutput = null;
    for (let index = 0; index < lockupTx.outputsLength; index += 1) {
      const output = lockupTx.getOutput(index);
      if (Buffer.from(output.script).equals(lockupScript)) {
        swapOutput = { ...output, vout: index };
        break;
      }
    }
    if (!swapOutput) {
      flow.last_error = 'Boltz lockup transaction did not contain the expected swap output.';
      flow.last_progress_at = nowIso();
      await this._persist();
      return false;
    }

    const claimPrivateKey = hexToBytes(flow.boltz_claim_private_key);
    const claimPublicKey = hexToBytes(flow.boltz_claim_public_key);
    const boltzPublicKey = hexToBytes(flow.boltz_refund_public_key);
    const preimage = hexToBytes(flow.boltz_preimage_hex);
    const swapTree = SwapTreeSerializer.deserializeSwapTree(flow.boltz_swap_tree);
    const musig = TaprootUtils.tweakMusig(
      Musig.create(claimPrivateKey, [boltzPublicKey, claimPublicKey]),
      swapTree.tree,
    );
    const destinationScript = btcAddress.toOutputScript(flow.deposit_address, btcNetworks.bitcoin);
    const claimTx = targetFee(this.config.boltzClaimFeeSatPerVbyte, (fee) => constructClaimTransaction([{
      transactionId: lockupTxid || lockupTx.id,
      vout: swapOutput.vout,
      script: swapOutput.script,
      amount: BigInt(swapOutput.amount),
      privateKey: claimPrivateKey,
      preimage,
      type: OutputType.Taproot,
      cooperative: true,
      swapTree,
      internalKey: musig.internalKey,
    }], destinationScript, fee));
    const transactionHash = claimTx.preimageWitnessV1(0, [swapOutput.script], SigHash.DEFAULT, [BigInt(swapOutput.amount)]);
    const nonceStage = musig.message(transactionHash).generateNonce();

    let claimDetails = null;
    try {
      const resp = await fetch(`${this.config.boltzApiBase}/swap/reverse/${encodeURIComponent(flow.boltz_swap_id)}/claim`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          index: 0,
          transaction: claimTx.hex,
          preimage: flow.boltz_preimage_hex,
          pubNonce: Buffer.from(nonceStage.publicNonce).toString('hex'),
        }),
      });
      if (!resp.ok) {
        flow.last_error = `Boltz claim signing failed: ${resp.status}`;
        flow.last_progress_at = nowIso();
        await this._persist();
        return false;
      }
      claimDetails = await resp.json();
    } catch (err) {
      flow.last_error = `Boltz claim signing failed: ${err.message}`;
      flow.last_progress_at = nowIso();
      await this._persist();
      return false;
    }

    if (claimDetails?.transactionHash) {
      const returned = String(claimDetails.transactionHash).toLowerCase();
      const local = Buffer.from(transactionHash).toString('hex').toLowerCase();
      if (returned !== local) {
        flow.last_error = 'Boltz returned a different claim transaction hash than the one the app built.';
        flow.last_progress_at = nowIso();
        await this._persist();
        return false;
      }
    }
    if (!claimDetails?.pubNonce || !claimDetails?.partialSignature) {
      flow.last_error = 'Boltz claim signing response was missing the partial signature.';
      flow.last_progress_at = nowIso();
      await this._persist();
      return false;
    }

    const finalSignature = nonceStage
      .aggregateNonces([[boltzPublicKey, hexToBytes(claimDetails.pubNonce)]])
      .initializeSession()
      .addPartial(boltzPublicKey, hexToBytes(claimDetails.partialSignature))
      .signPartial()
      .aggregatePartials();
    claimTx.updateInput(0, { finalScriptWitness: [finalSignature] });

    flow.boltz_claim_tx_hex = claimTx.hex;
    flow.boltz_claim_txid = claimTx.id;
    flow.boltz_lockup_txid = lockupTxid || lockupTx.id;
    flow.boltz_status = statusData?.status || flow.boltz_status || 'transaction.claim.pending';
    flow.last_progress_at = nowIso();
    await this._persist();
    return this._publishBoltzClaim(flow);
  }

  async _startWalletFallback(flow, reason = null) {
    const walletClient = this._getWalletClient();
    if (!walletClient) return false;

    let sendResult = null;
    let recoveredFromUnknown = false;
    try {
      sendResult = await walletClient.sendCoins(flow.deposit_address, flow.amount_sats, {
        label: flow.wallet_bridge_label,
        minConfs: 1,
        spendUnconfirmed: false,
        timeoutMs: 120000,
      });
    } catch (err) {
      const detail = String(err?.message || '');
      const unknownOutcome = /timed out|timeout|socket|network|reset|eai_again/i.test(detail);
      if (unknownOutcome) {
        try {
          const knownTx = await this._findTransactionByLabel(walletClient, flow.wallet_bridge_label);
          if (knownTx?.tx_hash) {
            sendResult = { txid: knownTx.tx_hash };
            recoveredFromUnknown = true;
          }
        } catch {}
      }
      if (!sendResult?.txid) {
        return false;
      }
    }

    flow.bridge_mode = 'wallet_fallback';
    flow.status = 'onchain_pending';
    flow.next_retry_at = null;
    flow.wallet_bridge_txid = sendResult.txid || null;
    flow.last_error = null;
    flow.last_progress_at = nowIso();
    await this._persist();
    await this._capitalLedger.recordFundingEvent(flow.agent_id, 'lightning_wallet_bridge_broadcast', {
      amount_sats: flow.amount_sats,
      source: 'lightning_wallet_bridge',
      status: 'onchain_pending',
      flow_id: flow.flow_id,
      address: flow.deposit_address,
      txid: flow.wallet_bridge_txid,
      reason: reason ? describeFlowError(reason) || reason : null,
      recovered_from_unknown: recoveredFromUnknown,
      reference: flow.wallet_bridge_txid || flow.flow_id,
    });
    return true;
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
    const source = bridgeSourceForMode(flow.bridge_mode);
    return {
      flow_id: flow.flow_id,
      agent_id: flow.agent_id,
      amount_sats: flow.amount_sats,
      credited_amount_sats: deposit?.amount_sats || null,
      gross_amount_sats: deposit?.gross_amount_sats || flow.amount_sats,
      actual_fee_sats: deposit?.bridge_fee_sats || 0,
      source,
      status,
      payment_request: flow.invoice_payment_request,
      expires_at: flow.expires_at,
      deposit_address: flow.deposit_address,
      loop_out_swap_id: flow.loop_out_swap_id,
      boltz_swap_id: flow.boltz_swap_id || null,
      onchain_txid: deposit?.txid || flow.wallet_bridge_txid || flow.boltz_claim_txid || null,
      bridge_preflight: flow.bridge_preflight || null,
      confirmations: deposit?.confirmations || 0,
      required_confirmations: deposit?.confirmations_required || this._depositTracker._confirmationsRequired,
      next_retry_at: flow.next_retry_at || null,
      last_error: describedError || null,
      hint: status === 'loop_out_failed' && describedError === describeFlowError('FAILURE_REASON_OFFCHAIN')
        ? 'Your node received the Lightning deposit, but Loop could not route its own swap payment onward.'
        : status === 'loop_out_failed' && flow.bridge_mode === 'boltz_reverse'
          ? 'Your node received the Lightning deposit, but the Boltz on-chain bridge failed before it credited capital.'
        : null,
      status_url: `/api/v1/capital/deposit-lightning/${encodeURIComponent(flow.flow_id)}`,
      learn: source === 'lightning_wallet_bridge'
        ? 'Pay the Lightning invoice, then wait for the site to broadcast the matching on-chain capital deposit. Capital becomes usable only after the on-chain side confirms.'
        : source === 'lightning_boltz_reverse'
          ? 'Pay the Lightning invoice, then wait for the site to bridge those sats on-chain through Boltz. Capital becomes usable only after the on-chain side confirms.'
        : 'Pay the Lightning invoice, then wait for Loop Out to move those sats on-chain. Capital becomes usable only after the on-chain side confirms.',
    };
  }
}
