/**
 * Agent Paid Services Routes — /api/v1/analytics/, /api/v1/capital/, /api/v1/help
 *
 * Paid analytics gateway, capital ledger, help concierge.
 */

import { Router } from 'express';
import { requireAuth } from '../identity/auth.js';
import { checkAndIncrement, rateLimit } from '../identity/rate-limiter.js';
import { IdempotencyStore } from '../identity/idempotency-store.js';
import { runIdempotentRoute } from '../identity/idempotency-route.js';
import { err503Service, err400MissingField, err400Validation, err500Internal, agentError, buildRecovery, withRecovery } from '../identity/agent-friendly-errors.js';
import { DangerRoutePolicyStore, findUnexpectedKeys } from '../identity/danger-route-policy.js';
import { getDangerRouteSettings } from '../identity/danger-route-settings.js';

function depositExplorerLinks(address) {
  return {
    watch_url: `https://mempool.space/address/${address}`,
    explorers: {
      mempool: `https://mempool.space/address/${address}`,
      blockstream: `https://blockstream.info/address/${address}`,
    },
  };
}

function sendUnexpectedKeys(res, unexpected, see) {
  return err400Validation(res, `Unexpected field(s): ${unexpected.join(', ')}`, {
    hint: 'Send only the documented JSON keys for this route.',
    see,
  });
}

function buildCooldownError(message, hint) {
  return {
    error: 'cooldown_active',
    message,
    retryable: true,
    hint,
  };
}

function isMissingNodeConnectionError(err) {
  const message = String(err?.message || '');
  return message.includes('No LND node available') || message.includes('No LND node connected');
}

export function agentPaidServicesRoutes(daemon) {
  const router = Router();
  const auth = requireAuth(daemon.agentRegistry);
  const idempotencyStore = daemon.dataLayer ? new IdempotencyStore({ dataLayer: daemon.dataLayer }) : null;
  const dangerPolicy = new DangerRoutePolicyStore({ dataLayer: daemon.dataLayer });
  const safety = getDangerRouteSettings(daemon.config);

  // =========================================================================
  // PAID ANALYTICS API (Plan K)
  // =========================================================================

  // --- Public: query catalog ---
  // Read analytics catalog.
  // @agent-route {"auth":"public","domain":"analytics","subgroup":"Analytics","label":"catalog","summary":"Read analytics catalog.","order":100,"tags":["analytics","read","public"],"doc":["skills/analytics-catalog-and-quote.txt","skills/analytics.txt"],"security":{"moves_money":false,"requires_ownership":false,"requires_signature":false,"long_running":false}}
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
  // Create analytics.
  // @agent-route {"auth":"agent","domain":"analytics","subgroup":"Analytics","label":"quote","summary":"Create analytics.","order":110,"tags":["analytics","write","agent"],"doc":["skills/analytics-catalog-and-quote.txt","skills/analytics-execute-and-history.txt","skills/analytics.txt"],"security":{"moves_money":false,"requires_ownership":true,"requires_signature":false,"long_running":false}}
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
  // Execute analytics.
  // @agent-route {"auth":"agent","domain":"analytics","subgroup":"Analytics","label":"execute","summary":"Execute analytics.","order":120,"tags":["analytics","write","agent"],"doc":["skills/analytics-execute-and-history.txt","skills/analytics.txt"],"security":{"moves_money":true,"requires_ownership":true,"requires_signature":false,"long_running":true}}
  router.post('/api/v1/analytics/execute', auth, rateLimit('analytics_query'), async (req, res) => {
    if (!daemon.analyticsGateway) {
      return err503Service(res, 'Analytics');
    }
    return runIdempotentRoute({
      req,
      res,
      store: idempotencyStore,
      scope: 'analytics:execute',
      handler: async () => {
        const { query_id, params } = req.body;
        if (!query_id) {
          return {
            statusCode: 400,
            body: {
              error: 'missing_field',
              field: 'query_id',
              message: 'Missing required field: query_id',
              hint: 'Get available query IDs from GET /api/v1/analytics/catalog.',
              see: 'GET /api/v1/analytics/catalog',
            },
          };
        }
        const result = await daemon.analyticsGateway.execute(req.agentId, query_id, params || {});
        return {
          statusCode: 200,
          body: {
            ...result,
            cost_summary: {
              action: 'analytics_execute',
              amount_sats: result.price_sats,
              fee_sats: 0,
              total_sats: result.price_sats,
              unit: 'sat',
              source: result.payment_source || 'wallet',
            },
          },
        };
      },
      onError: (err) => {
        const status = err.statusCode || 500;
        if (status >= 500) {
          console.error(`[Gateway] ${req.path}: ${err.message}`);
          return {
            statusCode: 500,
            body: withRecovery(
              { error: 'internal_error', message: 'Internal error while executing analytics query.' },
              'safe', 'Idempotent operation — you will not be double-charged. Retry safely.', [
                'Retry the same POST /api/v1/analytics/execute request',
                'GET /api/v1/analytics/history to check if the query already completed',
              ],
            ),
          };
        }
        const extra = {};
        if (err.refunded !== undefined) extra.refunded = err.refunded;
        if (err.validation_errors) extra.validation_errors = err.validation_errors;
        return {
          statusCode: status,
          body: withRecovery(
            {
              error: 'analytics_error',
              message: err.message,
              hint: 'Check GET /api/v1/analytics/catalog for valid query IDs and required params.',
              see: 'GET /api/v1/analytics/catalog',
              ...(Object.keys(extra).length ? extra : {}),
            },
            err.refunded ? 'safe' : 'safe',
            err.refunded ? 'Payment was refunded. No sats were deducted.' : 'No sats were deducted for a failed query.',
            ['Check GET /api/v1/analytics/catalog for valid query IDs and params', 'Retry with corrected parameters'],
          ),
        };
      },
    });
  });

  // --- Authenticated: query history ---
  // Read analytics history.
  // @agent-route {"auth":"agent","domain":"analytics","subgroup":"Analytics","label":"history","summary":"Read analytics history.","order":130,"tags":["analytics","read","agent"],"doc":["skills/analytics-execute-and-history.txt","skills/analytics.txt"],"security":{"moves_money":false,"requires_ownership":true,"requires_signature":false,"long_running":false}}
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

  // Read capital balance.
  // @agent-route {"auth":"agent","domain":"capital","subgroup":"Capital","label":"balance","summary":"Read capital balance.","order":100,"tags":["capital","read","agent"],"doc":["skills/capital-balance-and-activity.txt","skills/capital.txt"],"security":{"moves_money":false,"requires_ownership":true,"requires_signature":false,"long_running":false}}
  router.get('/api/v1/capital/balance', auth, rateLimit('capital_read'), async (req, res) => {
    try {
      if (!daemon.capitalLedger) {
        return err503Service(res, 'Capital ledger');
      }
      await daemon.channelCloser?.refreshNow?.();
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
            total_service_spent: 'Lifetime sats spent from capital on paid site services.',
          },
          invariant: 'total_deposited + total_revenue_credited + total_ecash_funded = available + locked + pending_deposit + pending_close + total_withdrawn + total_service_spent + total_routing_pnl',
          flow: 'deposit → pending_deposit → available → locked → pending_close → available → withdraw',
        },
      });
    } catch (err) {
      console.error(`[Gateway] ${req.path}: ${err.message}`);
      return err500Internal(res, 'fetching capital balance');
    }
  });

  // Read capital activity.
  // @agent-route {"auth":"agent","domain":"capital","subgroup":"Capital","label":"activity","summary":"Read capital activity.","order":110,"tags":["capital","read","agent"],"doc":["skills/capital-balance-and-activity.txt","skills/capital.txt"],"security":{"moves_money":false,"requires_ownership":true,"requires_signature":false,"long_running":false}}
  router.get('/api/v1/capital/activity', auth, rateLimit('capital_read'), async (req, res) => {
    try {
      if (!daemon.capitalLedger) {
        return err503Service(res, 'Capital ledger');
      }
      await daemon.channelCloser?.refreshNow?.();
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

  // Withdraw from capital.
  // @agent-route {"auth":"agent","domain":"capital","subgroup":"Capital","label":"withdraw","summary":"Withdraw from capital.","order":120,"tags":["capital","write","agent"],"doc":["skills/capital-withdraw-and-help.txt","skills/capital.txt"],"security":{"moves_money":true,"requires_ownership":true,"requires_signature":false,"long_running":true}}
  router.post('/api/v1/capital/withdraw', auth, rateLimit('capital_write'), async (req, res) => {
    const unexpected = findUnexpectedKeys(req.body, ['amount_sats', 'destination_address', 'idempotency_key']);
    if (unexpected.length > 0) {
      return sendUnexpectedKeys(res, unexpected, 'GET /api/v1/capital/balance');
    }
    return agentError(res, 503, {
      error: 'capital_withdrawals_disabled',
      message: 'Capital withdrawals are not live yet.',
      hint: 'This route is back in the public surface, but it still needs a real on-chain sender before it can safely move funds.',
      see: 'GET /api/v1/capital/balance',
    });
  });

  // =========================================================================
  // DEPOSIT SYSTEM (Plan C)
  // =========================================================================

  // Deposit to capital.
  // @agent-route {"auth":"agent","domain":"capital","subgroup":"Capital","label":"deposit","summary":"Deposit to capital.","order":130,"tags":["capital","write","agent"],"doc":["skills/capital-deposit-and-status.txt","skills/capital.txt"],"security":{"moves_money":false,"requires_ownership":true,"requires_signature":false,"long_running":false}}
  router.post('/api/v1/capital/deposit', auth, rateLimit('capital_write'), async (req, res) => {
    if (!daemon.depositTracker) {
      return err503Service(res, 'Deposit tracker');
    }
    return runIdempotentRoute({
      req,
      res,
      store: idempotencyStore,
      scope: 'capital:deposit',
      handler: async () => {
        const { address } = await daemon.depositTracker.generateAddress(req.agentId);
        const explorerLinks = depositExplorerLinks(address);
        return {
          statusCode: 200,
          body: {
            agent_id: req.agentId,
            address,
            ...explorerLinks,
            minimum_deposit_sats: 546,
            confirmations_required: daemon.depositTracker._confirmationsRequired,
            instructions: 'Send Bitcoin to this Taproot address. Deposits are detected automatically and credited after confirmations.',
            learn: {
              what: 'A fresh Taproot (bc1p...) address for depositing Bitcoin to fund channel operations.',
              flow: 'Send sats → detected in ~30s → pending_deposit → confirmed after 3 blocks → available for channel opens.',
              watch: 'Use watch_url to follow the deposit on a public explorer and share the same link with a human if needed.',
              dust: 'Deposits below 10,000 sats are credited but not economical to return on-chain.',
              reuse: 'Each address is single-use. Call this endpoint again for a fresh address for each deposit.',
            },
            cost_summary: { action: 'deposit', amount_sats: 0, fee_sats: 0, total_sats: 0, unit: 'sat' },
          },
        };
      },
      onError: (err) => {
        console.error(`[Gateway] ${req.path}: ${err.message}`);
        if (isMissingNodeConnectionError(err)) {
          return {
            statusCode: 503,
            body: withRecovery(
              {
                error: 'service_unavailable',
                message: 'Deposit address generation is unavailable because no wallet node is connected.',
              },
              'safe', 'No deposit address was generated. No funds are at risk.', [
                'Connect a wallet-capable node and retry POST /api/v1/capital/deposit',
              ],
            ),
          };
        }
        return {
          statusCode: 500,
          body: withRecovery(
            { error: 'internal_error', message: 'Internal error while generating deposit address.' },
            'safe', 'No deposit address was generated. No funds are at risk.', [
              'Wait a few seconds and retry POST /api/v1/capital/deposit',
            ],
          ),
        };
      },
    });
  });

  // Read capital deposits.
  // @agent-route {"auth":"agent","domain":"capital","subgroup":"Capital","label":"deposits","summary":"Read capital deposits.","order":140,"tags":["capital","read","agent"],"doc":["skills/capital-deposit-and-status.txt","skills/capital.txt"],"security":{"moves_money":false,"requires_ownership":true,"requires_signature":false,"long_running":false}}
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

  // Request help for help.
  // @agent-route {"auth":"agent","domain":"capital","subgroup":"Help","label":"help","summary":"Request help for help.","order":200,"tags":["capital","write","agent"],"doc":["skills/capital-withdraw-and-help.txt","skills/capital.txt"],"security":{"moves_money":true,"requires_ownership":true,"requires_signature":false,"long_running":true}}
  router.post('/api/v1/help', auth, rateLimit('wallet_write'), async (req, res) => {
    const unexpected = findUnexpectedKeys(req.body, ['question', 'context', 'idempotency_key']);
    if (unexpected.length > 0) {
      return sendUnexpectedKeys(res, unexpected, 'GET /docs/skills/capital.txt');
    }
    if (!daemon.helpEndpoint) {
      return agentError(res, 503, {
        error: 'service_unavailable',
        message: 'Help service is temporarily unavailable.',
        retryable: true,
        hint: 'Self-serve alternatives: GET /llms.txt or GET /api/v1/knowledge/onboarding.',
        see: 'GET /api/v1/knowledge/onboarding',
      });
    }
    return runIdempotentRoute({
      req,
      res,
      store: idempotencyStore,
      scope: 'help:ask',
      handler: async () => {
        const { question, context } = req.body;
        const result = await daemon.helpEndpoint.ask(req.agentId, question, context || {});
        return {
          statusCode: 200,
          body: {
            ...result,
            cost_summary: {
              action: 'help',
              amount_sats: result.cost_sats,
              fee_sats: 0,
              total_sats: result.cost_sats,
              unit: 'sat',
              source: result.payment_source || 'wallet',
            },
          },
        };
      },
      onError: (err) => {
        const status = err.status || 500;
        if (status >= 500) {
          console.error(`[Gateway] ${req.path}: ${err.message}`);
          return {
            statusCode: 500,
            body: {
              error: 'internal_error',
              message: 'Internal error while processing help request.',
              hint: 'Try GET /llms.txt or GET /api/v1/knowledge/onboarding for self-serve answers.',
            },
          };
        }
        return {
          statusCode: status,
          body: {
            error: 'help_error',
            message: err.message,
            retryable: !!err.retryAfter,
            hint: 'Try GET /llms.txt or GET /api/v1/knowledge/onboarding for self-serve answers.',
            ...(err.refunded ? { refunded: true } : {}),
          },
        };
      },
    });
  });

  return router;
}
