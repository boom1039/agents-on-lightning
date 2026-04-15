/**
 * Deposit Tracker — Monitors on-chain deposits for agent capital accounts.
 *
 * Watches Bitcoin addresses generated for agents, detects incoming transactions
 * via LND's getTransactions() API, and triggers capital ledger transitions:
 *   1. Transaction detected → capitalLedger.recordDeposit() (pending)
 *   2. Confirmations >= threshold → capitalLedger.confirmDeposit() (available)
 *
 * Single-phase polling: one getTransactions() call per cycle returns each
 * transaction with num_confirmations already computed. Incremental via
 * _lastPollBlockHeight cursor — only scans recent blocks after first poll.
 * Confirmed entries auto-purge after 24h (capital ledger retains audit trail).
 *
 * State persisted to disk — survives Express restarts.
 */

import { createHash } from 'node:crypto';

const STATE_PATH = 'data/channel-market/deposit-addresses.json';
const DUST_THRESHOLD_SATS = 10_000;
const ONCHAIN_DEPOSIT_VALID_MS = 7 * 24 * 60 * 60 * 1000;
const LIGHTNING_BRIDGE_SOURCE = 'lightning_capital_bridge';
const WALLET_BRIDGE_LABEL_PREFIX = 'lightning-capital-wallet:';

function sha256Hex(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function toMs(value) {
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

function expiryForCreatedAt(createdAt) {
  const createdAtMs = toMs(createdAt) || Date.now();
  return new Date(createdAtMs + ONCHAIN_DEPOSIT_VALID_MS).toISOString();
}

function isPlainOnchain(entry) {
  return (entry.source || 'onchain') === 'onchain';
}

function isUnfundedWatching(entry) {
  return entry?.status === 'watching' && !entry.txid && isPlainOnchain(entry);
}

function isExpired(entry, now = Date.now()) {
  const expiresAtMs = toMs(entry?.expires_at);
  return Number.isFinite(expiresAtMs) && expiresAtMs <= now;
}

export class DepositTracker {
  /**
   * @param {object} opts
   * @param {import('./capital-ledger.js').CapitalLedger} opts.capitalLedger
   * @param {import('../lnd/index.js').NodeManager} opts.nodeManager
   * @param {import('../data-layer.js').DataLayer} opts.dataLayer
   * @param {import('../channel-accountability/hash-chain-audit-log.js').HashChainAuditLog} opts.auditLog
   * @param {{ acquire: (key: string) => Promise<() => void> }} opts.mutex
   * @param {import('../proof-ledger/proof-ledger.js').ProofLedger} [opts.proofLedger]
   * @param {number} [opts.confirmationsRequired=3]
   */
  constructor({ capitalLedger, nodeManager, dataLayer, auditLog, mutex, proofLedger = null, confirmationsRequired = 3 }) {
    if (!capitalLedger) throw new Error('DepositTracker requires capitalLedger');
    if (!nodeManager) throw new Error('DepositTracker requires nodeManager');
    if (!dataLayer) throw new Error('DepositTracker requires dataLayer');
    if (!auditLog) throw new Error('DepositTracker requires auditLog');
    if (!mutex) throw new Error('DepositTracker requires mutex');

    this._capitalLedger = capitalLedger;
    this._nodeManager = nodeManager;
    this._dataLayer = dataLayer;
    this._auditLog = auditLog;
    this._mutex = mutex;
    this._proofLedger = proofLedger;
    this._confirmationsRequired = confirmationsRequired;

    // address → { agent_id, created_at, status, amount_sats, txid, confirmations }
    this._state = {};
    this._pollTimer = null;
    this._lastPollBlockHeight = 0;
    this._stopping = false;
  }

  // ---------------------------------------------------------------------------
  // State persistence
  // ---------------------------------------------------------------------------

  async load() {
    try {
      const raw = await this._dataLayer.readRuntimeStateJSON(STATE_PATH, { defaultValue: {} });
      // Extract cursor (uses _ prefix — safe since Bitcoin addresses never start with _)
      if (raw._lastPollBlockHeight != null) {
        this._lastPollBlockHeight = raw._lastPollBlockHeight;
        delete raw._lastPollBlockHeight;
      }
      this._state = raw;
      let stateChanged = false;
      for (const entry of Object.values(this._state)) {
        if (isUnfundedWatching(entry) && !entry.expires_at) {
          entry.expires_at = expiryForCreatedAt(entry.created_at);
          stateChanged = true;
        }
      }
      if (stateChanged) {
        await this._persist();
      }
      const addresses = Object.keys(this._state);
      const watching = addresses.filter(a => this._state[a].status === 'watching').length;
      const pending = addresses.filter(a => this._state[a].status === 'pending_deposit').length;
      const confirmed = addresses.filter(a => this._state[a].status === 'confirmed').length;
      console.log(
        `[DepositTracker] Loaded ${addresses.length} addresses ` +
        `(${watching} watching, ${pending} pending, ${confirmed} confirmed)`
      );
    } catch (err) {
      if (err.code === 'ENOENT') {
        this._state = {};
        console.log('[DepositTracker] No existing state — starting fresh');
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
  // Address generation
  // ---------------------------------------------------------------------------

  /**
   * Generate a new Taproot deposit address for an agent.
   * @param {string} agentId
   * @returns {Promise<{ address: string }>}
   */
  async generateAddress(agentId, metadata = {}) {
    if (!agentId || typeof agentId !== 'string') {
      throw new Error('generateAddress requires a valid agentId');
    }

    const source = metadata.source || 'onchain';
    if (source === 'onchain') {
      const existing = await this._getReusableOnchainAddress(agentId);
      if (existing) return existing;
    }

    const client = this._nodeManager.getScopedDefaultNodeOrNull('wallet');
    if (!client) {
      throw new Error('No LND node available to generate deposit address');
    }

    const result = await client.newAddress('TAPROOT_PUBKEY');
    const address = result.address;

    const createdAt = new Date().toISOString();
    const expiresAt = source === 'onchain' ? expiryForCreatedAt(createdAt) : null;
    this._state[address] = {
      agent_id: agentId,
      created_at: createdAt,
      status: 'watching',
      amount_sats: null,
      txid: null,
      confirmations: 0,
      source,
      flow_id: metadata.flow_id || null,
      ...(expiresAt ? { expires_at: expiresAt } : {}),
    };

    let proof = null;
    if (this._proofLedger?.appendProof) {
      const source = metadata.source || 'onchain';
      const addressHash = sha256Hex(address);
      proof = await this._proofLedger.appendProof({
        idempotency_key: `capital-deposit-address-created:${agentId}:${addressHash}`,
        proof_record_type: 'money_lifecycle',
        money_event_type: 'capital_deposit_address_created',
        money_event_status: 'created',
        agent_id: agentId,
        event_source: source === LIGHTNING_BRIDGE_SOURCE ? 'lightning_capital' : 'capital',
        authorization_method: 'agent_signed_request',
        public_safe_refs: {
          address_hash: addressHash,
          flow_hash: typeof metadata.flow_id === 'string' ? sha256Hex(metadata.flow_id) : null,
          provider: source,
          status: 'watching',
        },
        allowed_public_ref_keys: ['address_hash', 'flow_hash'],
      });
      this._state[address].proof_id = proof?.proof_id || null;
      this._state[address].proof_hash = proof?.proof_hash || null;
    }

    await this._persist();
    console.log(`[DepositTracker] Generated address ${address} for agent ${agentId}`);

    return {
      address,
      reused: false,
      expires_at: expiresAt,
      valid_for_seconds: expiresAt ? Math.floor(ONCHAIN_DEPOSIT_VALID_MS / 1000) : null,
      proof_id: proof?.proof_id || null,
      proof_hash: proof?.proof_hash || null,
      source_of_truth: proof ? 'proof_ledger' : null,
    };
  }

  async _getReusableOnchainAddress(agentId) {
    const stateChanged = this._ensureOnchainExpirations();

    let reusable = null;
    for (const [address, entry] of Object.entries(this._state)) {
      if (entry.agent_id !== agentId) continue;
      if (!isUnfundedWatching(entry)) continue;
      if (isExpired(entry)) continue;
      if (!reusable || toMs(entry.created_at) < toMs(reusable.entry.created_at)) {
        reusable = { address, entry };
      }
    }

    if (stateChanged) await this._persist();
    if (!reusable) return null;

    return {
      address: reusable.address,
      reused: true,
      expires_at: reusable.entry.expires_at || null,
      valid_for_seconds: reusable.entry.expires_at
        ? Math.max(0, Math.floor((toMs(reusable.entry.expires_at) - Date.now()) / 1000))
        : null,
      proof_id: reusable.entry.proof_id || null,
      proof_hash: reusable.entry.proof_hash || null,
      source_of_truth: reusable.entry.proof_id ? 'proof_ledger' : null,
    };
  }

  _ensureOnchainExpirations() {
    let changed = false;
    for (const entry of Object.values(this._state)) {
      if (isUnfundedWatching(entry) && !entry.expires_at) {
        entry.expires_at = expiryForCreatedAt(entry.created_at);
        changed = true;
      }
    }
    return changed;
  }

  _expireUnfundedWatching(now) {
    let changed = false;
    for (const entry of Object.values(this._state)) {
      if (!isUnfundedWatching(entry)) continue;
      if (!entry.expires_at) {
        entry.expires_at = expiryForCreatedAt(entry.created_at);
        changed = true;
      }
      if (isExpired(entry, now)) {
        entry.status = 'expired';
        entry.expired_at = new Date(now).toISOString();
        changed = true;
      }
    }
    return changed;
  }

  // ---------------------------------------------------------------------------
  // Polling
  // ---------------------------------------------------------------------------

  startPolling(intervalMs = 30_000) {
    if (this._pollTimer) return;
    this._stopping = false;
    console.log(`[DepositTracker] Starting deposit polling every ${intervalMs / 1000}s`);
    this._pollTimer = setInterval(() => {
      this.pollForDeposits().catch(err => {
        if (!this._stopping) {
          console.error(`[DepositTracker] Poll error: ${err.message}`);
        }
      });
    }, intervalMs);
  }

  stopPolling() {
    this._stopping = true;
    if (this._pollTimer) {
      clearInterval(this._pollTimer);
      this._pollTimer = null;
      console.log('[DepositTracker] Polling stopped');
    }
  }

  /**
   * Single-phase polling: call getTransactions(), match outputs against our
   * watching addresses, detect new deposits, update confirmations.
   */
  async pollForDeposits() {
    const client = this._nodeManager.getScopedDefaultNodeOrNull('wallet');
    if (!client) return;

    // Build lookup of addresses we care about (watching or pending_deposit)
    const activeAddresses = new Set();
    for (const [addr, entry] of Object.entries(this._state)) {
      if (entry.status === 'watching' || entry.status === 'pending_deposit') {
        activeAddresses.add(addr);
      }
    }
    if (activeAddresses.size === 0) return;

    // Compute start_height: min of oldest pending block height and cursor.
    // If any pending_deposit has block_height=0 (detected in mempool), scan
    // from cursor minus a safety margin so we catch it once it confirms.
    let startHeight = this._lastPollBlockHeight;
    let hasUnminedPending = false;
    for (const entry of Object.values(this._state)) {
      if (entry.status === 'watching' || entry.status === 'pending_deposit') {
        if (entry.block_height > 0) {
          startHeight = Math.min(startHeight, entry.block_height);
        } else if (entry.status === 'pending_deposit') {
          hasUnminedPending = true;
        }
      }
    }
    // For deposits detected in mempool (block_height=0), scan back 10 blocks
    // to catch them once they're mined and update confirmation counts
    if (hasUnminedPending && startHeight > 10) {
      startHeight = Math.max(0, startHeight - 10);
    }

    let txResponse;
    try {
      txResponse = await client.getTransactions(startHeight);
    } catch (err) {
      if (!this._stopping) {
        console.error(`[DepositTracker] getTransactions failed: ${err.message}`);
      }
      return;
    }

    const transactions = txResponse.transactions || [];
    let stateChanged = false;

    for (const tx of transactions) {
      // LND getTransactions returns output_details with address + amount
      const outputs = tx.output_details || [];
      const txid = tx.tx_hash;
      const confirmations = tx.num_confirmations || 0;
      const blockHeight = tx.block_height || 0;
      const txLabel = typeof tx.label === 'string' ? tx.label : '';
      const txFeeSats = parseInt(tx.total_fees || tx.total_fees_sat || '0', 10) || 0;

      for (const output of outputs) {
        const addr = output.address;
        if (!activeAddresses.has(addr)) continue;

        const entry = this._state[addr];
        const amountSats = parseInt(output.amount, 10);
        if (!Number.isFinite(amountSats) || amountSats <= 0) continue;

        // --- Phase 1: Detect new deposit ---
        if (entry.status === 'watching' && !entry.txid) {
          const isWalletBridgeDeposit =
            entry.source === LIGHTNING_BRIDGE_SOURCE &&
            txLabel.startsWith(WALLET_BRIDGE_LABEL_PREFIX);
          const grossAmountSats = amountSats;
          const bridgeFeeSats = isWalletBridgeDeposit ? Math.max(0, txFeeSats) : 0;
          const creditedAmountSats = Math.max(0, grossAmountSats - bridgeFeeSats);

          entry.txid = txid;
          entry.amount_sats = creditedAmountSats;
          entry.gross_amount_sats = grossAmountSats;
          entry.bridge_fee_sats = bridgeFeeSats;
          entry.confirmations = confirmations;
          entry.block_height = blockHeight;

          if (creditedAmountSats < DUST_THRESHOLD_SATS) {
            console.warn(
              `[DepositTracker] Dust deposit: ${creditedAmountSats} sats to ${addr} ` +
              `(below ${DUST_THRESHOLD_SATS} threshold) — crediting anyway`
            );
          }

          try {
            await this._capitalLedger.recordDeposit(entry.agent_id, creditedAmountSats, txid, {
              source: entry.source || 'onchain',
              flow_id: entry.flow_id || null,
              address: addr,
              actual_fee_sats: bridgeFeeSats,
              gross_amount_sats: grossAmountSats,
            });
            entry.status = 'pending_deposit';
            stateChanged = true;
            console.log(
              `[DepositTracker] Deposit detected: ${creditedAmountSats} sats from ${txid} ` +
              `for agent ${entry.agent_id} (${confirmations} confirmations)`
            );
            await this._auditLog.append({
              domain: 'deposit',
              type: 'deposit_detected',
              agent_id: entry.agent_id,
              address: addr,
              amount_sats: creditedAmountSats,
              gross_amount_sats: grossAmountSats,
              actual_fee_sats: bridgeFeeSats,
              txid,
              confirmations,
            });
          } catch (err) {
            if (err.message.includes('Duplicate operation')) {
              // Already recorded — update status to match
              entry.status = 'pending_deposit';
              stateChanged = true;
            } else {
              console.error(
                `[DepositTracker] Failed to record deposit for ${entry.agent_id}: ${err.message}`
              );
            }
          }
        }

        // --- Phase 2: Confirm deposit ---
        if (entry.status === 'pending_deposit' && entry.txid === txid) {
          entry.confirmations = confirmations;
          // Update block_height if deposit was detected in mempool (0) and now mined
          if (!entry.block_height && blockHeight > 0) {
            entry.block_height = blockHeight;
            stateChanged = true;
          }

          if (confirmations >= this._confirmationsRequired) {
            try {
              await this._capitalLedger.confirmDeposit(entry.agent_id, entry.amount_sats, txid, {
                source: entry.source || 'onchain',
                flow_id: entry.flow_id || null,
                address: addr,
                actual_fee_sats: entry.bridge_fee_sats || 0,
                gross_amount_sats: entry.gross_amount_sats || entry.amount_sats,
              });
              entry.status = 'confirmed';
              entry.confirmed_at = new Date().toISOString();
              stateChanged = true;
              console.log(
                `[DepositTracker] Deposit confirmed: ${entry.amount_sats} sats from ${txid} ` +
                `for agent ${entry.agent_id} (${confirmations} confirmations)`
              );
              await this._auditLog.append({
                domain: 'deposit',
                type: 'deposit_confirmed',
                agent_id: entry.agent_id,
                address: addr,
                amount_sats: entry.amount_sats,
                gross_amount_sats: entry.gross_amount_sats || entry.amount_sats,
                actual_fee_sats: entry.bridge_fee_sats || 0,
                txid,
                confirmations,
              });
            } catch (err) {
              if (err.message.includes('Duplicate operation')) {
                entry.status = 'confirmed';
                entry.confirmed_at = entry.confirmed_at || new Date().toISOString();
                stateChanged = true;
              } else {
                console.error(
                  `[DepositTracker] Failed to confirm deposit for ${entry.agent_id}: ${err.message}`
                );
              }
            }
          }
        }
      }
    }

    // --- Purge confirmed entries older than 24h ---
    const PURGE_AGE_MS = 24 * 60 * 60 * 1000;
    const now = Date.now();
    if (this._ensureOnchainExpirations()) stateChanged = true;
    if (this._expireUnfundedWatching(now)) stateChanged = true;
    for (const [addr, entry] of Object.entries(this._state)) {
      if (entry.status === 'confirmed' && entry.confirmed_at) {
        if (now - new Date(entry.confirmed_at).getTime() > PURGE_AGE_MS) {
          delete this._state[addr];
          stateChanged = true;
        }
      }
    }

    // --- Update block height cursor ---
    try {
      const best = await client.getBestBlock();
      if (best?.block_height) {
        this._lastPollBlockHeight = best.block_height;
        stateChanged = true;
      }
    } catch { /* non-fatal — cursor stays at previous value */ }

    if (stateChanged) {
      await this._persist();
    }

    // --- Periodic aggregate solvency check ---
    try {
      const solvency = await this._capitalLedger.checkAggregateBalance(client);
      if (!solvency.is_solvent) {
        await this._auditLog.append({
          domain: 'capital',
          type: 'solvency_warning',
          total_committed_sats: solvency.total_committed_sats,
          on_chain_balance_sats: solvency.on_chain_balance_sats,
          shortfall_sats: solvency.shortfall_sats,
        });
      }
    } catch { /* non-fatal — solvency check is advisory */ }
  }

  // ---------------------------------------------------------------------------
  // Query
  // ---------------------------------------------------------------------------

  /**
   * Get all deposits for a specific agent.
   * @param {string} agentId
   * @returns {{ deposits: Array<object> }}
   */
  getDepositStatus(agentId) {
    const deposits = [];
    for (const [addr, entry] of Object.entries(this._state)) {
      if (entry.agent_id !== agentId) continue;
      deposits.push({
        address: addr,
        status: entry.status,
        amount_sats: entry.amount_sats,
        ...(entry.gross_amount_sats != null ? { gross_amount_sats: entry.gross_amount_sats } : {}),
        ...(entry.bridge_fee_sats != null ? { actual_fee_sats: entry.bridge_fee_sats } : {}),
        txid: entry.txid,
        confirmations: entry.confirmations,
        confirmations_required: this._confirmationsRequired,
        created_at: entry.created_at,
        ...(entry.expires_at ? { expires_at: entry.expires_at } : {}),
        ...(entry.expired_at ? { expired_at: entry.expired_at } : {}),
        source: entry.source || 'onchain',
        ...(entry.flow_id ? { flow_id: entry.flow_id } : {}),
        ...(entry.confirmed_at && { confirmed_at: entry.confirmed_at }),
      });
    }
    return { deposits };
  }

  /**
   * Get counts of all tracked addresses by status.
   */
  getStats() {
    const counts = { watching: 0, pending_deposit: 0, confirmed: 0, expired: 0, total: 0 };
    for (const entry of Object.values(this._state)) {
      counts[entry.status] = (counts[entry.status] || 0) + 1;
      counts.total++;
    }
    return counts;
  }
}
