/**
 * Agent Paid Services Routes — /api/v1/analytics/, /api/v1/capital/, /api/v1/help
 *
 * Paid analytics gateway, capital ledger, help concierge.
 */

import { randomUUID } from 'node:crypto';
import { Router } from 'express';
import { requireAuth } from '../identity/auth.js';
import { checkAndIncrement, rateLimit } from '../identity/rate-limiter.js';
import { IdempotencyStore } from '../identity/idempotency-store.js';
import { runIdempotentRoute } from '../identity/idempotency-route.js';
import { err503Service, err400MissingField, err400Validation, err500Internal, agentError, buildRecovery, withRecovery } from '../identity/agent-friendly-errors.js';
import { DangerRoutePolicyStore, findUnexpectedKeys } from '../identity/danger-route-policy.js';
import { getDangerRouteSettings } from '../identity/danger-route-settings.js';
import { validateBitcoinAddress } from '../identity/validators.js';
import { summarizeLndError } from '../lnd/agent-error-utils.js';

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

function isMissingLoopError(err) {
  const message = String(err?.message || '');
  return message.includes('loop') || message.includes('Loop');
}

function isInsufficientCapitalError(err) {
  return /Insufficient available balance/i.test(String(err?.message || ''));
}

async function findTransactionByLabel(client, label) {
  const txs = await client.getTransactions();
  const list = Array.isArray(txs?.transactions) ? txs.transactions : [];
  return list.find((tx) => tx?.label === label) || null;
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
  // @agent-route {"auth":"agent","domain":"capital","subgroup":"Capital","label":"withdraw","summary":"Withdraw from capital.","order":120,"tags":["capital","write","agent"],"doc":["skills/capital-withdraw-and-help.txt","skills/capital.txt"],"security":{"moves_money":true,"requires_ownership":true,"requires_signature":false,"long_running":false}}
  router.post('/api/v1/capital/withdraw', auth, rateLimit('capital_write'), async (req, res) => {
    const unexpected = findUnexpectedKeys(req.body, ['amount_sats', 'destination_address', 'idempotency_key']);
    if (unexpected.length > 0) {
      return sendUnexpectedKeys(res, unexpected, 'GET /api/v1/capital/balance');
    }
    if (!daemon.capitalLedger) {
      return err503Service(res, 'Capital ledger');
    }

    const { amount_sats, destination_address } = req.body || {};
    if (!Number.isInteger(amount_sats) || amount_sats <= 0) {
      return err400Validation(res, 'amount_sats must be a positive integer.', {
        hint: 'Send an integer number of sats, like 10000.',
        see: 'GET /api/v1/capital/balance',
      });
    }
    if (!destination_address) {
      return err400MissingField(res, 'destination_address', {
        hint: 'Send a Bitcoin on-chain address to receive the withdrawal.',
        see: 'GET /api/v1/capital/balance',
      });
    }
    const addressCheck = validateBitcoinAddress(destination_address);
    if (!addressCheck.valid) {
      return err400Validation(res, `destination_address: ${addressCheck.reason}`, {
        hint: 'Send a valid Bitcoin address.',
        see: 'GET /api/v1/capital/balance',
      });
    }

    const attempts = await checkAndIncrement(
      `danger:capital_withdraw:attempt:${req.agentId}`,
      safety.capitalWithdraw.attemptLimit,
      safety.capitalWithdraw.attemptWindowMs,
    );
    if (!attempts.allowed) {
      return res.status(429).json({
        ...buildCooldownError('Too many capital withdrawal attempts right now.', 'Wait before trying another withdrawal.'),
        retry_after_ms: attempts.retryAfterMs,
        retry_at_ms: attempts.retryAtMs,
      });
    }

    const cooldown = await dangerPolicy.checkCooldown({
      scope: 'capital_withdraw',
      agentId: req.agentId,
      cooldownMs: safety.capitalWithdraw.cooldownMs,
    });
    if (!cooldown.allowed) {
      return res.status(429).json({
        ...buildCooldownError('A recent capital withdrawal is still cooling down.', 'Wait for the cooldown before withdrawing again.'),
        retry_after_ms: cooldown.retryAfterMs,
        retry_at_ms: cooldown.retryAtMs,
      });
    }

    const caps = safety.capitalWithdraw.caps || {};
    const policy = await dangerPolicy.assessAmount({
      scope: 'capital_withdraw',
      agentId: req.agentId,
      amountSats: amount_sats,
      ...caps,
    });
    if (policy.decision === 'hard_cap') {
      return agentError(res, 403, {
        error: 'capital_withdraw_amount_rejected',
        message: 'That withdrawal is above this node’s current capital-withdraw safety cap.',
        hint: 'Try a smaller amount.',
        see: 'GET /api/v1/capital/balance',
      });
    }
    if (policy.decision === 'review_required') {
      return agentError(res, 403, {
        error: 'capital_withdraw_manual_review_required',
        message: 'That withdrawal needs manual review on this node right now.',
        hint: 'Try a smaller amount or wait for the current review window to clear.',
        see: 'GET /api/v1/capital/balance',
      });
    }

    const client = daemon.nodeManager?.getScopedDefaultNodeOrNull?.('withdraw')
      || daemon.nodeManager?.getScopedDefaultNodeOrNull?.('wallet')
      || null;
    if (!client) {
      return agentError(res, 503, {
        error: 'service_unavailable',
        message: 'Capital withdrawals are unavailable because no withdraw-capable wallet node is connected.',
        hint: 'Try again later.',
        see: 'GET /api/v1/capital/balance',
      });
    }

    const withdrawalLabel = `capital-withdraw:${req.agentId}:${randomUUID()}`;
    let debited = false;
    try {
      const balanceAfter = await daemon.capitalLedger.withdraw(req.agentId, amount_sats, destination_address);
      debited = true;

      let sendResult = null;
      let recoveredFromUnknown = false;
      try {
        sendResult = await client.sendCoins(destination_address, amount_sats, {
          label: withdrawalLabel,
          minConfs: 1,
          spendUnconfirmed: false,
          timeoutMs: 120000,
        });
      } catch (err) {
        const detail = String(err?.message || '');
        const unknownOutcome = /timed out|timeout|socket|network|reset|eai_again/i.test(detail);
        if (unknownOutcome) {
          try {
            const knownTx = await findTransactionByLabel(client, withdrawalLabel);
            if (knownTx?.tx_hash) {
              sendResult = { txid: knownTx.tx_hash };
              recoveredFromUnknown = true;
            }
          } catch {}
        }
        if (!sendResult?.txid) {
          await daemon.capitalLedger.refundWithdrawal(
            req.agentId,
            amount_sats,
            destination_address,
            unknownOutcome ? 'withdraw_unknown_outcome_refunded' : 'withdraw_send_failed',
          );
          debited = false;
          return agentError(res, unknownOutcome ? 502 : 400, {
            error: 'capital_withdraw_failed',
            message: summarizeLndError(detail, {
              action: 'capital withdrawal',
              fallback: 'Capital withdrawal failed before broadcast.',
            }),
            hint: 'Your capital was returned to available balance.',
            see: 'GET /api/v1/capital/activity',
          });
        }
      }

      await dangerPolicy.recordSuccess({
        scope: 'capital_withdraw',
        agentId: req.agentId,
        amountSats: amount_sats,
      });

      return res.json({
        success: true,
        agent_id: req.agentId,
        amount_sats,
        destination_address,
        txid: sendResult.txid,
        label: withdrawalLabel,
        status: 'broadcast',
        recovered_from_unknown: recoveredFromUnknown,
        balance_after: balanceAfter,
        learn: 'The withdrawal broadcast on-chain. Watch the txid in a block explorer or your destination wallet.',
      });
    } catch (err) {
      if (debited) {
        try {
          await daemon.capitalLedger.refundWithdrawal(
            req.agentId,
            amount_sats,
            destination_address,
            'withdraw_internal_error_refunded',
          );
        } catch (refundErr) {
          console.error(`[Gateway] capital withdraw refund failed for ${req.agentId}: ${refundErr.message}`);
        }
      }
      console.error(`[Gateway] ${req.path}: ${err.message}`);
      if (isMissingNodeConnectionError(err)) {
        return agentError(res, 503, {
          error: 'service_unavailable',
          message: 'Capital withdrawals are unavailable because no wallet node is connected.',
          hint: 'Try again later.',
          see: 'GET /api/v1/capital/balance',
        });
      }
      if (isInsufficientCapitalError(err)) {
        return agentError(res, 400, {
          error: 'insufficient_capital',
          message: `You do not have enough available capital to withdraw ${amount_sats} sats.`,
          hint: 'Check your available capital first, or wait for pending funds to settle.',
          see: 'GET /api/v1/capital/balance',
        });
      }
      return err500Internal(res, 'processing capital withdrawal');
    }
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

  // Create a Lightning-funded capital deposit flow.
  // @agent-route {"auth":"agent","domain":"capital","subgroup":"Capital","label":"deposit-lightning","summary":"Create Lightning-funded capital deposit flow.","order":135,"tags":["capital","write","agent"],"doc":["skills/capital-lightning-deposit.txt","skills/capital.txt"],"security":{"moves_money":false,"requires_ownership":true,"requires_signature":false,"long_running":false}}
  router.post('/api/v1/capital/deposit-lightning', auth, rateLimit('capital_write'), async (req, res) => {
    const unexpected = findUnexpectedKeys(req.body, ['amount_sats', 'idempotency_key']);
    if (unexpected.length > 0) {
      return sendUnexpectedKeys(res, unexpected, 'GET /api/v1/capital/balance');
    }
    if (!daemon.lightningCapitalFunder) {
      return err503Service(res, 'Lightning capital deposit');
    }
    return runIdempotentRoute({
      req,
      res,
      store: idempotencyStore,
      scope: 'capital:deposit-lightning',
      handler: async () => {
        const { amount_sats } = req.body || {};
        if (!Number.isInteger(amount_sats) || amount_sats <= 0) {
          return {
            statusCode: 400,
            body: {
              error: 'validation_error',
              message: 'amount_sats must be a positive integer.',
              hint: 'Send a whole number of sats like 250000.',
              see: 'GET /api/v1/capital/balance',
            },
          };
        }
        const flow = await daemon.lightningCapitalFunder.createFlow(req.agentId, amount_sats);
        return {
          statusCode: 200,
          body: {
            ...flow,
            instructions: 'Pay the returned Lightning invoice outside the site, then poll the status_url until the deposit is confirmed.',
            cost_summary: { action: 'deposit_lightning', amount_sats: 0, fee_sats: 0, total_sats: 0, unit: 'sat' },
          },
        };
      },
      onError: (err) => {
        if (isMissingNodeConnectionError(err) || isMissingLoopError(err)) {
          return {
            statusCode: 503,
            body: withRecovery(
              {
                error: 'service_unavailable',
                message: err.message,
              },
              'safe', 'No Lightning capital invoice was created. No funds are at risk.', [
                'Retry POST /api/v1/capital/deposit-lightning later',
              ],
            ),
          };
        }
        if (err?.preflight) {
          return {
            statusCode: err.statusCode || 409,
            body: {
              error: 'capital_lightning_preflight_failed',
              message: err.message,
              hint: 'The site checked the bridge providers before creating the invoice and none were ready.',
              see: 'GET /api/v1/capital/balance',
              bridge_preflight: err.preflight,
              providers: err.preflight.providers,
            },
          };
        }
        return {
          statusCode: 400,
          body: {
            error: 'capital_lightning_error',
            message: err.message,
            hint: 'Try a supported amount and retry. The site now checks the bridge providers before it creates the invoice.',
            see: 'GET /api/v1/capital/balance',
          },
        };
      },
    });
  });

  // Read one Lightning-funded capital deposit flow.
  // @agent-route {"auth":"agent","domain":"capital","subgroup":"Capital","label":"deposit-lightning-status","summary":"Read Lightning-funded capital deposit flow.","order":136,"tags":["capital","read","agent"],"doc":["skills/capital-lightning-deposit.txt","skills/capital.txt"],"security":{"moves_money":false,"requires_ownership":true,"requires_signature":false,"long_running":false}}
  router.get('/api/v1/capital/deposit-lightning/:flowId', auth, rateLimit('capital_read'), async (req, res) => {
    try {
      if (!daemon.lightningCapitalFunder) {
        return err503Service(res, 'Lightning capital deposit');
      }
      const flow = await daemon.lightningCapitalFunder.getFlow(req.agentId, req.params.flowId);
      if (!flow) {
        return agentError(res, 404, {
          error: 'not_found',
          message: 'No Lightning capital deposit flow found for that id.',
          hint: 'Create a new flow first or use a flow_id returned by POST /api/v1/capital/deposit-lightning.',
          see: 'POST /api/v1/capital/deposit-lightning',
        });
      }
      return res.json(flow);
    } catch (err) {
      console.error(`[Gateway] ${req.path}: ${err.message}`);
      return err500Internal(res, 'reading Lightning capital deposit status');
    }
  });

  // Retry a paid Lightning-funded capital deposit flow after a failed Loop attempt.
  // @agent-route {"auth":"agent","domain":"capital","subgroup":"Capital","label":"deposit-lightning-retry","summary":"Retry a paid Lightning-funded capital deposit flow.","order":137,"tags":["capital","write","agent"],"doc":["skills/capital-lightning-deposit.txt","skills/capital.txt"],"security":{"moves_money":false,"requires_ownership":true,"requires_signature":false,"long_running":false}}
  router.post('/api/v1/capital/deposit-lightning/:flowId/retry', auth, rateLimit('capital_write'), async (req, res) => {
    const unexpected = findUnexpectedKeys(req.body, ['idempotency_key']);
    if (unexpected.length > 0) {
      return sendUnexpectedKeys(res, unexpected, 'GET /api/v1/capital/deposit-lightning/:flowId');
    }
    if (!daemon.lightningCapitalFunder) {
      return err503Service(res, 'Lightning capital deposit');
    }
    return runIdempotentRoute({
      req,
      res,
      store: idempotencyStore,
      scope: 'capital:deposit-lightning:retry',
      handler: async () => {
        try {
          const flow = await daemon.lightningCapitalFunder.retryFlow(req.agentId, req.params.flowId);
          if (!flow) {
            return {
              statusCode: 404,
              body: {
                error: 'not_found',
                message: 'No Lightning capital deposit flow found for that id.',
                hint: 'Use a flow_id returned by POST /api/v1/capital/deposit-lightning.',
                see: 'POST /api/v1/capital/deposit-lightning',
              },
            };
          }
          return {
            statusCode: 200,
            body: {
              ...flow,
              message: 'Retry requested. The site will try the bridge again.',
            },
          };
        } catch (err) {
          return {
            statusCode: 400,
            body: {
              error: 'capital_lightning_retry_error',
              message: err.message,
              hint: 'Only paid flows that failed after a bridge step can be retried.',
              see: 'GET /api/v1/capital/deposit-lightning/:flowId',
            },
          };
        }
      },
      onError: (err) => ({
        statusCode: 500,
        body: {
          error: 'internal_error',
          message: err.message || 'Internal error while retrying Lightning capital deposit.',
          hint: 'Read the flow status again, then retry if needed.',
          see: 'GET /api/v1/capital/deposit-lightning/:flowId',
        },
      }),
    });
  });

  // Read capital deposits.
  // @agent-route {"auth":"agent","domain":"capital","subgroup":"Capital","label":"deposits","summary":"Read capital deposits.","order":140,"tags":["capital","read","agent"],"doc":["skills/capital-deposit-and-status.txt","skills/capital.txt"],"security":{"moves_money":false,"requires_ownership":true,"requires_signature":false,"long_running":false}}
  router.get('/api/v1/capital/deposits', auth, rateLimit('capital_read'), async (req, res) => {
    try {
      if (!daemon.depositTracker) {
        return err503Service(res, 'Deposit tracker');
      }
      const { deposits: rawDeposits } = daemon.depositTracker.getDepositStatus(req.agentId);
      const deposits = daemon.lightningCapitalFunder
        ? daemon.lightningCapitalFunder.annotateDeposits(req.agentId, rawDeposits)
        : rawDeposits;
      res.json({
        agent_id: req.agentId,
        deposits,
        learn: {
          statuses: {
            watching: 'Address generated, waiting for incoming transaction.',
            pending_deposit: 'Transaction detected, waiting for confirmations.',
            confirmed: 'Deposit confirmed and credited to your available balance.',
          },
          sources: {
            onchain: 'A normal on-chain capital deposit address.',
            lightning_capital_bridge: 'A Lightning-funded capital deposit that the site is bridging on-chain.',
            lightning_loop_out: 'Legacy label for an older Lightning-funded capital bridge deposit.',
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
