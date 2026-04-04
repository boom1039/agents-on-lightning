/**
 * Agent Paid Services Routes — /api/v1/analytics/, /api/v1/capital/, /api/v1/help
 *
 * Paid analytics gateway, capital ledger, help concierge.
 */

import { Router } from 'express';
import { requireAuth } from '../identity/auth.js';
import { checkAndIncrement, rateLimit } from '../identity/rate-limiter.js';
import { validateBitcoinAddress } from '../identity/validators.js';
import { IdempotencyStore } from '../identity/idempotency-store.js';
import { runIdempotentRoute } from '../identity/idempotency-route.js';
import { err503Service, err400MissingField, err400Validation, err500Internal, agentError, buildRecovery, withRecovery } from '../identity/agent-friendly-errors.js';
import { DangerRoutePolicyStore, findUnexpectedKeys } from '../identity/danger-route-policy.js';

function capitalWithdrawalsEnabled() {
  return process.env.ENABLE_CAPITAL_WITHDRAWALS === '1';
}

const HOUR_MS = 60 * 60 * 1000;
const FIFTEEN_MIN_MS = 15 * 60 * 1000;
const WITHDRAW_CAPS = {
  autoApproveSats: 100_000,
  hardCapSats: 250_000,
  dailyAutoApproveSats: 250_000,
  dailyHardCapSats: 500_000,
  sharedDailyAutoApproveSats: 500_000,
  sharedDailyHardCapSats: 1_000_000,
};

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

export function agentPaidServicesRoutes(daemon) {
  const router = Router();
  const auth = requireAuth(daemon.agentRegistry);
  const idempotencyStore = daemon.dataLayer ? new IdempotencyStore({ dataLayer: daemon.dataLayer }) : null;
  const dangerPolicy = new DangerRoutePolicyStore({ dataLayer: daemon.dataLayer });

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
            cost_summary: { action: 'analytics_execute', amount_sats: result.price_sats, fee_sats: 0, total_sats: result.price_sats, unit: 'sat' },
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
    const unexpected = findUnexpectedKeys(req.body, ['amount_sats', 'destination_address', 'idempotency_key']);
    if (unexpected.length > 0) {
      return sendUnexpectedKeys(res, unexpected, 'GET /api/v1/capital/balance');
    }
    if (!capitalWithdrawalsEnabled()) {
      return agentError(res, 503, {
        error: 'capital_withdrawals_disabled',
        message: 'Capital withdrawals are disabled until a real on-chain send path is enabled.',
        hint: 'This route is intentionally off for safety. Do not rely on it to move funds yet.',
        extra: { recovery: buildRecovery('safe', 'No funds were moved. Withdrawals are disabled platform-wide.', [
          'Use capital for channel opens instead: POST /api/v1/market/open',
          'GET /api/v1/capital/balance to check your available sats',
        ]) },
      });
    }
    return agentError(res, 503, {
      error: 'capital_withdrawals_unimplemented',
      message: 'Capital withdrawals stay off until a real on-chain sender is fully wired in.',
      hint: 'Keep this route disabled for now. Use capital for channel opens, or close a channel to free funds first.',
      extra: { recovery: buildRecovery('safe', 'No funds were moved. Withdrawals are not yet implemented.', [
        'Use capital for channel opens instead: POST /api/v1/market/open',
        'GET /api/v1/capital/balance to check your available sats',
      ]) },
    });
    if (!daemon.capitalLedger) {
      return err503Service(res, 'Capital ledger');
    }
    return runIdempotentRoute({
      req,
      res,
      store: idempotencyStore,
      scope: 'capital:withdraw',
      handler: async () => {
        const { amount_sats, destination_address } = req.body || {};
        if (!amount_sats || !Number.isInteger(amount_sats) || amount_sats <= 0) {
          return {
            statusCode: 400,
            body: withRecovery(
              {
                error: 'validation_error',
                message: 'amount_sats must be a positive integer.',
                hint: 'Specify exact satoshis to withdraw. 1 BTC = 100,000,000 sats.',
              },
              'safe', 'No funds were moved. Validation failed before any withdrawal.', [
                'Fix amount_sats and retry POST /api/v1/capital/withdraw',
                'GET /api/v1/capital/balance to check available sats',
              ],
            ),
          };
        }
        const addressCheck = validateBitcoinAddress(destination_address);
        if (!addressCheck.valid) {
          return {
            statusCode: 400,
            body: withRecovery(
              {
                error: 'validation_error',
                message: `destination_address: ${addressCheck.reason}`,
                hint: 'Provide a Bitcoin on-chain address (bech32 bc1..., P2SH 3..., or legacy 1...).',
              },
              'safe', 'No funds were moved. The address was rejected before any withdrawal.', [
                'Provide a valid Bitcoin address and retry POST /api/v1/capital/withdraw',
              ],
            ),
          };
        }

        const attempts = await checkAndIncrement(`danger:capital_withdraw:attempt:${req.agentId}`, 3, HOUR_MS);
        if (!attempts.allowed) {
          return {
            statusCode: 429,
            body: withRecovery(
              {
                error: 'cooldown_active',
                message: 'Too many withdrawal attempts this hour.',
                retryable: true,
                retry_after_seconds: attempts.retryAfter,
                hint: 'Wait before trying another withdrawal.',
              },
              'safe', 'No funds were moved. You hit a rate limit.', [
                `Wait ${attempts.retryAfter} seconds and retry POST /api/v1/capital/withdraw`,
              ],
            ),
          };
        }

        const cooldown = await dangerPolicy.checkCooldown({
          scope: 'capital_withdraw',
          agentId: req.agentId,
          cooldownMs: FIFTEEN_MIN_MS,
        });
        if (!cooldown.allowed) {
          return {
            statusCode: 429,
            body: withRecovery(
              {
                error: 'cooldown_active',
                message: 'A recent withdrawal is still cooling down.',
                retryable: true,
                retry_after_seconds: cooldown.retryAfterSeconds,
                hint: 'Wait for the cooldown window to pass before sending another withdrawal.',
              },
              'safe', 'No funds were moved. A cooldown is active from a recent withdrawal.', [
                `Wait ${cooldown.retryAfterSeconds} seconds and retry POST /api/v1/capital/withdraw`,
              ],
            ),
          };
        }

        const decision = await dangerPolicy.assessAmount({
          scope: 'capital_withdraw',
          agentId: req.agentId,
          amountSats: amount_sats,
          ...WITHDRAW_CAPS,
        });
        const sharedReason = typeof decision.decisionReason === 'string' && decision.decisionReason.startsWith('shared_');
        const rolling24h = sharedReason ? decision.sharedTotal24h : decision.total24h;
        const rollingLimit = sharedReason
          ? (decision.decision === 'hard_cap' ? WITHDRAW_CAPS.sharedDailyHardCapSats : WITHDRAW_CAPS.sharedDailyAutoApproveSats)
          : (decision.decision === 'hard_cap' ? WITHDRAW_CAPS.dailyHardCapSats : WITHDRAW_CAPS.dailyAutoApproveSats);
        if (decision.decision === 'hard_cap') {
          return {
            statusCode: 403,
            body: withRecovery(
              {
                error: 'cap_exceeded',
                message: sharedReason ? 'This withdrawal is above the shared-node safety cap.' : 'This withdrawal is above the safety cap.',
                hint: sharedReason ? 'Use a smaller withdrawal amount, or wait for the shared-node budget window to reset.' : 'Use a smaller withdrawal amount.',
                requested_sats: amount_sats,
                instant_limit_sats: WITHDRAW_CAPS.autoApproveSats,
                rolling_24h_sats: rolling24h,
                rolling_24h_limit_sats: rollingLimit,
              },
              'safe', 'No funds were moved. The amount exceeds the safety cap.', [
                'Reduce amount_sats and retry POST /api/v1/capital/withdraw',
                'GET /api/v1/capital/balance to check available sats',
              ],
            ),
          };
        }
        if (decision.decision === 'review_required') {
          return {
            statusCode: 202,
            body: withRecovery(
              {
                review_required: true,
                message: sharedReason ? 'This withdrawal is above the shared-node instant-approve limit.' : 'This withdrawal is above the instant-approve limit.',
                hint: sharedReason ? 'Use a smaller withdrawal, or wait for the shared-node budget window to reset.' : 'Use a smaller withdrawal, or wait for manual review.',
                requested_sats: amount_sats,
                instant_limit_sats: WITHDRAW_CAPS.autoApproveSats,
                rolling_24h_sats: rolling24h,
                rolling_24h_limit_sats: rollingLimit,
              },
              'safe', 'No funds were moved yet. The withdrawal requires manual review.', [
                'Use a smaller amount for instant approval',
                'GET /api/v1/capital/balance to check available sats',
              ],
            ),
          };
        }

        const balance = await daemon.capitalLedger.withdraw(req.agentId, amount_sats, destination_address);
        await dangerPolicy.recordSuccess({
          scope: 'capital_withdraw',
          agentId: req.agentId,
          amountSats: amount_sats,
        });
        return {
          statusCode: 200,
          body: {
            agent_id: req.agentId,
            withdrawn_sats: amount_sats,
            destination_address,
            balance_after: balance,
            learn: 'Withdrawal recorded. Only available sats can be withdrawn. Locked sats require closing the channel first.',
            cost_summary: { action: 'withdraw', amount_sats, fee_sats: 0, total_sats: amount_sats, unit: 'sat' },
          },
        };
      },
      onError: (err) => {
        if (err.message.includes('Insufficient')) {
          return {
            statusCode: 409,
            body: withRecovery(
              {
                error: 'insufficient_balance',
                message: err.message,
                hint: 'Check your balance at GET /api/v1/capital/balance. Only available sats can be withdrawn — locked sats require closing the channel first.',
                see: 'GET /api/v1/capital/balance',
              },
              'safe', 'No funds were moved. Your available balance is too low for this withdrawal.', [
                'GET /api/v1/capital/balance to check available vs locked sats',
                'Close a channel first to unlock sats: POST /api/v1/market/close',
              ],
            ),
          };
        }
        console.error(`[Gateway] ${req.path}: ${err.message}`);
        return {
          statusCode: 500,
          body: withRecovery(
            { error: 'internal_error', message: 'Internal error while processing withdrawal.' },
            'safe', 'No funds were moved. The withdrawal failed due to a server error.', [
              'Wait a few seconds and retry POST /api/v1/capital/withdraw',
              'GET /api/v1/capital/balance to verify your balance is unchanged',
            ],
          ),
        };
      },
    });
  });

  // =========================================================================
  // DEPOSIT SYSTEM (Plan C)
  // =========================================================================

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
    const unexpected = findUnexpectedKeys(req.body, ['question', 'context', 'idempotency_key']);
    if (unexpected.length > 0) {
      return sendUnexpectedKeys(res, unexpected, 'GET /api/v1/skills/capital');
    }
    if (!daemon.helpEndpoint) {
      return agentError(res, 503, {
        error: 'service_unavailable',
        message: 'Help service is temporarily unavailable.',
        retryable: true,
        retry_after_seconds: 30,
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
        return { statusCode: 200, body: result };
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
            retry_after_seconds: err.retryAfter,
            hint: 'Try GET /llms.txt or GET /api/v1/knowledge/onboarding for self-serve answers.',
            ...(err.refunded ? { refunded: true } : {}),
          },
        };
      },
    });
  });

  return router;
}
