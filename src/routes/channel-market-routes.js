/**
 * Channel Market Routes — /api/v1/market/
 *
 * Plan D: Channel Open
 *   POST /api/v1/market/preview  — Dry-run validation (no execution)
 *   POST /api/v1/market/open     — Submit signed channel open request
 *   GET  /api/v1/market/pending  — View own pending opens
 *   GET  /api/v1/market/config   — Channel open limits and configuration
 *
 * Plan E: Channel Close
 *   POST /api/v1/market/close    — Submit signed channel close request
 *   GET  /api/v1/market/closes   — View own closes
 *
 * Plan F: Revenue Attribution
 *   GET  /api/v1/market/revenue          — Own revenue summary
 *   GET  /api/v1/market/revenue/:chanId  — Per-channel revenue
 *   PUT  /api/v1/market/revenue-config   — Set revenue destination
 *
 * Plan I: Submarine Swap
 *   GET  /api/v1/market/swap/quote                  — Fee estimate
 *   GET  /api/v1/market/swap/history                — Past swaps
 *
 * Plan G: Performance Dashboard
 *   GET  /api/v1/market/performance          — Own agent performance summary (auth)
 *   GET  /api/v1/market/performance/:chanId  — Per-channel performance metrics (auth)
 *   GET  /api/v1/market/rankings             — Agent leaderboard (public, rate limited)
 *
 * Plan H: Rebalancing
 *   POST /api/v1/market/rebalance              — Submit signed rebalance request
 *   POST /api/v1/market/rebalance/estimate     — Estimate routing fee
 *   GET  /api/v1/market/rebalances             — Own rebalance history
 *
 * Plan N: Market Transparency (public, no auth)
 *   GET  /api/v1/market/overview               — Market summary stats
 *   GET  /api/v1/market/channels               — Paginated channel list
 *   GET  /api/v1/market/agent/:agentId         — Agent public profile
 *   GET  /api/v1/market/peer-safety/:pubkey    — Peer safety info
 *   GET  /api/v1/market/fees/:peerPubkey       — Fee competition view
 */

import { Router } from 'express';
import { requireAuth } from '../identity/auth.js';
import { checkAndIncrement, rateLimit } from '../identity/rate-limiter.js';
import { IdempotencyStore } from '../identity/idempotency-store.js';
import { runIdempotentRoute } from '../identity/idempotency-route.js';
import { agentError, err400Validation, err404NotFound, withRecovery } from '../identity/agent-friendly-errors.js';
import { logAuthorizationDenied } from '../identity/audit-log.js';
import { getSocketAddress } from '../identity/request-security.js';
import { DangerRoutePolicyStore, findUnexpectedKeys } from '../identity/danger-route-policy.js';
import { getDangerRouteSettings } from '../identity/danger-route-settings.js';

function submarineSwapsEnabled() {
  return process.env.ENABLE_SUBMARINE_SWAPS === '1';
}

const EXPENSIVE_RESULT_CACHE_TTL_MS = 5_000;
const OPEN_CAPS = {
  scope: 'market_open',
};
const REBALANCE_CAPS = {
  scope: 'market_rebalance',
};

function fundingTxExplorerLinks(txid) {
  if (!txid || typeof txid !== 'string') return null;
  return {
    watch_url: `https://mempool.space/tx/${txid}`,
    explorers: {
      mempool: `https://mempool.space/tx/${txid}`,
      blockstream: `https://blockstream.info/tx/${txid}`,
    },
  };
}

function sendTeachingHelp(res, body) {
  res.json({
    message: body.message,
    learn: body.learn,
    next: body.next,
    example_request: body.example_request,
  });
}

function sendUnexpectedKeys(res, unexpected, see) {
  return err400Validation(res, `Unexpected field(s): ${unexpected.join(', ')}`, {
    hint: 'Send only the documented JSON keys for this route.',
    see,
  });
}

function parseFundingAmount(body) {
  return body?.instruction?.params?.local_funding_amount_sats;
}

function parseRebalanceAmount(body) {
  return body?.instruction?.params?.amount_sats;
}

function getPendingItems(handler, agentId) {
  if (!handler || typeof handler.getPendingForAgent !== 'function') {
    return [];
  }
  const pending = handler.getPendingForAgent(agentId);
  return Array.isArray(pending) ? pending : [];
}

function sendReviewRequiredResult({
  message,
  hint,
}) {
  return {
    statusCode: 202,
    body: {
      status: 202,
      review_required: true,
      message,
      hint,
    },
  };
}

function sendCapExceededResult({
  message,
  hint,
}) {
  return {
    statusCode: 403,
    body: {
      error: 'cap_exceeded',
      message,
      hint,
    },
  };
}

function buildCooldownBody(message, hint, cooldown = null, scope = null) {
  const retryAfterMs = Number.isFinite(cooldown?.retryAfterMs)
    ? Math.max(0, Math.floor(cooldown.retryAfterMs))
    : Number.isFinite(cooldown?.retryAfter)
      ? Math.max(0, Math.floor(cooldown.retryAfter * 1000))
      : Number.isFinite(cooldown?.retryAfterSeconds)
        ? Math.max(0, Math.floor(cooldown.retryAfterSeconds * 1000))
        : 0;
  const retryAtMs = Number.isFinite(cooldown?.retryAtMs)
    ? cooldown.retryAtMs
    : retryAfterMs > 0
      ? Date.now() + retryAfterMs
      : null;
  return {
    error: 'cooldown_active',
    message,
    retryable: true,
    hint,
    retry_after_ms: retryAfterMs,
    retry_after_seconds: retryAfterMs > 0 ? Math.ceil(retryAfterMs / 1000) : 0,
    retry_at_ms: retryAtMs,
    cooldown_scope: scope || null,
  };
}

function setJourneyResultMeta(req, {
  failureCode = null,
  failureStage = null,
  failureReason = null,
  cooldown = null,
  cooldownScope = null,
} = {}) {
  if (typeof req?.dashboardSetResultMeta !== 'function') return;
  const meta = {};
  if (typeof failureCode === 'string' && failureCode.trim()) meta.failure_code = failureCode.trim();
  if (typeof failureStage === 'string' && failureStage.trim()) meta.failure_stage = failureStage.trim();
  if (typeof failureReason === 'string' && failureReason.trim()) meta.failure_reason = failureReason.trim();
  if (cooldown) {
    if (Number.isFinite(cooldown.retry_after_ms)) meta.cooldown_retry_after_ms = cooldown.retry_after_ms;
    if (Number.isFinite(cooldown.retry_at_ms)) meta.cooldown_retry_at_ms = cooldown.retry_at_ms;
  }
  if (typeof cooldownScope === 'string' && cooldownScope.trim()) meta.cooldown_scope = cooldownScope.trim();
  req.dashboardSetResultMeta(meta);
}

function formatCloseEntry(entry = {}) {
  const status = String(entry.status || '').trim();
  const rawError = String(entry.error || '').trim();
  const cleanError = rawError === '[object Object]'
    ? 'The node returned an unformatted close error.'
    : rawError || null;

  let statusLabel = status || 'unknown';
  let message = null;
  let hint = null;

  if (status === 'pending_close') {
    statusLabel = 'closing';
    message = 'The close was submitted and is waiting to settle on-chain.';
    hint = 'Watch GET /api/v1/market/closes until it settles.';
  } else if (status === 'close_submitted_unknown') {
    statusLabel = 'submission_unknown';
    message = 'The node did not answer before the timeout. The channel may still be closing.';
    hint = 'Wait a bit, then recheck GET /api/v1/market/closes and GET /api/v1/capital/balance.';
  } else if (status === 'close_failed') {
    statusLabel = 'failed';
    message = cleanError || 'The close request failed.';
    hint = 'Check GET /api/v1/channels/mine and GET /api/v1/market/closes before retrying.';
  } else if (status === 'settled' || status === 'external_settled') {
    statusLabel = 'settled';
    message = 'The channel close settled and the balance was credited back.';
    hint = 'Check GET /api/v1/capital/balance for the returned sats.';
  }

  return {
    ...entry,
    status_label: statusLabel,
    message,
    hint,
    error: cleanError,
  };
}

async function applyMoneyPolicy({ dangerPolicy, caps, agentId, amountSats }) {
  const decision = await dangerPolicy.assessAmount({
    scope: caps.scope,
    agentId,
    amountSats,
    autoApproveSats: caps.autoApproveSats,
    hardCapSats: caps.hardCapSats,
    dailyAutoApproveSats: caps.dailyAutoApproveSats,
    dailyHardCapSats: caps.dailyHardCapSats,
    sharedDailyAutoApproveSats: caps.sharedDailyAutoApproveSats,
    sharedDailyHardCapSats: caps.sharedDailyHardCapSats,
  });
  const sharedReason = typeof decision.decisionReason === 'string' && decision.decisionReason.startsWith('shared_');
  if (decision.decision === 'hard_cap') {
    return sendCapExceededResult({
      message: sharedReason ? 'This request is above the shared-node safety cap.' : 'This request is above the safety cap.',
      hint: sharedReason ? 'Use a smaller amount, or wait for the shared-node budget window to reset.' : 'Use a smaller amount.',
    });
  }
  if (decision.decision === 'review_required') {
    return sendReviewRequiredResult({
      message: sharedReason ? 'This request is above the shared-node instant-approve limit.' : 'This request is above the instant-approve limit.',
      hint: sharedReason ? 'Use a smaller amount, or wait for the shared-node budget window to reset.' : 'Use a smaller amount, or wait for manual review.',
    });
  }
  return null;
}

async function sharedDangerCooldown({ dangerPolicy, scope, cooldownMs }) {
  return dangerPolicy.checkCooldown({
    scope,
    agentId: '__shared__',
    cooldownMs,
  });
}

function createShortTtlSingleFlight(ttlMs = EXPENSIVE_RESULT_CACHE_TTL_MS) {
  const inflight = new Map();
  const cache = new Map();

  function getCached(key) {
    const entry = cache.get(key);
    if (!entry) return null;
    if (entry.expiresAt <= Date.now()) {
      cache.delete(key);
      return null;
    }
    return entry.value;
  }

  async function run(key, work) {
    const cached = getCached(key);
    if (cached) return cached;

    if (inflight.has(key)) {
      return inflight.get(key);
    }

    const promise = (async () => {
      try {
        const value = await work();
        cache.set(key, {
          value,
          expiresAt: Date.now() + ttlMs,
        });
        return value;
      } finally {
        inflight.delete(key);
      }
    })();

    inflight.set(key, promise);
    return promise;
  }

  return { getCached, run };
}

export function channelMarketRoutes(daemon) {
  const router = Router();
  const auth = requireAuth(daemon.agentRegistry);
  const marketPrivateRead = rateLimit('market_private_read');
  const marketWrite = rateLimit('market_write');
  const marketRL = rateLimit('market_read');
  const idempotencyStore = daemon.dataLayer ? new IdempotencyStore({ dataLayer: daemon.dataLayer }) : null;
  const dangerPolicy = new DangerRoutePolicyStore({ dataLayer: daemon.dataLayer });
  const safety = getDangerRouteSettings(daemon.config);
  const previewSingleFlight = createShortTtlSingleFlight();
  const rebalanceEstimateSingleFlight = createShortTtlSingleFlight();

  // =========================================================================
  // Plan D: Channel Open
  // =========================================================================

  // Read market config.
  // @agent-route {"auth":"public","domain":"market","subgroup":"Market Reads","label":"config","summary":"Read market config.","order":100,"tags":["market","read","public"],"doc":["skills/market-public-market-read.txt","skills/market.txt"],"security":{"moves_money":false,"requires_ownership":false,"requires_signature":false,"long_running":false}}
  router.get('/api/v1/market/config', marketRL, (req, res) => {
    if (!daemon.channelOpener) {
      return res.status(503).json({ error: 'Channel opener not initialized' });
    }
    res.json(daemon.channelOpener.getConfig());
  });

  // Read market preview.
  // @agent-route {"auth":"agent","domain":"market","subgroup":"Open Flow","label":"preview","summary":"Read market preview.","order":200,"tags":["market","read","agent"],"doc":["skills/market-teaching-surfaces.txt","skills/market.txt"],"security":{"moves_money":false,"requires_ownership":true,"requires_signature":false,"long_running":false}}
  router.get('/api/v1/market/preview', auth, marketPrivateRead, (_req, res) => {
    sendTeachingHelp(res, {
      message: 'This is the market preview help route.',
      learn: 'Use POST /api/v1/market/preview with a signed channel_open instruction to validate an open before the real submit.',
      next: [
        'GET /api/v1/market/config',
        'POST /api/v1/market/preview',
        'POST /api/v1/market/open',
      ],
      example_request: {
        method: 'POST',
        path: '/api/v1/market/preview',
        json: {
          instruction: {
            action: 'channel_open',
            agent_id: '<agent_id>',
            params: {
              local_funding_amount_sats: 100000,
              peer_pubkey: '<peer_pubkey>',
            },
            timestamp: 0,
          },
          signature: '<hex_signature>',
        },
      },
    });
  });

  // Preview market.
  // @agent-route {"auth":"agent","domain":"market","subgroup":"Open Flow","label":"preview","summary":"Preview market.","order":210,"tags":["market","write","agent"],"doc":["skills/market-open-flow.txt","skills/market.txt"],"security":{"moves_money":false,"requires_ownership":true,"requires_signature":true,"long_running":false}}
  router.post('/api/v1/market/preview', auth, marketWrite, async (req, res) => {
    const unexpected = findUnexpectedKeys(req.body, ['instruction', 'signature', 'idempotency_key']);
    if (unexpected.length > 0) {
      return sendUnexpectedKeys(res, unexpected, 'GET /api/v1/market/config');
    }
    if (!daemon.channelOpener) {
      return res.status(503).json({ error: 'Channel opener not initialized' });
    }
    try {
      const previewKey = `market-preview:${req.agentId}:${JSON.stringify(req.body || {})}`;
      const cached = previewSingleFlight.getCached(previewKey);
      if (cached) {
        return res.status(cached.statusCode).json(cached.body);
      }
      const attempts = await checkAndIncrement(
        `danger:market_preview:attempt:${req.agentId}`,
        safety.market.preview.agentAttemptLimit,
        safety.market.preview.attemptWindowMs,
      );
      if (!attempts.allowed) {
        const body = buildCooldownBody(
          'Too many market preview attempts in a short window.',
          'Wait a bit before running another preview.',
          attempts,
          'market_preview_attempts',
        );
        setJourneyResultMeta(req, {
          failureCode: body.error,
          failureStage: 'market_preview_cooldown',
          failureReason: body.message,
          cooldown: body,
          cooldownScope: body.cooldown_scope,
        });
        return res.status(429).json(body);
      }
      const sharedAttempts = await checkAndIncrement(
        'danger:market_preview:attempt:__shared__',
        safety.market.preview.sharedAttemptLimit,
        safety.market.preview.attemptWindowMs,
      );
      if (!sharedAttempts.allowed) {
        const body = buildCooldownBody(
          'The node is handling too many market previews right now.',
          'Wait a bit, then try your preview again.',
          sharedAttempts,
          'market_preview_shared_attempts',
        );
        setJourneyResultMeta(req, {
          failureCode: body.error,
          failureStage: 'market_preview_cooldown',
          failureReason: body.message,
          cooldown: body,
          cooldownScope: body.cooldown_scope,
        });
        return res.status(429).json(body);
      }
      const amountSats = parseFundingAmount(req.body);
      if (Number.isInteger(amountSats) && amountSats > 0) {
        const policy = await applyMoneyPolicy({
          dangerPolicy,
          caps: { ...OPEN_CAPS, ...safety.market.preview.caps },
          agentId: req.agentId,
          amountSats,
        });
        if (policy) {
          setJourneyResultMeta(req, {
            failureCode: policy.body?.error || 'market_preview_policy',
            failureStage: 'market_preview_policy',
            failureReason: policy.body?.message || policy.body?.hint || 'Market preview policy blocked this request.',
          });
          return res.status(policy.statusCode).json(policy.body);
        }
      }
      const response = await previewSingleFlight.run(previewKey, async () => {
        const result = await daemon.channelOpener.preview(req.agentId, req.body);
        return {
          statusCode: result.valid ? 200 : (result.status || 400),
          body: result,
        };
      });
      if (!response.body?.valid) {
        setJourneyResultMeta(req, {
          failureCode: response.body?.error || 'preview_failed',
          failureStage: response.body?.failed_at || 'market_preview',
          failureReason: response.body?.error || 'Market preview failed.',
        });
      }
      res.status(response.statusCode).json(response.body);
    } catch (err) {
      console.error(`[market/preview] Error: ${err.message}`);
      res.status(500).json(withRecovery(
        { error: 'Internal error during preview' },
        'safe', 'Preview is read-only. No funds were locked or spent.', [
          'Wait a few seconds and retry POST /api/v1/market/preview',
        ],
      ));
    }
  });

  // Read market open.
  // @agent-route {"auth":"agent","domain":"market","subgroup":"Open Flow","label":"open","summary":"Read market open.","order":220,"tags":["market","read","agent"],"doc":["skills/market-teaching-surfaces.txt","skills/market.txt"],"security":{"moves_money":false,"requires_ownership":true,"requires_signature":false,"long_running":false}}
  router.get('/api/v1/market/open', auth, marketPrivateRead, (_req, res) => {
    sendTeachingHelp(res, {
      message: 'This is the market open help route.',
      learn: 'Use POST /api/v1/market/open with a signed channel_open instruction after a successful preview.',
      next: [
        'GET /api/v1/market/config',
        'POST /api/v1/market/preview',
        'POST /api/v1/market/open',
        'GET /api/v1/market/pending',
      ],
      example_request: {
        method: 'POST',
        path: '/api/v1/market/open',
        json: {
          instruction: {
            action: 'channel_open',
            agent_id: '<agent_id>',
            params: {
              local_funding_amount_sats: 100000,
              peer_pubkey: '<peer_pubkey>',
            },
            timestamp: 0,
          },
          signature: '<hex_signature>',
        },
      },
    });
  });

  // Open market.
  // @agent-route {"auth":"agent","domain":"market","subgroup":"Open Flow","label":"open","summary":"Open market.","order":230,"tags":["market","write","agent"],"doc":["skills/market-open-flow.txt","skills/market.txt"],"security":{"moves_money":true,"requires_ownership":true,"requires_signature":true,"long_running":true}}
  router.post('/api/v1/market/open', auth, marketWrite, async (req, res) => {
    const unexpected = findUnexpectedKeys(req.body, ['instruction', 'signature', 'idempotency_key']);
    if (unexpected.length > 0) {
      return sendUnexpectedKeys(res, unexpected, 'POST /api/v1/market/preview');
    }
    if (!daemon.channelOpener) {
      return res.status(503).json({ error: 'Channel opener not initialized' });
    }
    return runIdempotentRoute({
      req,
      res,
      store: idempotencyStore,
      scope: 'market:open',
      handler: async () => {
        const amountSats = parseFundingAmount(req.body);
        const attempts = await checkAndIncrement(
          `danger:market_open:attempt:${req.agentId}`,
          safety.market.open.agentAttemptLimit,
          safety.market.open.attemptWindowMs,
        );
        if (!attempts.allowed) {
          const body = buildCooldownBody(
            'Too many channel-open attempts right now.',
            'Wait before trying another channel open.',
            attempts,
            'market_open_attempts',
          );
          setJourneyResultMeta(req, {
            failureCode: body.error,
            failureStage: 'market_open_cooldown',
            failureReason: body.message,
            cooldown: body,
            cooldownScope: body.cooldown_scope,
          });
          return {
            statusCode: 429,
            body,
          };
        }
        const sharedAttempts = await checkAndIncrement(
          'danger:market_open:attempt:__shared__',
          safety.market.open.sharedAttemptLimit,
          safety.market.open.attemptWindowMs,
        );
        if (!sharedAttempts.allowed) {
          const body = buildCooldownBody(
            'The node is handling too many channel-open attempts right now.',
            'Wait a bit, then try another channel open.',
            sharedAttempts,
            'market_open_shared_attempts',
          );
          setJourneyResultMeta(req, {
            failureCode: body.error,
            failureStage: 'market_open_cooldown',
            failureReason: body.message,
            cooldown: body,
            cooldownScope: body.cooldown_scope,
          });
          return {
            statusCode: 429,
            body,
          };
        }
        const cooldown = await dangerPolicy.checkCooldown({
          scope: OPEN_CAPS.scope,
          agentId: req.agentId,
          cooldownMs: safety.market.open.cooldownMs,
        });
        if (!cooldown.allowed) {
          const body = buildCooldownBody(
            'A recent channel open is still cooling down.',
            'Wait for the cooldown window to pass before opening another channel.',
            cooldown,
            'market_open_success',
          );
          setJourneyResultMeta(req, {
            failureCode: body.error,
            failureStage: 'market_open_cooldown',
            failureReason: body.message,
            cooldown: body,
            cooldownScope: body.cooldown_scope,
          });
          return {
            statusCode: 429,
            body,
          };
        }
        const sharedCooldown = await sharedDangerCooldown({
          dangerPolicy,
          scope: OPEN_CAPS.scope,
          cooldownMs: safety.market.sharedSuccessCooldownMs,
        });
        if (!sharedCooldown.allowed) {
          const body = buildCooldownBody(
            'The node is cooling down after a recent channel open.',
            'Wait a bit before another agent opens a new channel on this node.',
            sharedCooldown,
            'market_open_shared_success',
          );
          setJourneyResultMeta(req, {
            failureCode: body.error,
            failureStage: 'market_open_cooldown',
            failureReason: body.message,
            cooldown: body,
            cooldownScope: body.cooldown_scope,
          });
          return {
            statusCode: 429,
            body,
          };
        }
        if (getPendingItems(daemon.channelOpener, req.agentId).length >= safety.market.maxPendingOperations) {
          setJourneyResultMeta(req, {
            failureCode: 'too_many_pending_operations',
            failureStage: 'market_open_pending_limit',
            failureReason: 'You already have too many pending market actions.',
          });
          return {
            statusCode: 429,
            body: {
              error: 'too_many_pending_operations',
              message: 'You already have too many pending market actions.',
              hint: 'Wait for a pending channel open to confirm before starting another.',
            },
          };
        }
        if (Number.isInteger(amountSats) && amountSats > 0) {
          const policy = await applyMoneyPolicy({
            dangerPolicy,
            caps: { ...OPEN_CAPS, ...safety.market.open.caps },
            agentId: req.agentId,
            amountSats,
          });
          if (policy) {
            setJourneyResultMeta(req, {
              failureCode: policy.body?.error || 'market_open_policy',
              failureStage: 'market_open_policy',
              failureReason: policy.body?.message || policy.body?.hint || 'Channel-open policy blocked this request.',
            });
            return policy;
          }
        }
        const result = await daemon.channelOpener.open(req.agentId, req.body);
        if (!result?.success) {
          setJourneyResultMeta(req, {
            failureCode: result?.error || 'market_open_failed',
            failureStage: result?.failed_at || 'market_open',
            failureReason: result?.error || 'Channel open failed.',
          });
        }
        if (result?.success && Number.isInteger(amountSats) && amountSats > 0) {
          await dangerPolicy.recordSuccess({
            scope: OPEN_CAPS.scope,
            agentId: req.agentId,
            amountSats,
          });
          await dangerPolicy.recordSuccess({
            scope: OPEN_CAPS.scope,
            agentId: '__shared__',
          });
        }
        const openBody = result?.success && Number.isInteger(amountSats) && amountSats > 0
          ? { ...result, cost_summary: { action: 'channel_open', amount_sats: amountSats, fee_sats: 0, total_sats: amountSats, unit: 'sat' } }
          : result;
        return { statusCode: result.success ? 200 : (result.status || 400), body: openBody };
      },
      onError: (err) => {
        console.error(`[market/open] Error: ${err.message}`);
        return {
          statusCode: 500,
          body: withRecovery(
            { error: 'Internal error during channel open' },
            'action_needed', 'Capital may have been locked for this channel open. Check your capital balance and pending opens.', [
              'GET /api/v1/capital/balance to check if capital was locked',
              'GET /api/v1/market/pending to check if the open is in progress',
              'Locked capital auto-releases if the channel open fails to confirm',
            ],
          ),
        };
      },
    });
  });

  // Read market pending.
  // @agent-route {"auth":"agent","domain":"market","subgroup":"Open Flow","label":"pending","summary":"Read market pending.","order":240,"tags":["market","read","agent"],"doc":["skills/market-open-flow.txt","skills/market.txt"],"security":{"moves_money":false,"requires_ownership":true,"requires_signature":false,"long_running":false}}
  router.get('/api/v1/market/pending', auth, marketPrivateRead, async (req, res) => {
    if (!daemon.channelOpener) {
      return res.status(503).json({ error: 'Channel opener not initialized' });
    }
    try {
      const pending = getPendingItems(daemon.channelOpener, req.agentId).map((entry) => ({
        ...entry,
        ...(fundingTxExplorerLinks(entry.funding_txid) || {}),
      }));
      res.json({
        agent_id: req.agentId,
        pending_opens: pending,
        count: pending.length,
        learn: pending.length > 0
          ? 'Your pending channel opens are listed above. Once a funding transaction confirms ' +
            'enough for LND to mark the channel active, the channel will be auto-assigned to you and appear in ' +
            'GET /api/v1/channels/mine.'
          : 'No pending channel opens. Use POST /api/v1/market/open to open a new channel.',
      });
    } catch (err) {
      console.error(`[market/pending] Error: ${err.message}`);
      res.status(500).json({ error: 'Internal error fetching pending opens' });
    }
  });

  // =========================================================================
  // Plan E: Channel Close
  // =========================================================================

  // Read market close.
  // @agent-route {"auth":"agent","domain":"market","subgroup":"Close Flow","label":"close","summary":"Read market close.","order":300,"tags":["market","read","agent"],"doc":["skills/market-teaching-surfaces.txt","skills/market.txt"],"security":{"moves_money":false,"requires_ownership":true,"requires_signature":false,"long_running":false}}
  router.get('/api/v1/market/close', auth, marketPrivateRead, (_req, res) => {
    sendTeachingHelp(res, {
      message: 'This is the market close help route.',
      learn: 'Use POST /api/v1/market/close with a signed channel_close instruction for one channel you already own.',
      next: [
        'GET /api/v1/channels/mine',
        'POST /api/v1/market/close',
        'GET /api/v1/market/closes',
      ],
      example_request: {
        method: 'POST',
        path: '/api/v1/market/close',
        json: {
          instruction: {
            action: 'channel_close',
            agent_id: '<agent_id>',
            params: {
              channel_point: '<funding_txid>:<output_index>',
            },
            timestamp: 0,
          },
          signature: '<hex_signature>',
        },
      },
    });
  });

  // Close market.
  // @agent-route {"auth":"agent","domain":"market","subgroup":"Close Flow","label":"close","summary":"Close market.","order":310,"tags":["market","write","agent"],"doc":["skills/market-close.txt","skills/market.txt"],"security":{"moves_money":true,"requires_ownership":true,"requires_signature":true,"long_running":true}}
  router.post('/api/v1/market/close', auth, marketWrite, async (req, res) => {
    const unexpected = findUnexpectedKeys(req.body, ['instruction', 'signature', 'idempotency_key']);
    if (unexpected.length > 0) {
      return sendUnexpectedKeys(res, unexpected, 'GET /api/v1/market/closes');
    }
    if (!daemon.channelCloser) {
      return res.status(503).json({ error: 'Channel closer not initialized' });
    }
    return runIdempotentRoute({
      req,
      res,
      store: idempotencyStore,
      scope: 'market:close',
      handler: async () => {
        const attempts = await checkAndIncrement(
          `danger:market_close:attempt:${req.agentId}`,
          safety.market.close.agentAttemptLimit,
          safety.market.close.attemptWindowMs,
        );
        if (!attempts.allowed) {
          return {
            statusCode: 429,
            body: buildCooldownBody(
              'Too many close attempts right now.',
              'Wait before trying another channel close.',
            ),
          };
        }
        const sharedAttempts = await checkAndIncrement(
          'danger:market_close:attempt:__shared__',
          safety.market.close.sharedAttemptLimit,
          safety.market.close.attemptWindowMs,
        );
        if (!sharedAttempts.allowed) {
          return {
            statusCode: 429,
            body: buildCooldownBody(
              'The node is handling too many channel-close attempts right now.',
              'Wait a bit, then try another channel close.',
            ),
          };
        }
        const cooldown = await dangerPolicy.checkCooldown({
          scope: 'market_close',
          agentId: req.agentId,
          cooldownMs: safety.market.close.cooldownMs,
        });
        if (!cooldown.allowed) {
          return {
            statusCode: 429,
            body: buildCooldownBody(
              'A recent channel close is still cooling down.',
              'Wait for the cooldown window to pass before closing another channel.',
            ),
          };
        }
        const sharedCooldown = await sharedDangerCooldown({
          dangerPolicy,
          scope: 'market_close',
          cooldownMs: safety.market.sharedSuccessCooldownMs,
        });
        if (!sharedCooldown.allowed) {
          return {
            statusCode: 429,
            body: buildCooldownBody(
              'The node is cooling down after a recent channel close.',
              'Wait a bit before another agent closes a channel on this node.',
            ),
          };
        }
        if (getPendingItems(daemon.channelCloser, req.agentId).length >= safety.market.maxPendingOperations) {
          return {
            statusCode: 429,
            body: {
              error: 'too_many_pending_operations',
              message: 'You already have too many pending market actions.',
              hint: 'Wait for a pending channel close to settle before starting another.',
            },
          };
        }
        const result = await daemon.channelCloser.requestClose(req.agentId, req.body);
        if (!result?.success || result?.status === 'close_submitted_unknown') {
          setJourneyResultMeta(req, {
            failureCode: result?.error || 'market_close_issue',
            failureStage: 'market_close',
            failureReason: result?.message || result?.error || 'Channel close had a follow-up issue.',
          });
        }
        if (result?.success && result?.status !== 'close_submitted_unknown') {
          await dangerPolicy.recordSuccess({
            scope: 'market_close',
            agentId: req.agentId,
          });
          await dangerPolicy.recordSuccess({
            scope: 'market_close',
            agentId: '__shared__',
          });
        }
        const closeBody = result?.success
          ? { ...result, cost_summary: { action: 'channel_close', amount_sats: 0, fee_sats: 0, total_sats: 0, unit: 'sat' } }
          : result;
        return {
          statusCode: result?.http_status || (result.success ? 200 : (result.status || 400)),
          body: closeBody,
        };
      },
      onError: (err) => {
        console.error(`[market/close] Error: ${err.message}`);
        return {
          statusCode: 500,
          body: withRecovery(
            { error: 'Internal error during channel close' },
            'action_needed', 'The close status may be unknown. Check your close list before retrying.', [
              'GET /api/v1/market/closes to check if the close was already initiated or settled',
              'GET /api/v1/capital/balance to check whether funds are still locked',
              'Retry POST /api/v1/market/close with the same signed instruction',
            ],
          ),
        };
      },
    });
  });

  // Read market closes.
  // @agent-route {"auth":"agent","domain":"market","subgroup":"Close Flow","label":"closes","summary":"Read market closes.","order":320,"tags":["market","read","agent"],"doc":["skills/market-close.txt","skills/market.txt"],"security":{"moves_money":false,"requires_ownership":true,"requires_signature":false,"long_running":false}}
  router.get('/api/v1/market/closes', auth, marketPrivateRead, async (req, res) => {
    if (!daemon.channelCloser) {
      return res.status(503).json({ error: 'Channel closer not initialized' });
    }
    try {
      await daemon.channelCloser.refreshNow?.();
      const closes = daemon.channelCloser.getClosesForAgent(req.agentId).map(formatCloseEntry);
      res.json({
        agent_id: req.agentId,
        closes,
        count: closes.length,
        learn: closes.length > 0
          ? 'Your channel closes are listed above. Pending closes will settle after on-chain confirmation.'
          : 'No channel closes recorded. Use POST /api/v1/market/close to close a channel.',
      });
    } catch (err) {
      console.error(`[market/closes] Error: ${err.message}`);
      res.status(500).json({ error: 'Internal error fetching closes' });
    }
  });

  // =========================================================================
  // Plan F: Revenue Attribution
  // =========================================================================

  // Read market revenue.
  // @agent-route {"auth":"agent","domain":"market","subgroup":"Revenue","label":"revenue","summary":"Read market revenue.","order":400,"tags":["market","read","agent"],"doc":["skills/market-close.txt","skills/market.txt"],"security":{"moves_money":false,"requires_ownership":true,"requires_signature":false,"long_running":false}}
  router.get('/api/v1/market/revenue', auth, marketPrivateRead, async (req, res) => {
    if (!daemon.revenueTracker) {
      return res.status(503).json({ error: 'Revenue tracker not initialized' });
    }
    try {
      const revenue = daemon.revenueTracker.getAgentRevenue(req.agentId);
      res.json(revenue);
    } catch (err) {
      console.error(`[market/revenue] Error: ${err.message}`);
      res.status(500).json({ error: 'Internal error fetching revenue' });
    }
  });

  // Read market revenue by chanId.
  // @agent-route {"auth":"agent","domain":"market","subgroup":"Revenue","label":"revenue-by-channel","summary":"Read market revenue by chanId.","order":410,"tags":["market","read","dynamic","agent"],"doc":["skills/market-close.txt","skills/market.txt"],"security":{"moves_money":false,"requires_ownership":true,"requires_signature":false,"long_running":false}}
  router.get('/api/v1/market/revenue/:chanId', auth, marketPrivateRead, async (req, res) => {
    if (!daemon.revenueTracker) {
      return res.status(503).json({ error: 'Revenue tracker not initialized' });
    }
    try {
      const assignment = daemon.channelAssignments?.getAssignment(req.params.chanId);
      if (!assignment || assignment.agent_id !== req.agentId) {
        logAuthorizationDenied(req.path, req.agentId, req.params.chanId, getSocketAddress(req) || null);
        return err404NotFound(res, 'Channel', { see: 'GET /api/v1/channels/mine' });
      }
      const revenue = daemon.revenueTracker.getChannelRevenue(req.params.chanId);
      res.json(revenue);
    } catch (err) {
      console.error(`[market/revenue/:chanId] Error: ${err.message}`);
      res.status(500).json({ error: 'Internal error fetching channel revenue' });
    }
  });

  // Update market revenue config.
  // @agent-route {"auth":"agent","domain":"market","subgroup":"Revenue","label":"revenue-config","summary":"Update market revenue config.","order":420,"tags":["market","write","agent"],"doc":["skills/market-close.txt","skills/market.txt"],"security":{"moves_money":false,"requires_ownership":true,"requires_signature":false,"long_running":false}}
  router.put('/api/v1/market/revenue-config', auth, marketWrite, async (req, res) => {
    if (!daemon.revenueTracker) {
      return res.status(503).json({ error: 'Revenue tracker not initialized' });
    }
    try {
      const result = await daemon.revenueTracker.setRevenueConfig(req.agentId, req.body);
      if (result.success) {
        res.json(result);
      } else {
        res.status(400).json(result);
      }
    } catch (err) {
      console.error(`[market/revenue-config] Error: ${err.message}`);
      res.status(500).json({ error: 'Internal error updating revenue config' });
    }
  });

  // =========================================================================
  // Plan I: Submarine Swap
  // =========================================================================

  // Read market swap quote.
  // @agent-route {"auth":"agent","domain":"market","subgroup":"Swaps","label":"quote","summary":"Read market swap quote.","order":800,"tags":["market","read","agent"],"doc":["skills/market-swap-ecash-and-rebalance.txt","skills/market.txt"],"security":{"moves_money":false,"requires_ownership":true,"requires_signature":false,"long_running":false}}
  router.get('/api/v1/market/swap/quote', auth, marketPrivateRead, async (req, res) => {
    if (!daemon.swapProvider) {
      return res.status(503).json({ error: 'Swap provider not initialized' });
    }
    try {
      const amount = parseInt(req.query.amount_sats || '0', 10);
      const result = await daemon.swapProvider.getQuote(amount);
      if (result.success) {
        res.json(result);
      } else {
        res.status(400).json(result);
      }
    } catch (err) {
      console.error(`[market/swap/quote] Error: ${err.message}`);
      res.status(500).json({ error: 'Internal error fetching quote' });
    }
  });

  // Read market swap history.
  // @agent-route {"auth":"agent","domain":"market","subgroup":"Swaps","label":"history","summary":"Read market swap history.","order":830,"tags":["market","read","agent"],"doc":["skills/market-swap-ecash-and-rebalance.txt","skills/market.txt"],"security":{"moves_money":false,"requires_ownership":true,"requires_signature":false,"long_running":false}}
  router.get('/api/v1/market/swap/history', auth, marketPrivateRead, async (req, res) => {
    if (!daemon.swapProvider) {
      return res.status(503).json({ error: 'Swap provider not initialized' });
    }
    const history = daemon.swapProvider.getSwapHistory(req.agentId);
    res.json({
      agent_id: req.agentId,
      swaps: history,
      count: history.length,
    });
  });

  // =========================================================================
  // Plan J: Ecash Channel Funding
  // =========================================================================

  // =========================================================================
  // Plan G: Performance Dashboard
  // =========================================================================

  // Read market performance.
  // @agent-route {"auth":"agent","domain":"market","subgroup":"Performance","label":"performance","summary":"Read market performance.","order":500,"tags":["market","read","agent"],"doc":["skills/market-close.txt","skills/market.txt"],"security":{"moves_money":false,"requires_ownership":true,"requires_signature":false,"long_running":false}}
  router.get('/api/v1/market/performance', auth, marketPrivateRead, async (req, res) => {
    if (!daemon.performanceTracker) {
      return res.status(503).json({ error: 'Performance tracker not initialized' });
    }
    try {
      await daemon.channelCloser?.refreshNow?.();
      const result = await daemon.performanceTracker.getAgentPerformance(req.agentId);
      res.json(result);
    } catch (err) {
      console.error(`[market/performance] Error: ${err.message}`);
      res.status(500).json({ error: 'Internal error fetching performance' });
    }
  });

  // Read market performance by chanId.
  // @agent-route {"auth":"agent","domain":"market","subgroup":"Performance","label":"performance-by-channel","summary":"Read market performance by chanId.","order":510,"tags":["market","read","dynamic","agent"],"doc":["skills/market-close.txt","skills/market.txt"],"security":{"moves_money":false,"requires_ownership":true,"requires_signature":false,"long_running":false}}
  router.get('/api/v1/market/performance/:chanId', auth, marketPrivateRead, async (req, res) => {
    if (!daemon.performanceTracker) {
      return res.status(503).json({ error: 'Performance tracker not initialized' });
    }
    try {
      await daemon.channelCloser?.refreshNow?.();
      const result = await daemon.performanceTracker.getChannelPerformance(req.params.chanId, req.agentId);
      if (result.success === false) {
        return res.status(result.status || 400).json(result);
      }
      res.json(result);
    } catch (err) {
      console.error(`[market/performance/:chanId] Error: ${err.message}`);
      res.status(500).json({ error: 'Internal error fetching channel performance' });
    }
  });

  // =========================================================================
  // Plan H: Rebalancing
  // =========================================================================

  // Rebalance market.
  // @agent-route {"auth":"agent","domain":"market","subgroup":"Rebalancing","label":"rebalance","summary":"Rebalance market.","order":700,"tags":["market","write","agent"],"doc":["skills/market-swap-ecash-and-rebalance.txt","skills/market.txt"],"security":{"moves_money":true,"requires_ownership":true,"requires_signature":true,"long_running":true}}
  router.post('/api/v1/market/rebalance', auth, marketWrite, async (req, res) => {
    const unexpected = findUnexpectedKeys(req.body, ['instruction', 'signature', 'idempotency_key']);
    if (unexpected.length > 0) {
      return sendUnexpectedKeys(res, unexpected, 'POST /api/v1/market/rebalance/estimate');
    }
    if (!daemon.rebalanceExecutor) {
      return res.status(503).json({ error: 'Rebalance executor not initialized' });
    }
    return runIdempotentRoute({
      req,
      res,
      store: idempotencyStore,
      scope: 'market:rebalance',
      handler: async () => {
        if (typeof daemon.rebalanceExecutor.validateRequest === 'function') {
          const prevalidation = await daemon.rebalanceExecutor.validateRequest(req.agentId, req.body);
          if (!prevalidation?.success) {
            return {
              statusCode: prevalidation?.status || 400,
              body: prevalidation,
            };
          }
        }
        const amountSats = parseRebalanceAmount(req.body);
        const attempts = await checkAndIncrement(
          `danger:market_rebalance:attempt:${req.agentId}`,
          safety.market.rebalance.agentAttemptLimit,
          safety.market.rebalance.attemptWindowMs,
        );
        if (!attempts.allowed) {
          return {
            statusCode: 429,
            body: buildCooldownBody(
              'Too many rebalance attempts right now.',
              'Wait before trying another rebalance.',
            ),
          };
        }
        const sharedAttempts = await checkAndIncrement(
          'danger:market_rebalance:attempt:__shared__',
          safety.market.rebalance.sharedAttemptLimit,
          safety.market.rebalance.attemptWindowMs,
        );
        if (!sharedAttempts.allowed) {
          return {
            statusCode: 429,
            body: buildCooldownBody(
              'The node is handling too many rebalance attempts right now.',
              'Wait a bit, then try another rebalance.',
            ),
          };
        }
        const cooldown = await dangerPolicy.checkCooldown({
          scope: REBALANCE_CAPS.scope,
          agentId: req.agentId,
          cooldownMs: safety.market.rebalance.cooldownMs,
        });
        if (!cooldown.allowed) {
          return {
            statusCode: 429,
            body: buildCooldownBody(
              'A recent rebalance is still cooling down.',
              'Wait for the cooldown window to pass before rebalancing again.',
            ),
          };
        }
        const sharedCooldown = await sharedDangerCooldown({
          dangerPolicy,
          scope: REBALANCE_CAPS.scope,
          cooldownMs: safety.market.sharedSuccessCooldownMs,
        });
        if (!sharedCooldown.allowed) {
          return {
            statusCode: 429,
            body: buildCooldownBody(
              'The node is cooling down after a recent rebalance.',
              'Wait a bit before another agent starts a rebalance on this node.',
            ),
          };
        }
        if (Number.isInteger(amountSats) && amountSats > 0) {
          const policy = await applyMoneyPolicy({
            dangerPolicy,
            caps: { ...REBALANCE_CAPS, ...safety.market.rebalance.caps },
            agentId: req.agentId,
            amountSats,
          });
          if (policy) return policy;
        }
        const result = await daemon.rebalanceExecutor.requestRebalance(req.agentId, req.body);
        if (result?.success && Number.isInteger(amountSats) && amountSats > 0) {
          await dangerPolicy.recordSuccess({
            scope: REBALANCE_CAPS.scope,
            agentId: req.agentId,
            amountSats,
          });
          await dangerPolicy.recordSuccess({
            scope: REBALANCE_CAPS.scope,
            agentId: '__shared__',
          });
        }
        return { statusCode: result.success ? 200 : (result.status || 400), body: result };
      },
      onError: (err) => {
        console.error(`[market/rebalance] Error: ${err.message}`);
        return {
          statusCode: 500,
          body: withRecovery(
            { error: 'Internal error during rebalance' },
            'pending', 'The rebalance payment may be in-flight. Check rebalance history to verify.', [
              'GET /api/v1/market/rebalances to check if the rebalance completed',
              'GET /api/v1/capital/balance to verify your capital balance',
            ],
          ),
        };
      },
    });
  });

  // Estimate market rebalance.
  // @agent-route {"auth":"agent","domain":"market","subgroup":"Rebalancing","label":"estimate","summary":"Estimate market rebalance.","order":710,"tags":["market","write","agent"],"doc":["skills/market-swap-ecash-and-rebalance.txt","skills/market.txt"],"security":{"moves_money":false,"requires_ownership":true,"requires_signature":false,"long_running":false}}
  router.post('/api/v1/market/rebalance/estimate', auth, marketWrite, async (req, res) => {
    const unexpected = findUnexpectedKeys(req.body, ['outbound_chan_id', 'amount_sats']);
    if (unexpected.length > 0) {
      return sendUnexpectedKeys(res, unexpected, 'POST /api/v1/market/rebalance');
    }
    if (!daemon.rebalanceExecutor) {
      return res.status(503).json({ error: 'Rebalance executor not initialized' });
    }
    try {
      const estimateKey = `market-rebalance-estimate:${req.agentId}:${JSON.stringify(req.body || {})}`;
      const cached = rebalanceEstimateSingleFlight.getCached(estimateKey);
      if (cached) {
        return res.status(cached.statusCode).json(cached.body);
      }
      const attempts = await checkAndIncrement(
        `danger:market_rebalance_estimate:attempt:${req.agentId}`,
        safety.market.rebalanceEstimate.agentAttemptLimit,
        safety.market.rebalanceEstimate.attemptWindowMs,
      );
      if (!attempts.allowed) {
        return res.status(429).json(buildCooldownBody(
          'Too many rebalance-estimate attempts in a short window.',
          'Wait a bit before running another fee estimate.',
        ));
      }
      const sharedAttempts = await checkAndIncrement(
        'danger:market_rebalance_estimate:attempt:__shared__',
        safety.market.rebalanceEstimate.sharedAttemptLimit,
        safety.market.rebalanceEstimate.attemptWindowMs,
      );
      if (!sharedAttempts.allowed) {
        return res.status(429).json(buildCooldownBody(
          'The node is handling too many rebalance estimates right now.',
          'Wait a bit, then ask for another estimate.',
        ));
      }
      const response = await rebalanceEstimateSingleFlight.run(estimateKey, async () => {
        const result = await daemon.rebalanceExecutor.estimateRebalanceFee(req.agentId, req.body);
        return {
          statusCode: result.success ? 200 : (result.status || 400),
          body: result,
        };
      });
      res.status(response.statusCode).json(response.body);
    } catch (err) {
      console.error(`[market/rebalance/estimate] Error: ${err.message}`);
      res.status(500).json({ error: 'Internal error during fee estimation' });
    }
  });

  // Read market rebalances.
  // @agent-route {"auth":"agent","domain":"market","subgroup":"Rebalancing","label":"rebalances","summary":"Read market rebalances.","order":720,"tags":["market","read","agent"],"doc":["skills/market-swap-ecash-and-rebalance.txt","skills/market.txt"],"security":{"moves_money":false,"requires_ownership":true,"requires_signature":false,"long_running":false}}
  router.get('/api/v1/market/rebalances', auth, marketPrivateRead, async (req, res) => {
    if (!daemon.rebalanceExecutor) {
      return res.status(503).json({ error: 'Rebalance executor not initialized' });
    }
    try {
      const limit = parseInt(req.query.limit || '50', 10);
      const result = await daemon.rebalanceExecutor.getRebalanceHistory(req.agentId, limit);
      res.json(result);
    } catch (err) {
      console.error(`[market/rebalances] Error: ${err.message}`);
      res.status(500).json({ error: 'Internal error fetching rebalance history' });
    }
  });

  // =========================================================================
  // Plan N: Market Transparency (public, rate limited)
  // =========================================================================

  // Plan G: Rankings (public, rate limited)
  // Read market rankings.
  // @agent-route {"auth":"public","domain":"market","subgroup":"Market Reads","label":"rankings","summary":"Read market rankings.","order":110,"tags":["market","read","public"],"doc":["skills/market-public-market-read.txt","skills/market.txt"],"security":{"moves_money":false,"requires_ownership":false,"requires_signature":false,"long_running":false}}
  router.get('/api/v1/market/rankings', marketRL, (req, res) => {
    if (!daemon.performanceTracker) {
      return res.status(503).json({ error: 'Performance tracker not initialized' });
    }
    try {
      const metric = req.query.metric || 'fees';
      const limit = parseInt(req.query.limit || '10', 10);
      const result = daemon.performanceTracker.getLeaderboard(metric, limit);
      if (result.success === false) {
        return res.status(result.status || 400).json(result);
      }
      res.json(result);
    } catch (err) {
      console.error(`[market/rankings] Error: ${err.message}`);
      res.status(500).json({ error: 'Internal error fetching rankings' });
    }
  });

  // Read market overview.
  // @agent-route {"auth":"public","domain":"market","subgroup":"Market Reads","label":"overview","summary":"Read market overview.","order":120,"tags":["market","read","public"],"doc":["skills/market-public-market-read.txt","skills/market.txt"],"security":{"moves_money":false,"requires_ownership":false,"requires_signature":false,"long_running":false}}
  router.get('/api/v1/market/overview', marketRL, async (req, res) => {
    if (!daemon.marketTransparency) {
      return res.status(503).json({ error: 'Market transparency not initialized' });
    }
    try {
      const overview = await daemon.marketTransparency.getOverview();
      res.json(overview);
    } catch (err) {
      console.error(`[market/overview] Error: ${err.message}`);
      res.status(500).json({ error: 'Internal error fetching overview' });
    }
  });

  // Read market channels.
  // @agent-route {"auth":"public","domain":"market","subgroup":"Market Reads","label":"channels","summary":"Read market channels.","order":130,"tags":["market","read","public"],"doc":["skills/market-public-market-read.txt","skills/market.txt"],"security":{"moves_money":false,"requires_ownership":false,"requires_signature":false,"long_running":false}}
  router.get('/api/v1/market/channels', marketRL, async (req, res) => {
    if (!daemon.marketTransparency) {
      return res.status(503).json({ error: 'Market transparency not initialized' });
    }
    try {
      const limit = Math.min(parseInt(req.query.limit || '50', 10), 100);
      const offset = parseInt(req.query.offset || '0', 10);
      const result = await daemon.marketTransparency.getChannels({ limit, offset });
      res.json(result);
    } catch (err) {
      console.error(`[market/channels] Error: ${err.message}`);
      res.status(500).json({ error: 'Internal error fetching channels' });
    }
  });

  // Read market agent by agentId.
  // @agent-route {"auth":"public","domain":"market","subgroup":"Market Reads","label":"agent-profile","summary":"Read market agent by agentId.","order":140,"tags":["market","read","dynamic","public"],"doc":["skills/market-public-market-read.txt","skills/market.txt"],"security":{"moves_money":false,"requires_ownership":false,"requires_signature":false,"long_running":false}}
  router.get('/api/v1/market/agent/:agentId', marketRL, async (req, res) => {
    if (!daemon.marketTransparency) {
      return res.status(503).json({ error: 'Market transparency not initialized' });
    }
    try {
      const result = await daemon.marketTransparency.getAgentProfile(req.params.agentId);
      if (result.success === false) {
        return res.status(result.status || 404).json(result);
      }
      res.json(result);
    } catch (err) {
      console.error(`[market/agent] Error: ${err.message}`);
      res.status(500).json({ error: 'Internal error fetching agent profile' });
    }
  });

  // Read market peer safety by pubkey.
  // @agent-route {"auth":"public","domain":"market","subgroup":"Market Reads","label":"peer-safety","summary":"Read market peer safety by pubkey.","order":150,"tags":["market","read","dynamic","public"],"doc":["skills/market-public-market-read.txt","skills/market.txt"],"security":{"moves_money":false,"requires_ownership":false,"requires_signature":false,"long_running":false}}
  router.get('/api/v1/market/peer-safety/:pubkey', marketRL, async (req, res) => {
    if (!daemon.marketTransparency) {
      return res.status(503).json({ error: 'Market transparency not initialized' });
    }
    try {
      const result = await daemon.marketTransparency.getPeerSafety(req.params.pubkey);
      if (result.success === false) {
        return res.status(result.status || 400).json(result);
      }
      res.json(result);
    } catch (err) {
      console.error(`[market/peer-safety] Error: ${err.message}`);
      res.status(500).json({ error: 'Internal error fetching peer safety' });
    }
  });

  // Read market fees by peerPubkey.
  // @agent-route {"auth":"public","domain":"market","subgroup":"Market Reads","label":"fee-competition","summary":"Read market fees by peerPubkey.","order":160,"tags":["market","read","dynamic","public"],"doc":["skills/market-public-market-read.txt","skills/market.txt"],"security":{"moves_money":false,"requires_ownership":false,"requires_signature":false,"long_running":false}}
  router.get('/api/v1/market/fees/:peerPubkey', marketRL, async (req, res) => {
    if (!daemon.marketTransparency) {
      return res.status(503).json({ error: 'Market transparency not initialized' });
    }
    try {
      const result = await daemon.marketTransparency.getFeeCompetition(req.params.peerPubkey);
      if (result.success === false) {
        return res.status(result.status || 400).json(result);
      }
      res.json(result);
    } catch (err) {
      console.error(`[market/fees] Error: ${err.message}`);
      res.status(500).json({ error: 'Internal error fetching fee competition' });
    }
  });

  return router;
}
