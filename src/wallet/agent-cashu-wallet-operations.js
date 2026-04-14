/**
 * Agent Cashu Wallet Operations
 *
 * Per-agent ecash wallet backed by real Cashu proofs persisted to disk.
 * Wraps @cashu/cashu-ts with mutex-protected read-modify-write cycles,
 * signed Proof Ledger accounting when enabled, legacy public ledger logging
 * only outside proof mode, and audit trail.
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
  getDecodedToken,
} from '@cashu/cashu-ts';
import { createHash } from 'node:crypto';
import { acquire } from '../identity/mutex.js';
import { logWalletOperation } from '../identity/audit-log.js';
import { canonicalProofJson } from '../proof-ledger/proof-ledger.js';

// ---------------------------------------------------------------------------
// Lightweight BOLT11 invoice validation
// ---------------------------------------------------------------------------

const BECH32_ALPHABET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
const BECH32_LOOKUP = new Map(BECH32_ALPHABET.split('').map((c, i) => [c, i]));

function sha256Hex(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function proofSafeKey(prefix, fields) {
  return `${prefix}:${sha256Hex(canonicalProofJson(fields))}`;
}

/**
 * Validate a BOLT11 invoice format and check expiry.
 * Protects against the LNbits payment-hash-reuse exploit by rejecting
 * expired invoices before they reach the Cashu mint.
 *
 * @param {string} invoice - BOLT11-encoded payment request
 * @returns {{ valid: boolean, error?: string }}
 */
export function validateBolt11Invoice(invoice) {
  if (!invoice || typeof invoice !== 'string') {
    return { valid: false, error: 'invoice (BOLT11) is required' };
  }

  const lower = invoice.toLowerCase().trim();

  // Must start with a Lightning Network HRP
  if (!/^ln(bc|tb|bcrt)/.test(lower)) {
    return { valid: false, error: 'Invoice must start with lnbc, lntb, or lnbcrt' };
  }

  // Find the bech32 separator (last '1' in the string)
  const sepIdx = lower.lastIndexOf('1');
  if (sepIdx < 4 || sepIdx >= lower.length - 6) {
    return { valid: false, error: 'Invalid BOLT11 format: missing bech32 separator' };
  }

  const dataStr = lower.slice(sepIdx + 1);

  // Validate all characters are in the bech32 alphabet
  for (let i = 0; i < dataStr.length; i++) {
    if (!BECH32_LOOKUP.has(dataStr[i])) {
      return { valid: false, error: 'Invalid BOLT11 format: bad bech32 character' };
    }
  }

  // Strip the 6-character bech32 checksum
  if (dataStr.length < 13) {
    return { valid: false, error: 'Invalid BOLT11 format: data section too short' };
  }
  const payload = dataStr.slice(0, -6);

  // First 7 groups of 5 bits = 35-bit timestamp
  if (payload.length < 7) {
    return { valid: false, error: 'Invalid BOLT11 format: missing timestamp' };
  }
  let timestamp = 0;
  for (let i = 0; i < 7; i++) {
    timestamp = timestamp * 32 + BECH32_LOOKUP.get(payload[i]);
  }

  // Walk tagged fields to find expiry (tag 'x' = bech32 value 6)
  // Each tag: 1 char tag + 2 chars data-length (big-endian, 10 bits) + data
  let expiry = 3600; // BOLT11 default: 1 hour
  let pos = 7;
  while (pos + 3 <= payload.length) {
    const tag = BECH32_LOOKUP.get(payload[pos]);
    const dataLen = BECH32_LOOKUP.get(payload[pos + 1]) * 32 + BECH32_LOOKUP.get(payload[pos + 2]);
    pos += 3;
    if (pos + dataLen > payload.length) break;

    if (tag === 6) { // 'x' tag = expiry
      let val = 0;
      for (let i = 0; i < dataLen; i++) {
        val = val * 32 + BECH32_LOOKUP.get(payload[pos + i]);
      }
      expiry = val;
      break;
    }
    pos += dataLen;
  }

  const expiresAt = timestamp + expiry;
  const now = Math.floor(Date.now() / 1000);
  if (expiresAt <= now) {
    return {
      valid: false,
      error: `Invoice expired ${now - expiresAt} seconds ago (at ${new Date(expiresAt * 1000).toISOString()}). Request a fresh invoice.`,
    };
  }

  return { valid: true };
}

export class AgentCashuWalletOperations {
  constructor({ proofStore, ledger, mintUrl, mintPort, seedManager, proofLedger = null }) {
    this._proofStore = proofStore;
    this._ledger = ledger;
    this._proofLedger = proofLedger;
    this._mintUrl = mintUrl || null;
    this._mintPort = mintPort || 3338;
    this._seedManager = seedManager || null;
    this._mint = null;
    this._agentWallets = new Map(); // agentId → { wallet, loaded: Promise }
    this._sharedWalletPromise = null; // fallback when no seedManager
    this._pendingMeltQuotes = new Map(); // `{agentId}:{quoteId}` → MeltQuoteResponse
  }

  async _appendProof(input) {
    if (!this._proofLedger?.appendProof) return null;
    return this._proofLedger.appendProof(input);
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
    if (!this._mintUrl) {
      throw new Error('Cashu mint URL not configured');
    }
    return this._mintUrl;
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
    await this._appendProof({
      idempotency_key: proofSafeKey('wallet_mint_quote_created', { agent_id: agentId, quote_id: quote.quote }),
      proof_record_type: 'money_lifecycle',
      money_event_type: 'wallet_mint_quote_created',
      money_event_status: 'created',
      agent_id: agentId,
      event_source: 'wallet_ecash',
      authorization_method: 'agent_api_key',
      primary_amount_sats: amount,
      public_safe_refs: {
        amount_sats: amount,
        quote_id: quote.quote,
        invoice_hash: sha256Hex(quote.request || ''),
        expiry: Number.isSafeInteger(quote.expiry) ? quote.expiry : null,
        status: quote.state || 'created',
      },
      allowed_public_ref_keys: ['quote_id', 'invoice_hash', 'expiry'],
    });
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

      await this._appendProof({
        idempotency_key: proofSafeKey('wallet_mint_issued', { agent_id: agentId, quote_id: quoteId }),
        proof_record_type: 'money_event',
        money_event_type: 'wallet_mint_issued',
        money_event_status: 'settled',
        agent_id: agentId,
        event_source: 'wallet_ecash',
        authorization_method: 'system_settlement',
        primary_amount_sats: amount,
        wallet_ecash_delta_sats: amount,
        public_safe_refs: {
          amount_sats: amount,
          quote_id: quoteId,
          proof_count: proofs.length,
          status: 'issued',
        },
        allowed_public_ref_keys: ['quote_id', 'proof_count'],
      });

      if (!this._proofLedger && this._ledger?.record) {
        await this._ledger.record({
          type: 'cashu_mint',
          agent_id: agentId,
          amount_sats: amount,
          proof_count: proofs.length,
        });
      }
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

    // Validate BOLT11 format and reject expired invoices before hitting the mint.
    // Prevents payment-hash-reuse exploits (e.g. LNbits CVE) by catching stale invoices early.
    const bolt11Check = validateBolt11Invoice(invoice);
    if (!bolt11Check.valid) {
      throw new Error(bolt11Check.error);
    }

    const wallet = await this._getAgentWallet(agentId);
    const quote = await wallet.createMeltQuote(invoice);

    // Store for later use by meltProofs
    this._pendingMeltQuotes.set(`${agentId}:${quote.quote}`, quote);

    await this._appendProof({
      idempotency_key: proofSafeKey('wallet_melt_quote_created', { agent_id: agentId, quote_id: quote.quote }),
      proof_record_type: 'money_lifecycle',
      money_event_type: 'wallet_melt_quote_created',
      money_event_status: 'created',
      agent_id: agentId,
      event_source: 'wallet_ecash',
      authorization_method: 'agent_api_key',
      primary_amount_sats: quote.amount,
      fee_sats: quote.fee_reserve,
      public_safe_refs: {
        amount_sats: quote.amount,
        fee_sats: quote.fee_reserve,
        quote_id: quote.quote,
        invoice_hash: sha256Hex(invoice),
        expiry: Number.isSafeInteger(quote.expiry) ? quote.expiry : null,
        status: quote.state || 'created',
      },
      allowed_public_ref_keys: ['quote_id', 'invoice_hash', 'expiry'],
    });

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
      const ecashDelta = balance - currentBalance;
      const actualFee = Math.max(0, -ecashDelta - (quote.amount || 0));

      await this._appendProof({
        idempotency_key: proofSafeKey('wallet_melt_paid', { agent_id: agentId, quote_id: quoteId }),
        proof_record_type: 'money_event',
        money_event_type: 'wallet_melt_paid',
        money_event_status: 'settled',
        agent_id: agentId,
        event_source: 'wallet_ecash',
        authorization_method: 'agent_api_key',
        primary_amount_sats: quote.amount,
        fee_sats: actualFee,
        wallet_ecash_delta_sats: ecashDelta,
        public_safe_refs: {
          amount_sats: quote.amount,
          fee_sats: actualFee,
          quote_id: quoteId,
          status: 'paid',
        },
        allowed_public_ref_keys: ['quote_id'],
      });

      if (!this._proofLedger && this._ledger?.record) {
        await this._ledger.record({
          type: 'cashu_melt',
          agent_id: agentId,
          amount_sats: quote.amount,
          fee_reserve_sats: quote.fee_reserve,
        });
      }
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

      await this._appendProof({
        idempotency_key: proofSafeKey('wallet_ecash_sent', {
          agent_id: agentId,
          token_hash: sha256Hex(token),
          amount_sats: amount,
        }),
        proof_record_type: 'money_event',
        money_event_type: 'wallet_ecash_sent',
        money_event_status: 'submitted',
        agent_id: agentId,
        event_source: 'wallet_ecash',
        authorization_method: 'agent_api_key',
        primary_amount_sats: amount,
        wallet_ecash_delta_sats: balance - currentBalance,
        public_safe_refs: {
          amount_sats: amount,
          token_hash: sha256Hex(token),
          status: 'submitted',
        },
        allowed_public_ref_keys: ['token_hash'],
      });

      if (!this._proofLedger && this._ledger?.record) {
        await this._ledger.record({
          type: 'cashu_send',
          agent_id: agentId,
          amount_sats: amount,
        });
      }
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

    // Validate mint URL to prevent keyset ID collision attacks (conduition.io disclosure).
    // Reject tokens minted by unknown mints before passing them to wallet.receive().
    const decoded = getDecodedToken(token);
    const tokenMint = decoded.mint?.replace(/\/+$/, '');
    const platformMint = this.mintUrl.replace(/\/+$/, '');
    if (tokenMint !== platformMint) {
      throw new Error(
        `Rejected: token was minted by ${tokenMint || '(unknown)'}, not by the platform mint. Only tokens from the platform mint are accepted.`
      );
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

      await this._appendProof({
        idempotency_key: proofSafeKey('wallet_ecash_received', {
          agent_id: agentId,
          token_hash: sha256Hex(token),
          amount_sats: amount,
        }),
        proof_record_type: 'money_event',
        money_event_type: 'wallet_ecash_received',
        money_event_status: 'settled',
        agent_id: agentId,
        event_source: 'wallet_ecash',
        authorization_method: 'agent_api_key',
        primary_amount_sats: amount,
        wallet_ecash_delta_sats: amount,
        public_safe_refs: {
          amount_sats: amount,
          token_hash: sha256Hex(token),
          proof_count: freshProofs.length,
          status: 'received',
        },
        allowed_public_ref_keys: ['token_hash', 'proof_count'],
      });

      if (!this._proofLedger && this._ledger?.record) {
        await this._ledger.record({
          type: 'cashu_receive',
          agent_id: agentId,
          amount_sats: amount,
          proof_count: freshProofs.length,
        });
      }
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
      return {
        recovered: 0,
        balance: await this.getBalance(agentId),
        restoreSupported: false,
      };
    }

    const wallet = await this._getAgentWallet(agentId);
    const unlock = await acquire(`cashu:${agentId}`);
    try {
      const existing = await this._proofStore.loadProofs(agentId);
      const previousBalance = existing.reduce((s, p) => s + (p.amount || 0), 0);
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
      const ecashDelta = balance - previousBalance;
      if (ecashDelta !== 0) {
        await this._appendProof({
          idempotency_key: proofSafeKey('wallet_ecash_proof_state_reconciled', {
            agent_id: agentId,
            reason: 'restore_from_seed',
            balance,
            recovered: unspent.length,
            last_counter: lastCounterWithSignature || 0,
          }),
          proof_record_type: 'money_event',
          money_event_type: 'wallet_ecash_proof_state_reconciled',
          money_event_status: 'settled',
          agent_id: agentId,
          event_source: 'wallet_ecash',
          authorization_method: 'system_settlement',
          primary_amount_sats: Math.abs(ecashDelta),
          wallet_ecash_delta_sats: ecashDelta,
          public_safe_refs: {
            amount_sats: Math.abs(ecashDelta),
            proof_count: unspent.length,
            reason: 'restore_from_seed',
            status: 'settled',
          },
          allowed_public_ref_keys: ['proof_count'],
        });
      }
      console.log(`[AgentCashuWallet] Restored ${unspent.length} proofs (${balance} sats) for agent ${agentId}`);

      return { recovered: unspent.length, balance, restoreSupported: true };
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
      const reclaimedTokenHashes = [];

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
          reclaimedTokenHashes.push(sha256Hex(send.token || ''));
        } catch {
          // Token already claimed by someone — remove from pending (don't add to remaining)
        }
      }

      await this._proofStore.savePendingSends(agentId, remaining);
      if (reclaimedAmount > 0) {
        await this._appendProof({
          idempotency_key: proofSafeKey('wallet_ecash_pending_reclaimed', {
            agent_id: agentId,
            reclaimed_amount: reclaimedAmount,
            token_hashes: reclaimedTokenHashes,
          }),
          proof_record_type: 'money_event',
          money_event_type: 'wallet_ecash_pending_reclaimed',
          money_event_status: 'settled',
          agent_id: agentId,
          event_source: 'wallet_ecash',
          authorization_method: 'system_settlement',
          primary_amount_sats: reclaimedAmount,
          wallet_ecash_delta_sats: reclaimedAmount,
          public_safe_refs: {
            amount_sats: reclaimedAmount,
            proof_count: reclaimed,
            status: 'settled',
          },
          allowed_public_ref_keys: ['proof_count'],
        });
      }
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
      const previousBalance = proofs.reduce((s, p) => s + (p.amount || 0), 0);

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
      if (removedSpent > 0) {
        await this._appendProof({
          idempotency_key: proofSafeKey('wallet_ecash_proof_state_reconciled', {
            agent_id: agentId,
            reason: 'spent_proofs_removed',
            previous_balance: previousBalance,
            balance,
            removed_spent: removedSpent,
          }),
          proof_record_type: 'money_event',
          money_event_type: 'wallet_ecash_proof_state_reconciled',
          money_event_status: 'settled',
          agent_id: agentId,
          event_source: 'wallet_ecash',
          authorization_method: 'system_settlement',
          primary_amount_sats: previousBalance - balance,
          wallet_ecash_delta_sats: balance - previousBalance,
          public_safe_refs: {
            amount_sats: previousBalance - balance,
            proof_count: removedSpent,
            reason: 'spent_proofs_removed',
            status: 'settled',
          },
          allowed_public_ref_keys: ['proof_count'],
        });
      }
      return { removedSpent, balance };
    } finally {
      unlock();
    }
  }
}
