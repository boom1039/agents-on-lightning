/**
 * Hub Wallet System
 *
 * Your node (039f11..., alias "boom") acts as the central hub.
 * Agents deposit sats via Lightning invoice, operate with internal balance,
 * and withdraw anytime.
 *
 * - Deposit: platform generates invoice via LND → agent pays → balance credited
 * - Withdraw: agent provides invoice → platform pays via LND → balance debited
 * - All transactions logged to public ledger
 */

import { randomBytes } from 'node:crypto';
import { acquire } from '../identity/mutex.js';
import { logWalletOperation } from '../identity/audit-log.js';

export class HubWallet {
  constructor({ dataLayer, nodeManager, ledger, config = {} }) {
    this._dataLayer = dataLayer;
    this._nodeManager = nodeManager;
    this._ledger = ledger;
    this._config = { ...config };
  }

  /**
   * Generate a Lightning invoice for an agent to deposit sats.
   * @param {string} agentId
   * @param {number} amountSats - Amount in satoshis
   * @param {string} [memo] - Invoice memo
   * @returns {{ payment_request, payment_hash, amount_sats, expires_at }}
   */
  async generateDepositInvoice(agentId, amountSats, memo) {
    if (!amountSats || !Number.isInteger(amountSats) || amountSats < 1000) {
      throw new Error('Deposit amount must be at least 1,000 sats');
    }
    if (amountSats > 10_000_000) {
      throw new Error('Maximum deposit is 10,000,000 sats (0.1 BTC)');
    }

    const nodeClient = this._getNodeClient();
    if (!nodeClient) {
      throw new Error('Hub node not connected. Deposits unavailable.');
    }

    const invoiceMemo = memo || `Lightning Observatory deposit for agent ${agentId}`;

    try {
      // Call LND addInvoice
      const result = await nodeClient.request('POST', '/v1/invoices', {
        value: String(amountSats),
        memo: invoiceMemo,
        expiry: '3600', // 1 hour
      });

      const depositId = randomBytes(8).toString('hex');
      const now = Date.now();

      // Track pending deposit
      await this._dataLayer.appendLog('data/wallet/pending-deposits.jsonl', {
        deposit_id: depositId,
        agent_id: agentId,
        amount_sats: amountSats,
        payment_hash: result.r_hash,
        payment_request: result.payment_request,
        status: 'pending',
        created_at: now,
        expires_at: now + 3600_000,
      });

      return {
        deposit_id: depositId,
        payment_request: result.payment_request,
        payment_hash: result.r_hash,
        amount_sats: amountSats,
        expires_at: now + 3600_000,
        message: 'Pay this Lightning invoice to deposit sats to your account.',
      };
    } catch (err) {
      throw new Error(`Failed to generate invoice: ${err.message}`);
    }
  }

  /**
   * Check if a deposit has been paid and credit the agent's balance.
   * @param {string} agentId
   * @param {string} paymentHash
   */
  async checkDeposit(agentId, paymentHash) {
    const nodeClient = this._getNodeClient();
    if (!nodeClient) {
      throw new Error('Hub node not connected');
    }

    try {
      // Look up invoice by payment hash
      const hashHex = typeof paymentHash === 'string' && paymentHash.length === 64
        ? paymentHash
        : Buffer.from(paymentHash, 'base64').toString('hex');

      const invoice = await nodeClient.request('GET', `/v1/invoice/${hashHex}`);

      if (invoice.settled) {
        const amountSats = parseInt(invoice.value, 10);

        // Serialize balance operations for this agent
        const unlock = await acquire(`wallet:${agentId}`);
        try {
          await this._creditBalance(agentId, amountSats);
        } finally {
          unlock();
        }

        // Log to public ledger
        await this._ledger.record({
          type: 'deposit',
          agent_id: agentId,
          amount_sats: amountSats,
          payment_hash: hashHex,
        });

        logWalletOperation(agentId, 'deposit', amountSats, true);
        return { status: 'settled', amount_sats: amountSats };
      }

      return { status: invoice.state || 'pending' };
    } catch (err) {
      throw new Error(`Failed to check deposit: ${err.message}`);
    }
  }

  /**
   * Withdraw sats by paying an agent-provided Lightning invoice.
   * @param {string} agentId
   * @param {string} paymentRequest - BOLT11 invoice to pay
   * @param {number} [maxFeeSats] - Maximum routing fee
   */
  async withdraw(agentId, paymentRequest, maxFeeSats = this._config.maxRoutingFeeSats) {
    if (!paymentRequest) {
      throw new Error('payment_request (BOLT11 invoice) is required');
    }

    const nodeClient = this._getNodeClient();
    if (!nodeClient) {
      throw new Error('Hub node not connected. Withdrawals unavailable.');
    }

    // Decode the invoice to get the amount
    let decoded;
    try {
      decoded = await nodeClient.request('GET', `/v1/payreq/${paymentRequest}`);
    } catch (err) {
      throw new Error(`Failed to decode invoice: ${err.message}`);
    }

    const amountSats = parseInt(decoded.num_satoshis, 10);
    if (!Number.isInteger(amountSats) || amountSats < 1000) {
      throw new Error('Withdrawal amount must be at least 1,000 sats');
    }

    // Serialize all balance operations for this agent
    const unlock = await acquire(`wallet:${agentId}`);
    try {
      // Check agent has sufficient balance (inside mutex)
      const balance = await this.getBalance(agentId);
      const totalCost = amountSats + maxFeeSats;
      if (balance < totalCost) {
        throw new Error('Insufficient balance for this withdrawal and its fee budget');
      }

      // Debit balance first (optimistic)
      await this._debitBalance(agentId, amountSats);

      try {
        // Pay the invoice
        const result = await nodeClient.request('POST', '/v1/channels/transactions', {
          payment_request: paymentRequest,
          fee_limit: { fixed: String(maxFeeSats) },
          timeout_seconds: this._config.withdrawalTimeoutSeconds,
        });

        if (result.payment_error) {
          // Refund on failure
          await this._creditBalance(agentId, amountSats);
          logWalletOperation(agentId, 'withdraw', amountSats, false);
          throw new Error(`Payment failed: ${result.payment_error}`);
        }

        const feePaid = parseInt(result.payment_route?.total_fees || '0', 10);

        // Debit the routing fee too
        if (feePaid > 0) {
          await this._debitBalance(agentId, feePaid);
        }

        // Log to public ledger
        await this._ledger.record({
          type: 'withdrawal',
          agent_id: agentId,
          amount_sats: amountSats,
          fee_sats: feePaid,
          payment_hash: result.payment_hash,
        });

        logWalletOperation(agentId, 'withdraw', amountSats, true);

        return {
          status: 'settled',
          amount_sats: amountSats,
          fee_sats: feePaid,
          payment_hash: result.payment_hash,
        };
      } catch (err) {
        if (!err.message.startsWith('Payment failed:')) {
          // Unknown error — refund
          await this._creditBalance(agentId, amountSats);
          logWalletOperation(agentId, 'withdraw', amountSats, false);
        }
        throw err;
      }
    } finally {
      unlock();
    }
  }

  /**
   * Get agent's current wallet balance.
   */
  async getBalance(agentId) {
    try {
      const state = await this._dataLayer.readJSON(`data/external-agents/${agentId}/state.json`);
      return state?.wallet_balance_sats || 0;
    } catch {
      return 0;
    }
  }

  /**
   * Get agent's transaction history.
   */
  async getHistory(agentId) {
    return this._ledger.getAgentTransactions(agentId);
  }

  /**
   * Credit an agent's balance (internal transfer, etc.)
   */
  async creditBalance(agentId, amountSats, reason) {
    const unlock = await acquire(`wallet:${agentId}`);
    try {
      await this._creditBalance(agentId, amountSats);
    } finally {
      unlock();
    }
    if (reason) {
      await this._ledger.record({
        type: 'credit',
        agent_id: agentId,
        amount_sats: amountSats,
        reason,
      });
    }
    logWalletOperation(agentId, 'credit', amountSats, true);
  }

  /**
   * Transfer sats between agents.
   */
  async transfer(fromAgentId, toAgentId, amountSats, reason) {
    if (!Number.isInteger(amountSats) || amountSats < 100) {
      throw new Error('Transfer amount must be at least 100 sats');
    }

    // Serialize balance operations for the sender
    const unlock = await acquire(`wallet:${fromAgentId}`);
    try {
      const fromBalance = await this.getBalance(fromAgentId);
      if (fromBalance < amountSats) {
        throw new Error(`Insufficient balance. Have ${fromBalance} sats, need ${amountSats}`);
      }

      await this._debitBalance(fromAgentId, amountSats);
      await this._creditBalance(toAgentId, amountSats);

      await this._ledger.record({
        type: 'transfer',
        from_agent_id: fromAgentId,
        to_agent_id: toAgentId,
        amount_sats: amountSats,
        reason: reason || 'internal transfer',
      });

      logWalletOperation(fromAgentId, 'transfer', amountSats, true);
      return { status: 'completed', amount_sats: amountSats };
    } finally {
      unlock();
    }
  }

  // --- Internal helpers ---

  async _creditBalance(agentId, amountSats) {
    const path = `data/external-agents/${agentId}/state.json`;
    let state;
    try {
      state = await this._dataLayer.readJSON(path);
    } catch {
      state = { agent_id: agentId, wallet_balance_sats: 0 };
    }
    state.wallet_balance_sats = (state.wallet_balance_sats || 0) + amountSats;
    state.last_active_at = Date.now();
    await this._dataLayer.writeJSON(path, state);
  }

  async _debitBalance(agentId, amountSats) {
    const path = `data/external-agents/${agentId}/state.json`;
    const state = await this._dataLayer.readJSON(path);
    const current = state.wallet_balance_sats || 0;
    if (current < amountSats) {
      throw new Error(`Insufficient balance: have ${current}, need ${amountSats}`);
    }
    state.wallet_balance_sats = current - amountSats;
    state.last_active_at = Date.now();
    await this._dataLayer.writeJSON(path, state);
  }

  _getNodeClient() {
    if (!this._nodeManager) return null;
    const names = this._nodeManager.getNodeNames();
    if (names.length === 0) return null;
    return this._nodeManager.getScopedDefaultNodeOrNull('wallet') || this._nodeManager.getNode(names[0]);
  }
}
