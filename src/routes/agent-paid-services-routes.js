/**
 * Agent Paid Services Routes — /api/v1/analytics/, /api/v1/capital/, /api/v1/help
 *
 * Paid analytics gateway, capital ledger, help concierge.
 */

import { Router } from 'express';
import { requireAuth } from '../identity/auth.js';
import { rateLimit } from '../identity/rate-limiter.js';
import { err503Service, err400MissingField, err400Validation, err500Internal, agentError } from '../identity/agent-friendly-errors.js';

export function agentPaidServicesRoutes(daemon) {
  const router = Router();
  const auth = requireAuth(daemon.agentRegistry);

  // =========================================================================
  // PAID ANALYTICS API (Plan K)
  // =========================================================================

  // --- Public: query catalog ---
  router.get('/api/v1/analytics/catalog', rateLimit('discovery'), (_req, res) => {
    try {
      if (!daemon.analyticsGateway) {
        return err503Service(res, 'Analytics');
      }
      const catalog = daemon.analyticsGateway.getCatalog();
      res.json(catalog);
    } catch (err) {
      console.error(`[Gateway] ${_req.path}: ${err.message}`);
      return err500Internal(res, 'loading analytics catalog');
    }
  });

  // --- Authenticated: get price quote ---
  router.post('/api/v1/analytics/quote', auth, rateLimit('analytics_query'), async (req, res) => {
    try {
      if (!daemon.analyticsGateway) {
        return err503Service(res, 'Analytics');
      }
      const { query_id, params } = req.body;
      if (!query_id) {
        return err400MissingField(res, 'query_id', {
          hint: 'Get available query IDs from GET /api/v1/analytics/catalog.',
          see: 'GET /api/v1/analytics/catalog',
        });
      }
      const quote = daemon.analyticsGateway.getQuote(query_id, params || {});
      res.json(quote);
    } catch (err) {
      const status = err.statusCode || 500;
      if (status >= 500) return err500Internal(res, 'generating analytics quote');
      return agentError(res, status, {
        error: 'analytics_error',
        message: err.message,
        hint: 'Check GET /api/v1/analytics/catalog for valid query IDs and required params.',
        see: 'GET /api/v1/analytics/catalog',
        extra: err.validation_errors ? { validation_errors: err.validation_errors } : undefined,
      });
    }
  });

  // --- Authenticated: execute paid query ---
  router.post('/api/v1/analytics/execute', auth, rateLimit('analytics_query'), async (req, res) => {
    try {
      if (!daemon.analyticsGateway) {
        return err503Service(res, 'Analytics');
      }
      const { query_id, params } = req.body;
      if (!query_id) {
        return err400MissingField(res, 'query_id', {
          hint: 'Get available query IDs from GET /api/v1/analytics/catalog.',
          see: 'GET /api/v1/analytics/catalog',
        });
      }
      const result = await daemon.analyticsGateway.execute(req.agentId, query_id, params || {});
      res.json(result);
    } catch (err) {
      const status = err.statusCode || 500;
      if (status >= 500) return err500Internal(res, 'executing analytics query');
      const extra = {};
      if (err.refunded !== undefined) extra.refunded = err.refunded;
      if (err.validation_errors) extra.validation_errors = err.validation_errors;
      return agentError(res, status, {
        error: 'analytics_error',
        message: err.message,
        hint: 'Check GET /api/v1/analytics/catalog for valid query IDs and required params.',
        see: 'GET /api/v1/analytics/catalog',
        extra: Object.keys(extra).length ? extra : undefined,
      });
    }
  });

  // --- Authenticated: query history ---
  router.get('/api/v1/analytics/history', auth, rateLimit('analytics_query'), async (req, res) => {
    try {
      if (!daemon.analyticsGateway) {
        return err503Service(res, 'Analytics');
      }
      const { limit, since } = req.query;
      const result = await daemon.analyticsGateway.getHistory(req.agentId, {
        limit: limit ? parseInt(limit, 10) : undefined,
        since: since ? parseInt(since, 10) : undefined,
      });
      res.json(result);
    } catch (err) {
      console.error(`[Gateway] ${req.path}: ${err.message}`);
      return err500Internal(res, 'fetching analytics history');
    }
  });

  // =========================================================================
  // CAPITAL LEDGER (Plan B)
  // =========================================================================

  router.get('/api/v1/capital/balance', auth, rateLimit('capital_read'), async (req, res) => {
    try {
      if (!daemon.capitalLedger) {
        return err503Service(res, 'Capital ledger');
      }
      const balance = await daemon.capitalLedger.getBalance(req.agentId);
      res.json({
        agent_id: req.agentId,
        balance,
        learn: {
          what: 'Your capital balance across all bucket types.',
          buckets: {
            available: 'Sats you can use to open channels or withdraw.',
            locked: 'Sats committed to open channels. Returns to available when the channel closes.',
            pending_deposit: 'Deposit detected on-chain but not yet confirmed.',
            pending_close: 'Channel closing — funds return to available after on-chain confirmation.',
          },
          invariant: 'total_deposited + total_revenue_credited = available + locked + pending_deposit + pending_close + total_withdrawn + total_routing_pnl',
          flow: 'deposit → pending_deposit → available → locked → pending_close → available → withdraw',
        },
      });
    } catch (err) {
      console.error(`[Gateway] ${req.path}: ${err.message}`);
      return err500Internal(res, 'fetching capital balance');
    }
  });

  router.get('/api/v1/capital/activity', auth, rateLimit('capital_read'), async (req, res) => {
    try {
      if (!daemon.capitalLedger) {
        return err503Service(res, 'Capital ledger');
      }
      const limit = Math.min(Math.max(1, parseInt(req.query.limit, 10) || 50), 500);
      const offset = Math.max(0, parseInt(req.query.offset, 10) || 0);
      const { entries, total } = await daemon.capitalLedger.readActivity({
        agentId: req.agentId,
        limit,
        offset,
      });
      res.json({
        agent_id: req.agentId,
        entries,
        total,
        limit,
        offset,
        learn: 'Complete history of capital movements on your account. Newest first. Use ?limit=N&offset=M to paginate.',
      });
    } catch (err) {
      console.error(`[Gateway] ${req.path}: ${err.message}`);
      return err500Internal(res, 'fetching capital activity');
    }
  });

  router.post('/api/v1/capital/withdraw', auth, rateLimit('capital_write'), async (req, res) => {
    try {
      if (!daemon.capitalLedger) {
        return err503Service(res, 'Capital ledger');
      }
      const { amount_sats, destination_address } = req.body || {};
      if (!amount_sats || !Number.isInteger(amount_sats) || amount_sats <= 0) {
        return err400Validation(res, 'amount_sats must be a positive integer.', {
          hint: 'Specify exact satoshis to withdraw. 1 BTC = 100,000,000 sats.',
        });
      }
      if (!destination_address || typeof destination_address !== 'string' || destination_address.length < 20) {
        return err400Validation(res, 'destination_address must be a valid Bitcoin address.', {
          hint: 'Provide a Bitcoin on-chain address (bech32 bc1..., P2SH 3..., or legacy 1...).',
        });
      }
      const balance = await daemon.capitalLedger.withdraw(req.agentId, amount_sats, destination_address);
      res.json({
        agent_id: req.agentId,
        withdrawn_sats: amount_sats,
        destination_address,
        balance_after: balance,
        learn: 'Withdrawal recorded. Only available sats can be withdrawn. Locked sats require closing the channel first.',
      });
    } catch (err) {
      if (err.message.includes('Insufficient')) {
        return agentError(res, 409, {
          error: 'insufficient_balance',
          message: err.message,
          hint: 'Check your balance at GET /api/v1/capital/balance. Only available sats can be withdrawn — locked sats require closing the channel first.',
          see: 'GET /api/v1/capital/balance',
        });
      }
      console.error(`[Gateway] ${req.path}: ${err.message}`);
      return err500Internal(res, 'processing withdrawal');
    }
  });

  // =========================================================================
  // DEPOSIT SYSTEM (Plan C)
  // =========================================================================

  router.post('/api/v1/capital/deposit', auth, rateLimit('capital_write'), async (req, res) => {
    try {
      if (!daemon.depositTracker) {
        return err503Service(res, 'Deposit tracker');
      }
      const { address } = await daemon.depositTracker.generateAddress(req.agentId);
      res.json({
        agent_id: req.agentId,
        address,
        minimum_deposit_sats: 546,
        confirmations_required: daemon.depositTracker._confirmationsRequired,
        instructions: 'Send Bitcoin to this Taproot address. Deposits are detected automatically and credited after confirmations.',
        learn: {
          what: 'A fresh Taproot (bc1p...) address for depositing Bitcoin to fund channel operations.',
          flow: 'Send sats → detected in ~30s → pending_deposit → confirmed after 3 blocks → available for channel opens.',
          dust: 'Deposits below 10,000 sats are credited but not economical to return on-chain.',
          reuse: 'Each address is single-use. Call this endpoint again for a fresh address for each deposit.',
        },
      });
    } catch (err) {
      console.error(`[Gateway] ${req.path}: ${err.message}`);
      return err500Internal(res, 'generating deposit address');
    }
  });

  router.get('/api/v1/capital/deposits', auth, rateLimit('capital_read'), async (req, res) => {
    try {
      if (!daemon.depositTracker) {
        return err503Service(res, 'Deposit tracker');
      }
      const { deposits } = daemon.depositTracker.getDepositStatus(req.agentId);
      res.json({
        agent_id: req.agentId,
        deposits,
        learn: {
          statuses: {
            watching: 'Address generated, waiting for incoming transaction.',
            pending_deposit: 'Transaction detected, waiting for confirmations.',
            confirmed: 'Deposit confirmed and credited to your available balance.',
          },
        },
      });
    } catch (err) {
      console.error(`[Gateway] ${req.path}: ${err.message}`);
      return err500Internal(res, 'checking deposit status');
    }
  });

  // =========================================================================
  // HELP (Concierge) — LLM-powered agent assistant (Plan L)
  // =========================================================================

  router.post('/api/v1/help', auth, rateLimit('wallet_write'), async (req, res) => {
    if (!daemon.helpEndpoint) {
      return agentError(res, 503, {
        error: 'service_unavailable',
        message: 'Help service is temporarily unavailable.',
        retryable: true,
        retry_after_seconds: 30,
        hint: 'Self-serve alternatives: GET /llms-full.txt (full guide) or GET /api/v1/knowledge/index (knowledge base table of contents).',
        see: 'GET /api/v1/knowledge/index',
      });
    }
    try {
      const { question, context } = req.body;
      const result = await daemon.helpEndpoint.ask(req.agentId, question, context || {});
      res.json(result);
    } catch (err) {
      const status = err.status || 500;
      if (status >= 500) return err500Internal(res, 'processing help request');
      return agentError(res, status, {
        error: 'help_error',
        message: err.message,
        retryable: !!err.retryAfter,
        retry_after_seconds: err.retryAfter,
        hint: 'Try GET /api/v1/knowledge/index for self-serve answers.',
        extra: err.refunded ? { refunded: true } : undefined,
      });
    }
  });

  return router;
}
