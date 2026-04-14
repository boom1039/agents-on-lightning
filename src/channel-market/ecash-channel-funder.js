/**
 * Ecash Channel Funder — Plan J
 *
 * Chains ecash extraction, capital ledger credit, and the existing channel
 * opener into one flow. An agent with Cashu ecash can open a Lightning
 * channel in a single API call.
 *
 * Flow:
 *   1. Validate ecash balance >= amount
 *   2. sendEcash() → swap proofs with mint, get token
 *   3. Persist flow { token, status: 'extracted' } (crash safety)
 *   4. creditEcashFunding() → capital ledger credit
 *   5. channelOpener.open() → standard 12-step validation + LND open
 *   6. Mark flow complete
 *
 * Crash recovery (load):
 *   - 'extracted' flows → refund via receiveEcash()
 *   - 'credited' flows → mark recovered (capital already in available)
 *   - 'complete' flows → no-op
 */

import { randomUUID } from 'node:crypto';
import { summarizeLndError } from '../lnd/agent-error-utils.js';

const STATE_PATH = 'data/channel-market/ecash-funding-flows.json';

export class EcashChannelFunder {
  /**
   * @param {object} opts
   * @param {import('../wallet/agent-cashu-wallet-operations.js').AgentCashuWalletOperations} opts.walletOps
   * @param {import('./channel-opener.js').ChannelOpener} opts.channelOpener
   * @param {import('./capital-ledger.js').CapitalLedger} opts.capitalLedger
   * @param {import('../data-layer.js').DataLayer} opts.dataLayer
   * @param {import('../channel-accountability/hash-chain-audit-log.js').HashChainAuditLog} opts.auditLog
   * @param {{ acquire: (key: string) => Promise<() => void> }} opts.mutex
   */
  constructor({ walletOps, channelOpener, capitalLedger, dataLayer, auditLog, mutex }) {
    if (!walletOps) throw new Error('EcashChannelFunder requires walletOps');
    if (!channelOpener) throw new Error('EcashChannelFunder requires channelOpener');
    if (!capitalLedger) throw new Error('EcashChannelFunder requires capitalLedger');
    if (!dataLayer) throw new Error('EcashChannelFunder requires dataLayer');
    if (!auditLog) throw new Error('EcashChannelFunder requires auditLog');
    if (!mutex) throw new Error('EcashChannelFunder requires mutex');

    this._walletOps = walletOps;
    this._channelOpener = channelOpener;
    this._capitalLedger = capitalLedger;
    this._dataLayer = dataLayer;
    this._auditLog = auditLog;
    this._mutex = mutex;
    this._flows = {};
  }

  // ---------------------------------------------------------------------------
  // Persistence
  // ---------------------------------------------------------------------------

  async _saveFlows() {
    await this._dataLayer.writeJSON(STATE_PATH, this._flows);
  }

  async _loadFlows() {
    try {
      this._flows = await this._dataLayer.readJSON(STATE_PATH);
    } catch (err) {
      if (err.code === 'ENOENT') this._flows = {};
      else throw err;
    }
  }

  // ---------------------------------------------------------------------------
  // Crash recovery
  // ---------------------------------------------------------------------------

  /**
   * Called on startup. Recovers flows left in intermediate states.
   * - 'extracted': ecash was sent but capital not credited → refund
   * - 'credited': capital credited but open not confirmed → mark recovered
   * - 'complete'/'failed': no-op
   */
  async load() {
    await this._loadFlows();
    let recovered = 0;

    for (const [flowId, flow] of Object.entries(this._flows)) {
      if (flow.status === 'extracted' && flow.token) {
        // Refund — ecash was taken but capital never credited
        try {
          await this._walletOps.receiveEcash(flow.agent_id, flow.token);
          flow.status = 'refunded_on_recovery';
          flow.recovered_at = new Date().toISOString();
          recovered++;
          console.log(`[EcashChannelFunder] Recovered flow ${flowId}: refunded ${flow.amount_sats} sats to ${flow.agent_id}`);
        } catch (err) {
          console.error(`[EcashChannelFunder] CRITICAL: Recovery refund failed for flow ${flowId}: ${err.message}`);
          flow.status = 'recovery_failed';
          flow.recovery_error = err.message;
        }
      } else if (flow.status === 'credited') {
        // Capital is in available — safe, just mark as recovered
        flow.status = 'recovered_credited';
        flow.recovered_at = new Date().toISOString();
        recovered++;
        console.log(`[EcashChannelFunder] Recovered flow ${flowId}: capital already in available for ${flow.agent_id}`);
      }
    }

    if (recovered > 0) {
      await this._saveFlows();
      console.log(`[EcashChannelFunder] Recovered ${recovered} flows on startup`);
    }
  }

  // ---------------------------------------------------------------------------
  // Main flow
  // ---------------------------------------------------------------------------

  /**
   * Fund a channel from ecash in one shot.
   *
   * @param {string} agentId - The agent's ID
   * @param {object} payload - Standard channel open payload (signed instruction)
   * @returns {Promise<object>} - Channel open result with flow metadata
   */
  async fundChannelFromEcash(agentId, payload) {
    // 1. Extract amount from instruction params
    const amount = payload?.instruction?.params?.local_funding_amount_sats;
    if (!amount || !Number.isInteger(amount) || amount <= 0) {
      return {
        success: false,
        status: 400,
        error: 'Missing or invalid local_funding_amount_sats in instruction params',
        learn: 'The instruction.params.local_funding_amount_sats must be a positive integer.',
      };
    }

    // 2. Check ecash balance
    let balance;
    try {
      balance = await this._walletOps.getBalance(agentId);
    } catch (err) {
      return {
        success: false,
        status: 500,
        error: `Failed to check ecash balance: ${err.message}`,
      };
    }

    if (balance < amount + 1) {
      return {
        success: false,
        status: 400,
        error: `Insufficient ecash balance: have ${balance} sats, need ${amount + 1} sats (amount + 1 sat swap buffer)`,
        learn: 'Your ecash wallet needs at least the channel amount + 1 sat for the NUT-02 swap buffer. ' +
               'Fund your ecash wallet first via POST /api/v1/wallet/mint.',
      };
    }

    // 3. Acquire mutex
    const unlock = await this._mutex.acquire(`ecash-fund:${agentId}`);
    const flowId = randomUUID();

    try {
      // 4. sendEcash → swap proofs with mint
      let token;
      try {
        const sendResult = await this._walletOps.sendEcash(agentId, amount);
        token = sendResult.token;
      } catch (err) {
        return {
          success: false,
          status: 402,
          error: `Ecash extraction failed: ${err.message}`,
          learn: 'The ecash swap with the mint failed. Your balance was not debited. Try again.',
        };
      }

      // 5. Persist flow (crash safety — if we crash after sendEcash, load() refunds)
      this._flows[flowId] = {
        flow_id: flowId,
        agent_id: agentId,
        amount_sats: amount,
        status: 'extracted',
        token,
        created_at: new Date().toISOString(),
      };
      await this._saveFlows();

      // 6. Credit capital ledger
      try {
        await this._capitalLedger.creditEcashFunding(agentId, amount, `ecash-fund:${flowId}`);
      } catch (err) {
        // Credit failed → refund ecash
        try {
          await this._walletOps.receiveEcash(agentId, token);
        } catch (refundErr) {
          console.error(
            `[EcashChannelFunder] CRITICAL: Refund failed after credit failure for flow ${flowId}: ${refundErr.message}. ` +
            `Token saved in flow for manual recovery.`
          );
        }
        this._flows[flowId].status = 'failed';
        this._flows[flowId].error = `Credit failed: ${err.message}`;
        await this._saveFlows();

        return {
          success: false,
          status: 500,
          error: `Capital credit failed: ${err.message}. Ecash has been refunded.`,
        };
      }

      // 7. Update flow status
      this._flows[flowId].status = 'credited';
      this._flows[flowId].token = null; // Clear token — conversion succeeded, no refund needed
      await this._saveFlows();

      // 8. Delegate to channel opener
      let openResult;
      try {
        openResult = await this._channelOpener.open(agentId, payload);
      } catch (err) {
        // Channel open threw — capital stays in available
        this._flows[flowId].status = 'open_failed';
        this._flows[flowId].error = err.message;
        await this._saveFlows();

        return {
          success: false,
          status: 500,
          error: summarizeLndError(err.message, {
            action: 'channel open',
            fallback: 'Channel open failed.',
          }),
          flow_id: flowId,
          ecash_spent_sats: amount,
          learn: 'The ecash-to-capital conversion succeeded but the channel open failed. ' +
                 'Your capital is available in your capital ledger (GET /api/v1/capital/balance). ' +
                 'You can retry the channel open via POST /api/v1/market/open.',
        };
      }

      // 9. Handle open result (opener returns { success, ... })
      if (!openResult.success) {
        this._flows[flowId].status = 'open_failed';
        this._flows[flowId].error = openResult.error || 'Channel open rejected';
        await this._saveFlows();

        return {
          ...openResult,
          flow_id: flowId,
          ecash_spent_sats: amount,
          learn: 'The ecash-to-capital conversion succeeded but the channel open was rejected: ' +
                 (openResult.error || 'unknown reason') + '. ' +
                 'Your capital is available in your capital ledger (GET /api/v1/capital/balance). ' +
                 'You can retry the channel open via POST /api/v1/market/open.',
        };
      }

      // 10. Success
      const openDetails = openResult.result || openResult;
      this._flows[flowId].status = 'complete';
      this._flows[flowId].completed_at = new Date().toISOString();
      this._flows[flowId].open_result = {
        channel_point: openDetails.channel_point,
        funding_txid: openDetails.funding_txid,
        instruction_hash: openDetails.instruction_hash,
      };
      await this._saveFlows();

      await this._auditLog.append({
        domain: 'ecash_channel_funding',
        type: 'fund_channel_from_ecash',
        agent_id: agentId,
        flow_id: flowId,
        amount_sats: amount,
        channel_point: openDetails.channel_point,
      });

      return {
        ...openResult,
        flow_id: flowId,
        ecash_spent_sats: amount,
        learn: `Channel funded from ecash! ${amount} sats converted from your ecash wallet to capital, ` +
               'then used to open a channel. The channel is now pending activation. ' +
               `Track status: GET /api/v1/market/fund-from-ecash/${flowId}`,
      };
    } finally {
      unlock();
    }
  }

  // ---------------------------------------------------------------------------
  // Status queries
  // ---------------------------------------------------------------------------

  /**
   * Get a single flow's status (strips token for security).
   */
  getFlowStatus(flowId) {
    const flow = this._flows[flowId];
    if (!flow) return null;
    const { token, ...safe } = flow;
    return safe;
  }

  /**
   * Get all flows for an agent (summaries only).
   */
  getFlowHistory(agentId) {
    return Object.values(this._flows)
      .filter(f => f.agent_id === agentId)
      .map(({ token, ...safe }) => safe)
      .sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''));
  }

  getPendingForAgent(agentId) {
    return Object.values(this._flows)
      .filter((flow) => flow.agent_id === agentId)
      .filter((flow) => ['extracted', 'credited'].includes(flow.status));
  }
}
