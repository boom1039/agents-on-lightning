/**
 * Agent Cashu Wallet Operations
 *
 * Per-agent ecash wallet backed by real Cashu proofs persisted to disk.
 * Wraps @cashu/cashu-ts with mutex-protected read-modify-write cycles,
 * public ledger logging, and audit trail.
 *
 * Deterministic mode (NUT-09/NUT-13): when a seedManager is provided, each
 * agent gets its own CashuWallet with a derived BIP39 seed. Every operation
 * passes a counter so proofs are deterministic — if data is lost,
 * batchRestore() recovers all unspent proofs from the mint.
 *
 * Mutex ownership: every mutating method acquires `cashu:{agentId}` for
 * the entire read-modify-write cycle. Prevents TOCTOU bugs when two
 * concurrent requests touch the same agent's proofs.
 */

import {
  CashuMint,
  CashuWallet,
  getEncodedToken,
} from '@cashu/cashu-ts';
import { acquire } from '../identity/mutex.js';
import { logWalletOperation } from '../identity/audit-log.js';

export class AgentCashuWalletOperations {
  constructor({ proofStore, ledger, mintPort, seedManager }) {
    this._proofStore = proofStore;
    this._ledger = ledger;
    this._mintPort = mintPort || 3338;
    this._seedManager = seedManager || null;
    this._mint = null;
    this._agentWallets = new Map(); // agentId → { wallet, loaded: Promise }
    this._sharedWalletPromise = null; // fallback when no seedManager
    this._pendingMeltQuotes = new Map(); // `{agentId}:{quoteId}` → MeltQuoteResponse
  }

  /**
   * Create CashuMint instance once. Idempotent.
   */
  _ensureMint() {
    if (!this._mint) {
      this._mint = new CashuMint(this.mintUrl);
    }
    return this._mint;
  }

  /**
   * Get a per-agent CashuWallet with deterministic seed.
   * Falls back to a shared random wallet if no seedManager (backwards compat).
   */
  async _getAgentWallet(agentId) {
    // Deterministic mode: per-agent wallets
    if (this._seedManager) {
      const cached = this._agentWallets.get(agentId);
      if (cached) return cached.loaded;

      const mint = this._ensureMint();
      const seed = this._seedManager.deriveAgentSeed(agentId);
      const wallet = new CashuWallet(mint, { unit: 'sat', bip39seed: seed });
      const loaded = wallet.loadMint().then(() => wallet);

      this._agentWallets.set(agentId, { wallet, loaded });

      // Clear on failure so next call retries
      loaded.catch(() => { this._agentWallets.delete(agentId); });
      return loaded;
    }

    // Fallback: shared random wallet (no deterministic seeds)
    if (this._sharedWalletPromise) return this._sharedWalletPromise;
    const promise = (async () => {
      const mint = this._ensureMint();
      const wallet = new CashuWallet(mint, { unit: 'sat' });
      await wallet.loadMint();
      console.log(`[AgentCashuWallet] Connected to mint at ${this.mintUrl} (random mode)`);
      return wallet;
    })();
    this._sharedWalletPromise = promise;
    promise.catch(() => { this._sharedWalletPromise = null; });
    return promise;
  }

  get mintUrl() {
    return `http://127.0.0.1:${this._mintPort}`;
  }

  // ---------------------------------------------------------------------------
  // Counter helpers (deterministic mode only)
  // ---------------------------------------------------------------------------

  async _loadCounter(agentId, keysetId) {
    if (!this._seedManager) return undefined; // random mode — no counter
    const counters = await this._proofStore.loadCounter(agentId);
    return counters[keysetId] || 0;
  }

  async _bumpCounter(agentId, keysetId, proofCount) {
    if (!this._seedManager) return; // random mode — noop
    const counters = await this._proofStore.loadCounter(agentId);
    counters[keysetId] = (counters[keysetId] || 0) + proofCount;
    await this._proofStore.saveCounter(agentId, counters);
  }

  _counterOpts(counter) {
    return counter !== undefined ? { counter } : {};
  }

  // ---------------------------------------------------------------------------
  // Mint flow: agent pays LN invoice → receives ecash proofs
  // ---------------------------------------------------------------------------

  async mintQuote(agentId, amount) {
    if (!Number.isInteger(amount) || amount < 1) {
      throw new Error('amount must be a positive integer (sats)');
    }
    const wallet = await this._getAgentWallet(agentId);
    const quote = await wallet.createMintQuote(amount);
    return {
      quote: quote.quote,
      request: quote.request,   // BOLT11 invoice to pay
      state: quote.state,
      expiry: quote.expiry,
    };
  }

  async checkMintQuote(agentId, quoteId) {
    if (!quoteId) throw new Error('quote_id is required');
    const wallet = await this._getAgentWallet(agentId);
    const quote = await wallet.checkMintQuote(quoteId);
    return { quote: quote.quote, state: quote.state };
  }

  async mintProofs(agentId, amount, quoteId) {
    if (!Number.isInteger(amount) || amount < 1) {
      throw new Error('amount must be a positive integer (sats)');
    }
    if (!quoteId) throw new Error('quote_id is required');

    const wallet = await this._getAgentWallet(agentId);
    const unlock = await acquire(`cashu:${agentId}`);
    try {
      const keysetId = wallet.keysetId;
      const counter = await this._loadCounter(agentId, keysetId);

      const proofs = await wallet.mintProofs(amount, quoteId, this._counterOpts(counter));

      // Bump counter before saving proofs — if crash here, we skip positions but batchRestore covers it
      await this._bumpCounter(agentId, keysetId, proofs.length);

      const existing = await this._proofStore.loadProofs(agentId);
      await this._proofStore.saveProofs(agentId, [...existing, ...proofs]);

      const balance = existing.reduce((s, p) => s + (p.amount || 0), 0)
        + proofs.reduce((s, p) => s + (p.amount || 0), 0);

      await this._ledger.record({
        type: 'cashu_mint',
        agent_id: agentId,
        amount_sats: amount,
        proof_count: proofs.length,
      });
      logWalletOperation(agentId, 'cashu_mint', amount, true);

      return { state: 'issued', proofCount: proofs.length, balance };
    } catch (err) {
      logWalletOperation(agentId, 'cashu_mint', amount, false);
      throw err;
    } finally {
      unlock();
    }
  }

  // ---------------------------------------------------------------------------
  // Melt flow: agent spends ecash proofs → pays LN invoice
  // ---------------------------------------------------------------------------

  async meltQuote(agentId, invoice) {
    if (!invoice || typeof invoice !== 'string') {
      throw new Error('invoice (BOLT11) is required');
    }
    const wallet = await this._getAgentWallet(agentId);
    const quote = await wallet.createMeltQuote(invoice);

    // Store for later use by meltProofs
    this._pendingMeltQuotes.set(`${agentId}:${quote.quote}`, quote);

    return {
      quote: quote.quote,
      amount: quote.amount,
      fee_reserve: quote.fee_reserve,
      state: quote.state,
      expiry: quote.expiry,
    };
  }

  async meltProofs(agentId, quoteId) {
    if (!quoteId) throw new Error('quote_id is required');

    const wallet = await this._getAgentWallet(agentId);

    // Retrieve stored quote, or fall back to checking with mint
    let quote = this._pendingMeltQuotes.get(`${agentId}:${quoteId}`);
    if (!quote) {
      quote = await wallet.checkMeltQuote(quoteId);
    }
    const totalNeeded = (quote.amount || 0) + (quote.fee_reserve || 0);
    // Add 1-sat buffer — the mint may round fees up. Overpayment returns as change.
    const totalToSelect = totalNeeded + 1;

    const unlock = await acquire(`cashu:${agentId}`);
    try {
      const allProofs = await this._proofStore.loadProofs(agentId);
      const currentBalance = allProofs.reduce((s, p) => s + (p.amount || 0), 0);
      if (currentBalance < totalNeeded) {
        throw new Error(`Insufficient ecash balance. Have ${currentBalance} sats, need ${totalNeeded} (${quote.amount} + ${quote.fee_reserve} fee reserve)`);
      }

      const keysetId = wallet.keysetId;
      const counter = await this._loadCounter(agentId, keysetId);

      // Select proofs for payment with 1-sat buffer for fee rounding
      const selectAmount = Math.min(totalToSelect, currentBalance);
      const { send: sendProofs, keep: keepProofs } = await wallet.send(selectAmount, allProofs, this._counterOpts(counter));

      // Bump counter for the swap outputs (keep + send)
      await this._bumpCounter(agentId, keysetId, keepProofs.length + sendProofs.length);

      // Immediately persist all post-swap proofs so nothing is lost on crash
      await this._proofStore.saveProofs(agentId, [...keepProofs, ...sendProofs]);

      // Attempt melt — if this fails, sendProofs are still on disk for recovery
      let result;
      try {
        const meltCounter = await this._loadCounter(agentId, keysetId);
        result = await wallet.meltProofs(quote, sendProofs, this._counterOpts(meltCounter));
      } catch (err) {
        // sendProofs + keepProofs already on disk from above — no data loss
        throw err;
      }

      // Bump counter for change proofs
      if (result.change?.length) {
        await this._bumpCounter(agentId, keysetId, result.change.length);
      }

      // Melt succeeded — save kept proofs + change, removing spent sendProofs
      const finalProofs = [...keepProofs, ...(result.change || [])];
      await this._proofStore.saveProofs(agentId, finalProofs);

      // Clean up stored quote
      this._pendingMeltQuotes.delete(`${agentId}:${quoteId}`);

      const balance = finalProofs.reduce((s, p) => s + (p.amount || 0), 0);

      await this._ledger.record({
        type: 'cashu_melt',
        agent_id: agentId,
        amount_sats: quote.amount,
        fee_reserve_sats: quote.fee_reserve,
      });
      logWalletOperation(agentId, 'cashu_melt', quote.amount, true);

      return { paid: true, balance };
    } catch (err) {
      logWalletOperation(agentId, 'cashu_melt', quote.amount || 0, false);
      throw err;
    } finally {
      unlock();
    }
  }

  // ---------------------------------------------------------------------------
  // Ecash send/receive: peer-to-peer token transfer
  // ---------------------------------------------------------------------------

  async sendEcash(agentId, amount) {
    if (!Number.isInteger(amount) || amount < 1) {
      throw new Error('amount must be a positive integer (sats)');
    }
    const wallet = await this._getAgentWallet(agentId);
    const unlock = await acquire(`cashu:${agentId}`);
    try {
      const allProofs = await this._proofStore.loadProofs(agentId);
      const currentBalance = allProofs.reduce((s, p) => s + (p.amount || 0), 0);
      if (currentBalance < amount) {
        throw new Error(`Insufficient ecash balance. Have ${currentBalance} sats, need ${amount}`);
      }

      const keysetId = wallet.keysetId;
      const counter = await this._loadCounter(agentId, keysetId);

      // wallet.send() may swap with the mint — original proofs can be spent after this
      const { send: sendProofs, keep: keepProofs } = await wallet.send(amount, allProofs, this._counterOpts(counter));

      // Bump counter for both keep and send proofs (swap outputs)
      await this._bumpCounter(agentId, keysetId, keepProofs.length + sendProofs.length);

      // After successful send(), persist ALL post-swap proofs immediately
      // so nothing is lost if subsequent steps fail
      await this._proofStore.saveProofs(agentId, [...keepProofs, ...sendProofs]);

      // Build the token — if this fails, sendProofs are still safe on disk
      const token = getEncodedToken({ mint: this.mintUrl, proofs: sendProofs, unit: 'sat' });

      // Token built — now remove sendProofs from stored set (they're in the token)
      await this._proofStore.saveProofs(agentId, keepProofs);
      const balance = keepProofs.reduce((s, p) => s + (p.amount || 0), 0);

      // Track the sent token for reclaim if unclaimed
      await this._proofStore.addPendingSend(agentId, { token, amount });

      await this._ledger.record({
        type: 'cashu_send',
        agent_id: agentId,
        amount_sats: amount,
      });
      logWalletOperation(agentId, 'cashu_send', amount, true);

      return { token, amount, balance };
    } catch (err) {
      logWalletOperation(agentId, 'cashu_send', amount, false);
      throw err;
    } finally {
      unlock();
    }
  }

  async receiveEcash(agentId, token) {
    if (!token || typeof token !== 'string') {
      throw new Error('token (Cashu ecash token) is required');
    }
    const wallet = await this._getAgentWallet(agentId);
    const unlock = await acquire(`cashu:${agentId}`);
    try {
      const keysetId = wallet.keysetId;
      const counter = await this._loadCounter(agentId, keysetId);

      const freshProofs = await wallet.receive(token, this._counterOpts(counter));

      // Bump counter for received proofs
      await this._bumpCounter(agentId, keysetId, freshProofs.length);

      const amount = freshProofs.reduce((s, p) => s + (p.amount || 0), 0);

      const existing = await this._proofStore.loadProofs(agentId);
      await this._proofStore.saveProofs(agentId, [...existing, ...freshProofs]);

      const balance = existing.reduce((s, p) => s + (p.amount || 0), 0) + amount;

      await this._ledger.record({
        type: 'cashu_receive',
        agent_id: agentId,
        amount_sats: amount,
        proof_count: freshProofs.length,
      });
      logWalletOperation(agentId, 'cashu_receive', amount, true);

      return { amount, proofCount: freshProofs.length, balance };
    } catch (err) {
      logWalletOperation(agentId, 'cashu_receive', 0, false);
      throw err;
    } finally {
      unlock();
    }
  }

  // ---------------------------------------------------------------------------
  // Recovery: restore proofs from deterministic seed
  // ---------------------------------------------------------------------------

  async restoreFromSeed(agentId) {
    if (!this._seedManager) {
      throw new Error('Seed recovery requires deterministic mode (seedManager not configured)');
    }

    const wallet = await this._getAgentWallet(agentId);
    const unlock = await acquire(`cashu:${agentId}`);
    try {
      const { proofs, lastCounterWithSignature } = await wallet.batchRestore();

      if (!proofs || proofs.length === 0) {
        return { recovered: 0, balance: 0 };
      }

      // Filter to only UNSPENT proofs
      const states = await wallet.checkProofsStates(proofs);
      const unspent = proofs.filter((_, i) => {
        const s = states[i];
        return !s || s.state !== 'SPENT';
      });

      await this._proofStore.saveProofs(agentId, unspent);

      // Update counter to resume after last known position
      const keysetId = wallet.keysetId;
      const newCounter = (lastCounterWithSignature || 0) + 1;
      await this._proofStore.saveCounter(agentId, { [keysetId]: newCounter });

      const balance = unspent.reduce((s, p) => s + (p.amount || 0), 0);
      console.log(`[AgentCashuWallet] Restored ${unspent.length} proofs (${balance} sats) for agent ${agentId}`);

      return { recovered: unspent.length, balance };
    } finally {
      unlock();
    }
  }

  // ---------------------------------------------------------------------------
  // Pending send reclaim: recover unclaimed sent tokens
  // ---------------------------------------------------------------------------

  async reclaimPendingSends(agentId, maxAgeMs = 86400000) {
    const wallet = await this._getAgentWallet(agentId);
    const unlock = await acquire(`cashu:${agentId}`);
    try {
      const sends = await this._proofStore.loadPendingSends(agentId);
      if (sends.length === 0) return { reclaimed: 0, reclaimedAmount: 0, pendingRemaining: 0 };

      const cutoff = Date.now() - maxAgeMs;
      let reclaimed = 0;
      let reclaimedAmount = 0;
      const remaining = [];

      for (const send of sends) {
        if (send.created_at > cutoff) {
          remaining.push(send); // too recent, skip
          continue;
        }
        try {
          const keysetId = wallet.keysetId;
          const counter = await this._loadCounter(agentId, keysetId);

          // Try to receive our own token back
          const proofs = await wallet.receive(send.token, this._counterOpts(counter));

          // Bump counter for recovered proofs
          await this._bumpCounter(agentId, keysetId, proofs.length);

          // Success — token was unclaimed, proofs recovered
          const existing = await this._proofStore.loadProofs(agentId);
          await this._proofStore.saveProofs(agentId, [...existing, ...proofs]);
          reclaimed++;
          reclaimedAmount += proofs.reduce((s, p) => s + (p.amount || 0), 0);
        } catch {
          // Token already claimed by someone — remove from pending (don't add to remaining)
        }
      }

      await this._proofStore.savePendingSends(agentId, remaining);
      return { reclaimed, reclaimedAmount, pendingRemaining: remaining.length };
    } finally {
      unlock();
    }
  }

  // ---------------------------------------------------------------------------
  // Balance & maintenance
  // ---------------------------------------------------------------------------

  async getBalance(agentId) {
    return this._proofStore.getBalance(agentId);
  }

  async checkProofStates(agentId) {
    const wallet = await this._getAgentWallet(agentId);
    const unlock = await acquire(`cashu:${agentId}`);
    try {
      const proofs = await this._proofStore.loadProofs(agentId);
      if (proofs.length === 0) return { removedSpent: 0, balance: 0 };

      const states = await wallet.checkProofsStates(proofs);

      // Filter out spent proofs (state !== 'UNSPENT')
      const live = [];
      let removedSpent = 0;
      for (let i = 0; i < proofs.length; i++) {
        const s = states[i];
        if (s && s.state === 'SPENT') {
          removedSpent++;
        } else {
          live.push(proofs[i]);
        }
      }

      if (removedSpent > 0) {
        await this._proofStore.saveProofs(agentId, live);
      }

      const balance = live.reduce((s, p) => s + (p.amount || 0), 0);
      return { removedSpent, balance };
    } finally {
      unlock();
    }
  }
}
