/**
 * Agent Wallet Routes — /api/v1/wallet/, /api/v1/ledger
 *
 * Cashu ecash wallet operations, seed recovery, deprecation stubs, public ledger.
 */

import { Router } from 'express';
import { requireAuth } from '../identity/auth.js';
import { rateLimit } from '../identity/rate-limiter.js';
import { validateAmount } from '../identity/validators.js';
import { err400Validation, err400MissingField, err500Internal, agentError } from '../identity/agent-friendly-errors.js';

export function agentWalletRoutes(daemon) {
  const router = Router();
  const auth = requireAuth(daemon.agentRegistry);

  // --- Cashu ecash wallet routes ---

  router.get('/api/v1/wallet/mint-quote', auth, rateLimit('wallet_read'), (_req, res) => {
    agentError(res, 405, {
      error: 'method_not_allowed',
      message: 'Use POST, not GET. This endpoint creates a deposit quote.',
      hint: 'POST /api/v1/wallet/mint-quote with {"amount_sats": 1000}. Returns an invoice to pay.',
      see: 'GET /api/v1/wallet/balance',
    });
  });

  router.post('/api/v1/wallet/mint-quote', auth, rateLimit('wallet_write'), async (req, res) => {
    try {
      const { amount_sats } = req.body;
      const parsed = parseInt(amount_sats, 10);
      const amtCheck = validateAmount(parsed, 1, 10_000_000);
      if (!amtCheck.valid) return err400Validation(res, amtCheck.reason, {
        hint: 'amount_sats must be an integer between 1 and 10,000,000.',
      });

      const result = await daemon.agentCashuWallet.mintQuote(req.agentId, parsed);
      res.json(result);
    } catch (err) {
      return err400Validation(res, err.message, {
        hint: 'Mint flow: POST /api/v1/wallet/mint-quote → pay invoice → POST /api/v1/wallet/mint.',
      });
    }
  });

  router.post('/api/v1/wallet/check-mint-quote', auth, rateLimit('wallet_read'), async (req, res) => {
    try {
      const { quote_id } = req.body;
      if (!quote_id) return err400MissingField(res, 'quote_id', {
        hint: 'Use the quote_id from POST /api/v1/wallet/mint-quote.',
      });

      const result = await daemon.agentCashuWallet.checkMintQuote(req.agentId, quote_id);
      res.json(result);
    } catch (err) {
      return err400Validation(res, err.message);
    }
  });

  router.post('/api/v1/wallet/mint', auth, rateLimit('wallet_write'), async (req, res) => {
    try {
      const { amount_sats, quote_id } = req.body;
      const parsed = parseInt(amount_sats, 10);
      const amtCheck = validateAmount(parsed, 1, 10_000_000);
      if (!amtCheck.valid) return err400Validation(res, amtCheck.reason);
      if (!quote_id) return err400MissingField(res, 'quote_id', {
        hint: 'Use the quote_id from POST /api/v1/wallet/mint-quote.',
      });

      const result = await daemon.agentCashuWallet.mintProofs(req.agentId, parsed, quote_id);
      res.json(result);
    } catch (err) {
      return err400Validation(res, err.message);
    }
  });

  router.post('/api/v1/wallet/melt-quote', auth, rateLimit('wallet_write'), async (req, res) => {
    try {
      const { invoice } = req.body;
      if (!invoice || typeof invoice !== 'string') {
        return err400MissingField(res, 'invoice', {
          hint: 'Provide a BOLT11 Lightning invoice starting with lnbc.',
        });
      }
      if (invoice.length > 2000) {
        return err400Validation(res, 'Invoice too long (max 2000 chars).');
      }
      if (!/^ln(bc|tb|tbs|bcrt)1[a-z0-9]+$/i.test(invoice)) {
        return err400Validation(res, 'Invalid BOLT11 invoice format.');
      }

      const result = await daemon.agentCashuWallet.meltQuote(req.agentId, invoice);
      res.json(result);
    } catch (err) {
      return err400Validation(res, err.message);
    }
  });

  router.post('/api/v1/wallet/melt', auth, rateLimit('wallet_write'), async (req, res) => {
    try {
      const { quote_id } = req.body;
      if (!quote_id) return err400MissingField(res, 'quote_id', {
        hint: 'Use the quote_id from POST /api/v1/wallet/melt-quote.',
      });

      const result = await daemon.agentCashuWallet.meltProofs(req.agentId, quote_id);
      res.json(result);
    } catch (err) {
      return err400Validation(res, err.message);
    }
  });

  router.post('/api/v1/wallet/send', auth, rateLimit('wallet_write'), async (req, res) => {
    try {
      const { amount_sats } = req.body;
      const parsed = parseInt(amount_sats, 10);
      const amtCheck = validateAmount(parsed, 1, 10_000_000);
      if (!amtCheck.valid) return err400Validation(res, amtCheck.reason);

      const result = await daemon.agentCashuWallet.sendEcash(req.agentId, parsed);
      res.json(result);
    } catch (err) {
      return err400Validation(res, err.message, {
        hint: 'Check your balance at GET /api/v1/wallet/balance.',
        see: 'GET /api/v1/wallet/balance',
      });
    }
  });

  router.post('/api/v1/wallet/receive', auth, rateLimit('wallet_write'), async (req, res) => {
    try {
      const { token } = req.body;
      if (!token || typeof token !== 'string') {
        return err400MissingField(res, 'token', {
          hint: 'Provide a Cashu ecash token string (from POST /api/v1/wallet/send).',
        });
      }
      if (typeof token !== 'string' || token.length > 10_000) {
        return err400Validation(res, 'Token must be a string under 10,000 characters.');
      }

      const result = await daemon.agentCashuWallet.receiveEcash(req.agentId, token);
      res.json(result);
    } catch (err) {
      return err400Validation(res, err.message);
    }
  });

  router.get('/api/v1/wallet/balance', auth, rateLimit('wallet_read'), async (req, res) => {
    try {
      const ecashBalance = await daemon.agentCashuWallet.getBalance(req.agentId);
      const hubBalance = await daemon.hubWallet?.getBalance(req.agentId) || 0;
      res.json({
        agent_id: req.agentId,
        balance_sats: ecashBalance,
        ecash_balance_sats: ecashBalance,
        hub_balance_sats: hubBalance,
      });
    } catch (err) {
      return err500Internal(res, 'fetching wallet balance');
    }
  });

  router.get('/api/v1/wallet/history', auth, rateLimit('wallet_read'), async (req, res) => {
    try {
      const history = await daemon.publicLedger.getAgentTransactions(req.agentId);
      res.json({ transactions: history });
    } catch (err) {
      return err500Internal(res, 'fetching wallet history');
    }
  });

  // --- Seed recovery: restore proofs from deterministic seed ---

  router.post('/api/v1/wallet/restore', auth, rateLimit('wallet_write'), async (req, res) => {
    try {
      const result = await daemon.agentCashuWallet.restoreFromSeed(req.agentId);
      res.json({
        agent_id: req.agentId,
        recovered_proofs: result.recovered,
        balance_sats: result.balance,
      });
    } catch (err) {
      return err500Internal(res, 'restoring wallet from seed');
    }
  });

  // --- Pending send reclaim: recover unclaimed sent tokens ---

  router.post('/api/v1/wallet/reclaim-pending', auth, rateLimit('wallet_write'), async (req, res) => {
    try {
      const maxAgeHours = req.body.max_age_hours != null ? Number(req.body.max_age_hours) : 24;
      const maxAgeMs = maxAgeHours * 3600 * 1000;
      const result = await daemon.agentCashuWallet.reclaimPendingSends(req.agentId, maxAgeMs);
      res.json({
        agent_id: req.agentId,
        reclaimed: result.reclaimed,
        reclaimed_amount_sats: result.reclaimedAmount,
        pending_remaining: result.pendingRemaining,
      });
    } catch (err) {
      return err500Internal(res, 'reclaiming pending sends');
    }
  });

  // --- Deprecation stubs for old hub-wallet routes ---

  router.post('/api/v1/wallet/deposit', auth, rateLimit('wallet_write'), (_req, res) => {
    agentError(res, 410, {
      error: 'endpoint_deprecated',
      message: 'This endpoint is deprecated. Use the Cashu ecash wallet instead.',
      hint: 'Mint flow: POST /api/v1/wallet/mint-quote → pay invoice → POST /api/v1/wallet/mint.',
      see: 'POST /api/v1/wallet/mint-quote',
    });
  });

  router.post('/api/v1/wallet/withdraw', auth, rateLimit('wallet_write'), (_req, res) => {
    agentError(res, 410, {
      error: 'endpoint_deprecated',
      message: 'This endpoint is deprecated. Use the Cashu ecash wallet instead.',
      hint: 'Melt flow: POST /api/v1/wallet/melt-quote → POST /api/v1/wallet/melt.',
      see: 'POST /api/v1/wallet/melt-quote',
    });
  });

  router.get('/api/v1/ledger', rateLimit('discovery'), async (_req, res) => {
    try {
      const { since, type, limit, offset } = _req.query;
      const result = await daemon.publicLedger.getAll({
        since: since ? parseInt(since, 10) : undefined,
        type: type || undefined,
        limit: limit ? parseInt(limit, 10) : 100,
        offset: offset ? parseInt(offset, 10) : 0,
      });
      res.json(result);
    } catch (err) {
      return err500Internal(res, 'fetching ledger');
    }
  });

  return router;
}
