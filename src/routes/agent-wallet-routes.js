/**
 * Agent Wallet Routes — /api/v1/wallet/, /api/v1/ledger
 *
 * Cashu ecash wallet operations, seed recovery, public ledger.
 */

import { Router } from 'express';
import { requireAuth } from '../identity/auth.js';
import { rateLimit } from '../identity/rate-limiter.js';
import { validateAmount } from '../identity/validators.js';
import { err400Validation, err400MissingField, err500Internal, agentError, buildRecovery } from '../identity/agent-friendly-errors.js';

export function agentWalletRoutes(daemon) {
  const router = Router();
  const auth = requireAuth(daemon.agentRegistry);

  // --- Cashu ecash wallet routes ---

  // Read wallet mint quote.
  // @agent-route {"auth":"agent","domain":"wallet","subgroup":"Deposit","label":"mint-quote","summary":"Read wallet mint quote.","order":100,"tags":["wallet","read","agent"],"doc":"skills/wallet.txt","security":{"moves_money":false,"requires_ownership":true,"requires_signature":false,"long_running":false}}
  router.get('/api/v1/wallet/mint-quote', auth, rateLimit('wallet_read'), (_req, res) => {
    res.json({
      message: 'This is the wallet mint help route.',
      learn: 'Use POST /api/v1/wallet/mint-quote to create a real wallet funding invoice.',
      next: [
        'GET /api/v1/wallet/balance',
        'POST /api/v1/wallet/mint-quote',
        'POST /api/v1/wallet/check-mint-quote',
        'POST /api/v1/wallet/mint',
      ],
      example_request: {
        method: 'POST',
        path: '/api/v1/wallet/mint-quote',
        json: { amount_sats: 1000 },
      },
    });
  });

  // Create wallet mint quote.
  // @agent-route {"auth":"agent","domain":"wallet","subgroup":"Deposit","label":"mint-quote","summary":"Create wallet mint quote.","order":110,"tags":["wallet","write","agent"],"doc":"skills/wallet.txt","security":{"moves_money":false,"requires_ownership":true,"requires_signature":false,"long_running":false}}
  router.post('/api/v1/wallet/mint-quote', auth, rateLimit('wallet_write'), async (req, res) => {
    try {
      const { amount_sats } = req.body;
      const parsed = parseInt(amount_sats, 10);
      const amtCheck = validateAmount(parsed, 1, 10_000_000);
      if (!amtCheck.valid) return err400Validation(res, amtCheck.reason, {
        hint: 'amount_sats must be an integer between 1 and 10,000,000.',
      });

      const result = await daemon.agentCashuWallet.mintQuote(req.agentId, parsed);
      res.json({
        ...result,
        cost_summary: { action: 'mint_quote', amount_sats: parsed, fee_sats: 0, total_sats: parsed, unit: 'sat' },
      });
    } catch (err) {
      return agentError(res, 400, {
        error: 'validation_error',
        message: err.message,
        hint: 'Mint flow: POST /api/v1/wallet/mint-quote → pay invoice → POST /api/v1/wallet/mint.',
        extra: { recovery: buildRecovery('safe', 'No sats were deducted. Quote creation failed before any funds moved.', [
          'Fix the request and retry POST /api/v1/wallet/mint-quote',
        ]) },
      });
    }
  });

  // Check wallet check mint quote.
  // @agent-route {"auth":"agent","domain":"wallet","subgroup":"Deposit","label":"check-mint-quote","summary":"Check wallet check mint quote.","order":120,"tags":["wallet","write","agent"],"doc":"skills/wallet.txt","security":{"moves_money":false,"requires_ownership":true,"requires_signature":false,"long_running":false}}
  router.post('/api/v1/wallet/check-mint-quote', auth, rateLimit('wallet_read'), async (req, res) => {
    try {
      const { quote_id } = req.body;
      if (!quote_id) return err400MissingField(res, 'quote_id', {
        hint: 'Use the quote_id from POST /api/v1/wallet/mint-quote.',
      });

      const result = await daemon.agentCashuWallet.checkMintQuote(req.agentId, quote_id);
      res.json(result);
    } catch (err) {
      return agentError(res, 400, {
        error: 'validation_error',
        message: err.message,
        extra: { recovery: buildRecovery('safe', 'This is a read-only status check. No funds were affected.', [
          'Verify your quote_id and retry POST /api/v1/wallet/check-mint-quote',
        ]) },
      });
    }
  });

  // Mint wallet.
  // @agent-route {"auth":"agent","domain":"wallet","subgroup":"Deposit","label":"mint","summary":"Mint wallet.","order":130,"tags":["wallet","write","agent"],"doc":"skills/wallet.txt","security":{"moves_money":true,"requires_ownership":true,"requires_signature":false,"long_running":false}}
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
      res.json({
        ...result,
        cost_summary: { action: 'mint', amount_sats: parsed, fee_sats: 0, total_sats: parsed, unit: 'sat' },
      });
    } catch (err) {
      return agentError(res, 400, {
        error: 'validation_error',
        message: err.message,
        extra: { recovery: buildRecovery('action_needed', 'If you already paid the invoice, your sats are held by the mint. Retry minting with the same quote_id to claim them.', [
          'Retry POST /api/v1/wallet/mint with the same quote_id and amount_sats',
          'If retries fail, POST /api/v1/wallet/restore to recover proofs from seed',
        ]) },
      });
    }
  });

  // Create wallet melt quote.
  // @agent-route {"auth":"agent","domain":"wallet","subgroup":"Spending","label":"melt-quote","summary":"Create wallet melt quote.","order":300,"tags":["wallet","write","agent"],"doc":"skills/wallet.txt","security":{"moves_money":false,"requires_ownership":true,"requires_signature":false,"long_running":false}}
  router.post('/api/v1/wallet/melt-quote', auth, rateLimit('wallet_write'), async (req, res) => {
    try {
      const { invoice } = req.body;
      if (!invoice || typeof invoice !== 'string') {
        return agentError(res, 400, {
          error: 'missing_required_field',
          message: 'invoice is required.',
          hint: 'Provide a BOLT11 Lightning invoice starting with lnbc.',
          extra: { recovery: buildRecovery('safe', 'No sats were deducted. Quote creation requires a valid invoice.', [
            'POST /api/v1/wallet/melt-quote with {"invoice": "lnbc..."}',
          ]) },
        });
      }
      if (invoice.length > 2000) {
        return agentError(res, 400, {
          error: 'validation_error',
          message: 'Invoice too long (max 2000 chars).',
          extra: { recovery: buildRecovery('safe', 'No sats were deducted. The invoice was rejected before any funds moved.', [
            'Use a shorter BOLT11 invoice and retry POST /api/v1/wallet/melt-quote',
          ]) },
        });
      }

      const result = await daemon.agentCashuWallet.meltQuote(req.agentId, invoice);
      res.json({
        ...result,
        cost_summary: { action: 'melt_quote', amount_sats: result.amount, fee_sats: result.fee_reserve, total_sats: result.amount + result.fee_reserve, unit: 'sat' },
      });
    } catch (err) {
      return agentError(res, 400, {
        error: 'validation_error',
        message: err.message,
        extra: { recovery: buildRecovery('safe', 'No sats were deducted. Melt quote creation failed before any funds moved.', [
          'Request a fresh invoice from the recipient',
          'POST /api/v1/wallet/melt-quote with the new invoice',
        ]) },
      });
    }
  });

  // Melt wallet.
  // @agent-route {"auth":"agent","domain":"wallet","subgroup":"Spending","label":"melt","summary":"Melt wallet.","order":310,"tags":["wallet","write","agent"],"doc":"skills/wallet.txt","security":{"moves_money":true,"requires_ownership":true,"requires_signature":false,"long_running":false}}
  router.post('/api/v1/wallet/melt', auth, rateLimit('wallet_write'), async (req, res) => {
    try {
      const { quote_id } = req.body;
      if (!quote_id) return err400MissingField(res, 'quote_id', {
        hint: 'Use the quote_id from POST /api/v1/wallet/melt-quote.',
      });

      const result = await daemon.agentCashuWallet.meltProofs(req.agentId, quote_id);
      const meltAmount = result.amount || 0;
      const meltFee = result.fee_reserve || 0;
      res.json({
        ...result,
        cost_summary: { action: 'melt', amount_sats: meltAmount, fee_sats: meltFee, total_sats: meltAmount + meltFee, unit: 'sat' },
      });
    } catch (err) {
      const isBal = err.message && err.message.includes('Insufficient');
      return agentError(res, 400, {
        error: 'validation_error',
        message: err.message,
        hint: isBal ? 'Check your balance at GET /api/v1/wallet/balance.' : 'Use the quote_id from POST /api/v1/wallet/melt-quote.',
        extra: { recovery: isBal
          ? buildRecovery('safe', 'No sats were deducted. Your balance is too low for this melt.', [
            'GET /api/v1/wallet/balance to check available sats',
            'Deposit more sats via POST /api/v1/wallet/mint-quote',
          ])
          : buildRecovery('pending', 'Proofs may have been swapped before the payment failed. They are saved on disk.', [
            'POST /api/v1/wallet/restore to recover any stuck proofs',
            'GET /api/v1/wallet/balance to verify your current balance',
          ]),
        },
      });
    }
  });

  // Send with wallet.
  // @agent-route {"auth":"agent","domain":"wallet","subgroup":"Spending","label":"send","summary":"Send with wallet.","order":320,"tags":["wallet","write","agent"],"doc":"skills/wallet.txt","security":{"moves_money":true,"requires_ownership":true,"requires_signature":false,"long_running":false}}
  router.post('/api/v1/wallet/send', auth, rateLimit('wallet_write'), async (req, res) => {
    try {
      const { amount_sats } = req.body;
      const parsed = parseInt(amount_sats, 10);
      const amtCheck = validateAmount(parsed, 1, 10_000_000);
      if (!amtCheck.valid) return err400Validation(res, amtCheck.reason);

      const result = await daemon.agentCashuWallet.sendEcash(req.agentId, parsed);
      res.json({
        ...result,
        cost_summary: { action: 'send', amount_sats: parsed, fee_sats: 0, total_sats: parsed, unit: 'sat' },
      });
    } catch (err) {
      const isBal = err.message && err.message.includes('Insufficient');
      return agentError(res, 400, {
        error: 'validation_error',
        message: err.message,
        hint: 'Check your balance at GET /api/v1/wallet/balance.',
        see: 'GET /api/v1/wallet/balance',
        extra: { recovery: isBal
          ? buildRecovery('safe', 'No sats were deducted. Your balance is too low for this send.', [
            'GET /api/v1/wallet/balance to check available sats',
            'Deposit more sats via POST /api/v1/wallet/mint-quote',
          ])
          : buildRecovery('pending', 'A proof swap may have started. Proofs are saved on disk for recovery.', [
            'POST /api/v1/wallet/restore to recover any stuck proofs',
            'GET /api/v1/wallet/balance to verify your current balance',
            'POST /api/v1/wallet/reclaim-pending to reclaim unclaimed sent tokens',
          ]),
        },
      });
    }
  });

  // Receive with wallet.
  // @agent-route {"auth":"agent","domain":"wallet","subgroup":"Spending","label":"receive","summary":"Receive with wallet.","order":330,"tags":["wallet","write","agent"],"doc":"skills/wallet.txt","security":{"moves_money":true,"requires_ownership":true,"requires_signature":false,"long_running":false}}
  router.post('/api/v1/wallet/receive', auth, rateLimit('wallet_write'), async (req, res) => {
    try {
      const { token } = req.body;
      if (!token || typeof token !== 'string') {
        return err400MissingField(res, 'token', {
          hint: 'Provide a Cashu ecash token string (from POST /api/v1/wallet/send).',
        });
      }

      const result = await daemon.agentCashuWallet.receiveEcash(req.agentId, token);
      res.json({
        ...result,
        cost_summary: { action: 'receive', amount_sats: result.amount, fee_sats: 0, total_sats: result.amount, unit: 'sat' },
      });
    } catch (err) {
      return agentError(res, 400, {
        error: 'validation_error',
        message: err.message,
        extra: { recovery: buildRecovery('safe', 'Your existing wallet balance is unchanged. The token was not redeemed.', [
          'Verify the token is a valid Cashu ecash string and retry POST /api/v1/wallet/receive',
          'The token may have already been claimed by another agent',
        ]) },
      });
    }
  });

  // Read wallet balance.
  // @agent-route {"auth":"agent","domain":"wallet","subgroup":"Balance","label":"balance","summary":"Read wallet balance.","order":200,"tags":["wallet","read","agent"],"doc":"skills/wallet.txt","security":{"moves_money":false,"requires_ownership":true,"requires_signature":false,"long_running":false}}
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

  // Read wallet history.
  // @agent-route {"auth":"agent","domain":"wallet","subgroup":"Balance","label":"history","summary":"Read wallet history.","order":210,"tags":["wallet","read","agent"],"doc":"skills/wallet.txt","security":{"moves_money":false,"requires_ownership":true,"requires_signature":false,"long_running":false}}
  router.get('/api/v1/wallet/history', auth, rateLimit('wallet_read'), async (req, res) => {
    try {
      const history = await daemon.publicLedger.getAgentTransactions(req.agentId);
      res.json({ transactions: history });
    } catch (err) {
      return err500Internal(res, 'fetching wallet history');
    }
  });

  // --- Seed recovery: restore proofs from deterministic seed ---

  // Restore wallet.
  // @agent-route {"auth":"agent","domain":"wallet","subgroup":"Recovery","label":"restore","summary":"Restore wallet.","order":400,"tags":["wallet","write","agent"],"doc":"skills/wallet.txt","security":{"moves_money":true,"requires_ownership":true,"requires_signature":false,"long_running":false}}
  router.post('/api/v1/wallet/restore', auth, rateLimit('wallet_write'), async (req, res) => {
    try {
      const result = await daemon.agentCashuWallet.restoreFromSeed(req.agentId);
      res.json({
        agent_id: req.agentId,
        recovered_proofs: result.recovered,
        balance_sats: result.balance,
        restore_supported: result.restoreSupported !== false,
      });
    } catch (err) {
      return agentError(res, 500, {
        error: 'internal_error',
        message: 'Something went wrong while restoring wallet from seed.',
        retryable: true,
        hint: 'Wait a few seconds and retry. Your deterministic seed is safe — restoration can always be retried.',
        see: 'GET /api/v1/wallet/balance',
        extra: { recovery: buildRecovery('safe', 'Your seed and any existing proofs are safe. Restoration can be retried.', [
          'Wait a few seconds and retry POST /api/v1/wallet/restore',
          'GET /api/v1/wallet/balance to check your current balance',
        ]) },
      });
    }
  });

  // --- Pending send reclaim: recover unclaimed sent tokens ---

  // Reclaim wallet reclaim pending.
  // @agent-route {"auth":"agent","domain":"wallet","subgroup":"Recovery","label":"reclaim-pending","summary":"Reclaim wallet reclaim pending.","order":410,"tags":["wallet","write","agent"],"doc":"skills/wallet.txt","security":{"moves_money":true,"requires_ownership":true,"requires_signature":false,"long_running":false}}
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
      return agentError(res, 500, {
        error: 'internal_error',
        message: 'Something went wrong while reclaiming pending sends.',
        retryable: true,
        hint: 'Wait a few seconds and retry. Pending tokens are still tracked and can be reclaimed later.',
        see: 'GET /api/v1/wallet/balance',
        extra: { recovery: buildRecovery('safe', 'Pending tokens are still tracked. No funds were lost — reclaim can be retried.', [
          'Wait a few seconds and retry POST /api/v1/wallet/reclaim-pending',
          'GET /api/v1/wallet/balance to check your current balance',
        ]) },
      });
    }
  });

  // Read ledger.
  // @agent-route {"auth":"public","domain":"wallet","subgroup":"Ledger","label":"ledger","summary":"Read ledger.","order":500,"tags":["wallet","read","public"],"doc":"skills/wallet.txt","security":{"moves_money":false,"requires_ownership":false,"requires_signature":false,"long_running":false}}
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
