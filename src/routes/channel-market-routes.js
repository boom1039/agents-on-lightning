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
 *   POST /api/v1/market/swap/lightning-to-onchain   — Initiate swap
 *   GET  /api/v1/market/swap/status/:swapId         — Check swap status
 *   GET  /api/v1/market/swap/history                — Past swaps
 *
 * Plan J: Ecash Channel Funding
 *   POST /api/v1/market/fund-from-ecash      — One-click ecash → channel
 *   GET  /api/v1/market/fund-from-ecash/:id  — Check flow status
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

function submarineSwapsEnabled() {
  return process.env.ENABLE_SUBMARINE_SWAPS === '1';
}

const HOUR_MS = 60 * 60 * 1000;
const FIFTEEN_MIN_MS = 15 * 60 * 1000;
const SHARED_MARKET_SUCCESS_COOLDOWN_MS = 5 * 60 * 1000;
const MAX_PENDING_MARKET_OPS = 2;
const SHARED_MARKET_OPEN_ATTEMPT_LIMIT = 12;
const SHARED_MARKET_CLOSE_ATTEMPT_LIMIT = 12;
const SHARED_MARKET_REBALANCE_ATTEMPT_LIMIT = 12;
const SHARED_MARKET_SWAP_ATTEMPT_LIMIT = 12;
const SHARED_MARKET_FUND_FROM_ECASH_ATTEMPT_LIMIT = 12;
const EXPENSIVE_RESULT_CACHE_TTL_MS = 5_000;
const OPEN_CAPS = {
  scope: 'market_open',
  autoApproveSats: null,
  hardCapSats: null,
  dailyAutoApproveSats: null,
  dailyHardCapSats: null,
  sharedDailyAutoApproveSats: null,
  sharedDailyHardCapSats: null,
};
const SWAP_CAPS = {
  scope: 'market_swap',
  autoApproveSats: 50_000,
  hardCapSats: 100_000,
  dailyAutoApproveSats: 250_000,
  dailyHardCapSats: 500_000,
  sharedDailyAutoApproveSats: 250_000,
  sharedDailyHardCapSats: 500_000,
};
const FUND_FROM_ECASH_CAPS = {
  scope: 'market_fund_from_ecash',
  autoApproveSats: null,
  hardCapSats: null,
  dailyAutoApproveSats: null,
  dailyHardCapSats: null,
  sharedDailyAutoApproveSats: null,
  sharedDailyHardCapSats: null,
};
const REBALANCE_CAPS = {
  scope: 'market_rebalance',
  autoApproveSats: null,
  hardCapSats: null,
  dailyAutoApproveSats: null,
  dailyHardCapSats: null,
  sharedDailyAutoApproveSats: null,
  sharedDailyHardCapSats: null,
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
  requestedSats,
  instantLimitSats,
  total24hSats,
  rollingLimitSats,
}) {
  return {
    statusCode: 202,
    body: {
      status: 202,
      review_required: true,
      message,
      hint,
      requested_sats: requestedSats,
      instant_limit_sats: instantLimitSats,
      rolling_24h_sats: total24hSats,
      rolling_24h_limit_sats: rollingLimitSats,
    },
  };
}

function sendCapExceededResult({
  message,
  hint,
  requestedSats,
  instantLimitSats,
  total24hSats,
  rollingLimitSats,
}) {
  return {
    statusCode: 403,
    body: {
      error: 'cap_exceeded',
      message,
      hint,
      requested_sats: requestedSats,
      instant_limit_sats: instantLimitSats,
      rolling_24h_sats: total24hSats,
      rolling_24h_limit_sats: rollingLimitSats,
    },
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
  const rollingUsed = sharedReason ? decision.sharedTotal24h : decision.total24h;
  const rollingLimit = sharedReason
    ? (decision.decision === 'hard_cap' ? caps.sharedDailyHardCapSats : caps.sharedDailyAutoApproveSats)
    : (decision.decision === 'hard_cap' ? caps.dailyHardCapSats : caps.dailyAutoApproveSats);
  if (decision.decision === 'hard_cap') {
    return sendCapExceededResult({
      message: sharedReason ? 'This request is above the shared-node safety cap.' : 'This request is above the safety cap.',
      hint: sharedReason ? 'Use a smaller amount, or wait for the shared-node budget window to reset.' : 'Use a smaller amount.',
      requestedSats: amountSats,
      instantLimitSats: caps.autoApproveSats,
      total24hSats: rollingUsed,
      rollingLimitSats: rollingLimit,
    });
  }
  if (decision.decision === 'review_required') {
    return sendReviewRequiredResult({
      message: sharedReason ? 'This request is above the shared-node instant-approve limit.' : 'This request is above the instant-approve limit.',
      hint: sharedReason ? 'Use a smaller amount, or wait for the shared-node budget window to reset.' : 'Use a smaller amount, or wait for manual review.',
      requestedSats: amountSats,
      instantLimitSats: caps.autoApproveSats,
      total24hSats: rollingUsed,
      rollingLimitSats: rollingLimit,
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
  const previewSingleFlight = createShortTtlSingleFlight();
  const rebalanceEstimateSingleFlight = createShortTtlSingleFlight();

  // =========================================================================
  // Plan D: Channel Open
  // =========================================================================

  router.get('/api/v1/market/config', marketRL, (req, res) => {
    if (!daemon.channelOpener) {
      return res.status(503).json({ error: 'Channel opener not initialized' });
    }
    res.json(daemon.channelOpener.getConfig());
  });

  router.get('/api/v1/market/preview', auth, marketPrivateRead, (_req, res) => {
    agentError(res, 405, {
      error: 'method_not_allowed',
      message: 'Use POST, not GET. This endpoint validates a channel open request.',
      hint: 'POST /api/v1/market/preview with a signed instruction. See GET /api/v1/market/config for requirements.',
      see: 'GET /api/v1/market/config',
    });
  });

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
      const attempts = await checkAndIncrement(`danger:market_preview:attempt:${req.agentId}`, 6, FIFTEEN_MIN_MS);
      if (!attempts.allowed) {
        return res.status(429).json({
          error: 'cooldown_active',
          message: 'Too many market preview attempts in a short window.',
          retryable: true,
          retry_after_seconds: attempts.retryAfter,
          hint: 'Wait a bit before running another preview.',
        });
      }
      const sharedAttempts = await checkAndIncrement('danger:market_preview:attempt:__shared__', 24, FIFTEEN_MIN_MS);
      if (!sharedAttempts.allowed) {
        return res.status(429).json({
          error: 'cooldown_active',
          message: 'The node is handling too many market previews right now.',
          retryable: true,
          retry_after_seconds: sharedAttempts.retryAfter,
          hint: 'Wait a bit, then try your preview again.',
        });
      }
      const amountSats = parseFundingAmount(req.body);
      if (Number.isInteger(amountSats) && amountSats > 0) {
        const policy = await applyMoneyPolicy({
          dangerPolicy,
          caps: OPEN_CAPS,
          agentId: req.agentId,
          amountSats,
        });
        if (policy) {
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

  router.get('/api/v1/market/open', auth, marketPrivateRead, (_req, res) => {
    agentError(res, 405, {
      error: 'method_not_allowed',
      message: 'Use POST, not GET. This endpoint opens a channel.',
      hint: 'POST /api/v1/market/open with a signed instruction. Preview first: POST /api/v1/market/preview.',
      see: 'POST /api/v1/market/preview',
    });
  });

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
        const attempts = await checkAndIncrement(`danger:market_open:attempt:${req.agentId}`, 3, HOUR_MS);
        if (!attempts.allowed) {
          return {
            statusCode: 429,
            body: {
              error: 'cooldown_active',
              message: 'Too many channel-open attempts this hour.',
              retryable: true,
              retry_after_seconds: attempts.retryAfter,
              hint: 'Wait before trying another channel open.',
            },
          };
        }
        const sharedAttempts = await checkAndIncrement('danger:market_open:attempt:__shared__', SHARED_MARKET_OPEN_ATTEMPT_LIMIT, HOUR_MS);
        if (!sharedAttempts.allowed) {
          return {
            statusCode: 429,
            body: {
              error: 'cooldown_active',
              message: 'The node is handling too many channel-open attempts right now.',
              retryable: true,
              retry_after_seconds: sharedAttempts.retryAfter,
              hint: 'Wait a bit, then try another channel open.',
            },
          };
        }
        const cooldown = await dangerPolicy.checkCooldown({
          scope: OPEN_CAPS.scope,
          agentId: req.agentId,
          cooldownMs: FIFTEEN_MIN_MS,
        });
        if (!cooldown.allowed) {
          return {
            statusCode: 429,
            body: {
              error: 'cooldown_active',
              message: 'A recent channel open is still cooling down.',
              retryable: true,
              retry_after_seconds: cooldown.retryAfterSeconds,
              hint: 'Wait for the cooldown window to pass before opening another channel.',
            },
          };
        }
        const sharedCooldown = await sharedDangerCooldown({
          dangerPolicy,
          scope: OPEN_CAPS.scope,
          cooldownMs: SHARED_MARKET_SUCCESS_COOLDOWN_MS,
        });
        if (!sharedCooldown.allowed) {
          return {
            statusCode: 429,
            body: {
              error: 'cooldown_active',
              message: 'The node is cooling down after a recent channel open.',
              retryable: true,
              retry_after_seconds: sharedCooldown.retryAfterSeconds,
              hint: 'Wait a bit before another agent opens a new channel on this node.',
            },
          };
        }
        if (getPendingItems(daemon.channelOpener, req.agentId).length >= MAX_PENDING_MARKET_OPS) {
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
            caps: OPEN_CAPS,
            agentId: req.agentId,
            amountSats,
          });
          if (policy) return policy;
        }
        const result = await daemon.channelOpener.open(req.agentId, req.body);
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

  router.get('/api/v1/market/close', auth, marketPrivateRead, (_req, res) => {
    agentError(res, 405, {
      error: 'method_not_allowed',
      message: 'Use POST, not GET. This endpoint closes a channel.',
      hint: 'POST /api/v1/market/close with a signed instruction containing "action": "channel_close" and "params": {"channel_point": "..."}',
      see: 'GET /api/v1/market/closes',
    });
  });

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
        const attempts = await checkAndIncrement(`danger:market_close:attempt:${req.agentId}`, 3, HOUR_MS);
        if (!attempts.allowed) {
          return {
            statusCode: 429,
            body: {
              error: 'cooldown_active',
              message: 'Too many close attempts this hour.',
              retryable: true,
              retry_after_seconds: attempts.retryAfter,
              hint: 'Wait before trying another channel close.',
            },
          };
        }
        const sharedAttempts = await checkAndIncrement('danger:market_close:attempt:__shared__', SHARED_MARKET_CLOSE_ATTEMPT_LIMIT, HOUR_MS);
        if (!sharedAttempts.allowed) {
          return {
            statusCode: 429,
            body: {
              error: 'cooldown_active',
              message: 'The node is handling too many channel-close attempts right now.',
              retryable: true,
              retry_after_seconds: sharedAttempts.retryAfter,
              hint: 'Wait a bit, then try another channel close.',
            },
          };
        }
        const cooldown = await dangerPolicy.checkCooldown({
          scope: 'market_close',
          agentId: req.agentId,
          cooldownMs: FIFTEEN_MIN_MS,
        });
        if (!cooldown.allowed) {
          return {
            statusCode: 429,
            body: {
              error: 'cooldown_active',
              message: 'A recent channel close is still cooling down.',
              retryable: true,
              retry_after_seconds: cooldown.retryAfterSeconds,
              hint: 'Wait for the cooldown window to pass before closing another channel.',
            },
          };
        }
        const sharedCooldown = await sharedDangerCooldown({
          dangerPolicy,
          scope: 'market_close',
          cooldownMs: SHARED_MARKET_SUCCESS_COOLDOWN_MS,
        });
        if (!sharedCooldown.allowed) {
          return {
            statusCode: 429,
            body: {
              error: 'cooldown_active',
              message: 'The node is cooling down after a recent channel close.',
              retryable: true,
              retry_after_seconds: sharedCooldown.retryAfterSeconds,
              hint: 'Wait a bit before another agent closes a channel on this node.',
            },
          };
        }
        if (getPendingItems(daemon.channelCloser, req.agentId).length >= MAX_PENDING_MARKET_OPS) {
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
        if (result?.success) {
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
        return { statusCode: result.success ? 200 : (result.status || 400), body: closeBody };
      },
      onError: (err) => {
        console.error(`[market/close] Error: ${err.message}`);
        return {
          statusCode: 500,
          body: withRecovery(
            { error: 'Internal error during channel close' },
            'safe', 'The channel is still open. No funds were moved by this failed close request.', [
              'GET /api/v1/market/closes to check if the close was already initiated',
              'Retry POST /api/v1/market/close with the same signed instruction',
            ],
          ),
        };
      },
    });
  });

  router.get('/api/v1/market/closes', auth, marketPrivateRead, async (req, res) => {
    if (!daemon.channelCloser) {
      return res.status(503).json({ error: 'Channel closer not initialized' });
    }
    try {
      const closes = daemon.channelCloser.getClosesForAgent(req.agentId);
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

  router.post('/api/v1/market/swap/lightning-to-onchain', auth, marketWrite, async (req, res) => {
    const unexpected = findUnexpectedKeys(req.body, ['amount_sats', 'onchain_address', 'idempotency_key']);
    if (unexpected.length > 0) {
      return sendUnexpectedKeys(res, unexpected, 'GET /api/v1/market/swap/quote');
    }
    if (!submarineSwapsEnabled()) {
      return agentError(res, 503, {
        error: 'submarine_swaps_disabled',
        message: 'Submarine swaps are disabled until the funding flow is hardened.',
        hint: 'This route is intentionally off for safety because it can spend node funds.',
      });
    }
    if (!daemon.swapProvider) {
      return res.status(503).json({ error: 'Swap provider not initialized' });
    }
    return runIdempotentRoute({
      req,
      res,
      store: idempotencyStore,
      scope: 'market:swap:create',
      handler: async () => {
        const amountSats = req.body?.amount_sats;
        const attempts = await checkAndIncrement(`danger:market_swap:attempt:${req.agentId}`, 3, HOUR_MS);
        if (!attempts.allowed) {
          return {
            statusCode: 429,
            body: {
              error: 'cooldown_active',
              message: 'Too many swap attempts this hour.',
              retryable: true,
              retry_after_seconds: attempts.retryAfter,
              hint: 'Wait before trying another swap.',
            },
          };
        }
        const sharedAttempts = await checkAndIncrement('danger:market_swap:attempt:__shared__', SHARED_MARKET_SWAP_ATTEMPT_LIMIT, HOUR_MS);
        if (!sharedAttempts.allowed) {
          return {
            statusCode: 429,
            body: {
              error: 'cooldown_active',
              message: 'The node is handling too many swap attempts right now.',
              retryable: true,
              retry_after_seconds: sharedAttempts.retryAfter,
              hint: 'Wait a bit, then try another swap.',
            },
          };
        }
        const cooldown = await dangerPolicy.checkCooldown({
          scope: SWAP_CAPS.scope,
          agentId: req.agentId,
          cooldownMs: FIFTEEN_MIN_MS,
        });
        if (!cooldown.allowed) {
          return {
            statusCode: 429,
            body: {
              error: 'cooldown_active',
              message: 'A recent swap is still cooling down.',
              retryable: true,
              retry_after_seconds: cooldown.retryAfterSeconds,
              hint: 'Wait for the cooldown window to pass before swapping again.',
            },
          };
        }
        const sharedCooldown = await sharedDangerCooldown({
          dangerPolicy,
          scope: SWAP_CAPS.scope,
          cooldownMs: SHARED_MARKET_SUCCESS_COOLDOWN_MS,
        });
        if (!sharedCooldown.allowed) {
          return {
            statusCode: 429,
            body: {
              error: 'cooldown_active',
              message: 'The node is cooling down after a recent swap.',
              retryable: true,
              retry_after_seconds: sharedCooldown.retryAfterSeconds,
              hint: 'Wait a bit before another agent starts a swap on this node.',
            },
          };
        }
        if (Number.isInteger(amountSats) && amountSats > 0) {
          const policy = await applyMoneyPolicy({
            dangerPolicy,
            caps: SWAP_CAPS,
            agentId: req.agentId,
            amountSats,
          });
          if (policy) return policy;
        }
        const result = await daemon.swapProvider.createSwap(req.agentId, req.body);
        if (result?.success && Number.isInteger(amountSats) && amountSats > 0) {
          await dangerPolicy.recordSuccess({
            scope: SWAP_CAPS.scope,
            agentId: req.agentId,
            amountSats,
          });
          await dangerPolicy.recordSuccess({
            scope: SWAP_CAPS.scope,
            agentId: '__shared__',
          });
        }
        return { statusCode: result.success ? 200 : (result.status || 400), body: result };
      },
      onError: (err) => {
        console.error(`[market/swap/create] Error: ${err.message}`);
        return {
          statusCode: 500,
          body: withRecovery(
            { error: 'Internal error creating swap' },
            'pending', 'The swap may have been initiated. Check swap history to verify.', [
              'GET /api/v1/market/swap/history to check if the swap was created',
              'GET /api/v1/capital/balance to verify your capital balance',
            ],
          ),
        };
      },
    });
  });

  router.get('/api/v1/market/swap/status/:swapId', auth, marketPrivateRead, async (req, res) => {
    if (!daemon.swapProvider) {
      return res.status(503).json({ error: 'Swap provider not initialized' });
    }
    const status = daemon.swapProvider.getSwapStatus(req.params.swapId);
    if (!status || status.agent_id !== req.agentId) {
      logAuthorizationDenied(req.path, req.agentId, req.params.swapId, getSocketAddress(req) || null);
      return err404NotFound(res, 'Swap');
    }
    res.json(status);
  });

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

  router.post('/api/v1/market/fund-from-ecash', auth, marketWrite, async (req, res) => {
    return agentError(res, 503, {
      error: 'ecash_funding_disabled',
      message: 'Ecash-to-channel funding is temporarily disabled. Please use on-chain funding instead.',
      hint: 'Deposit on-chain BTC via POST /api/v1/capital/deposit-address, then open a channel with POST /api/v1/market/open.',
      see: '/api/v1/skills/market',
    });
    const unexpected = findUnexpectedKeys(req.body, ['instruction', 'signature', 'idempotency_key']);
    if (unexpected.length > 0) {
      return sendUnexpectedKeys(res, unexpected, 'GET /api/v1/wallet/balance');
    }
    if (!daemon.ecashChannelFunder) {
      return res.status(503).json({ error: 'Ecash channel funder not initialized' });
    }
    return runIdempotentRoute({
      req,
      res,
      store: idempotencyStore,
      scope: 'market:fund-from-ecash',
      handler: async () => {
        const amountSats = parseFundingAmount(req.body);
        const attempts = await checkAndIncrement(`danger:market_fund_from_ecash:attempt:${req.agentId}`, 3, HOUR_MS);
        if (!attempts.allowed) {
          return {
            statusCode: 429,
            body: {
              error: 'cooldown_active',
              message: 'Too many ecash funding attempts this hour.',
              retryable: true,
              retry_after_seconds: attempts.retryAfter,
              hint: 'Wait before trying another ecash-funded channel open.',
            },
          };
        }
        const sharedAttempts = await checkAndIncrement('danger:market_fund_from_ecash:attempt:__shared__', SHARED_MARKET_FUND_FROM_ECASH_ATTEMPT_LIMIT, HOUR_MS);
        if (!sharedAttempts.allowed) {
          return {
            statusCode: 429,
            body: {
              error: 'cooldown_active',
              message: 'The node is handling too many ecash-funded channel opens right now.',
              retryable: true,
              retry_after_seconds: sharedAttempts.retryAfter,
              hint: 'Wait a bit, then try another ecash-funded channel open.',
            },
          };
        }
        const cooldown = await dangerPolicy.checkCooldown({
          scope: FUND_FROM_ECASH_CAPS.scope,
          agentId: req.agentId,
          cooldownMs: FIFTEEN_MIN_MS,
        });
        if (!cooldown.allowed) {
          return {
            statusCode: 429,
            body: {
              error: 'cooldown_active',
              message: 'A recent ecash-funded channel open is still cooling down.',
              retryable: true,
              retry_after_seconds: cooldown.retryAfterSeconds,
              hint: 'Wait for the cooldown window to pass before funding another channel from ecash.',
            },
          };
        }
        const sharedCooldown = await sharedDangerCooldown({
          dangerPolicy,
          scope: FUND_FROM_ECASH_CAPS.scope,
          cooldownMs: SHARED_MARKET_SUCCESS_COOLDOWN_MS,
        });
        if (!sharedCooldown.allowed) {
          return {
            statusCode: 429,
            body: {
              error: 'cooldown_active',
              message: 'The node is cooling down after a recent ecash-funded channel open.',
              retryable: true,
              retry_after_seconds: sharedCooldown.retryAfterSeconds,
              hint: 'Wait a bit before another agent funds a channel from ecash on this node.',
            },
          };
        }
        if (getPendingItems(daemon.ecashChannelFunder, req.agentId).length >= MAX_PENDING_MARKET_OPS) {
          return {
            statusCode: 429,
            body: {
              error: 'too_many_pending_operations',
              message: 'You already have too many pending market actions.',
              hint: 'Wait for a pending ecash funding flow to settle before starting another.',
            },
          };
        }
        if (Number.isInteger(amountSats) && amountSats > 0) {
          const policy = await applyMoneyPolicy({
            dangerPolicy,
            caps: FUND_FROM_ECASH_CAPS,
            agentId: req.agentId,
            amountSats,
          });
          if (policy) return policy;
        }
        const result = await daemon.ecashChannelFunder.fundChannelFromEcash(req.agentId, req.body);
        if (result?.success && Number.isInteger(amountSats) && amountSats > 0) {
          await dangerPolicy.recordSuccess({
            scope: FUND_FROM_ECASH_CAPS.scope,
            agentId: req.agentId,
            amountSats,
          });
          await dangerPolicy.recordSuccess({
            scope: FUND_FROM_ECASH_CAPS.scope,
            agentId: '__shared__',
          });
        }
        return { statusCode: result.success ? 200 : (result.status || 400), body: result };
      },
      onError: (err) => {
        console.error(`[market/fund-from-ecash] Error: ${err.message}`);
        return {
          statusCode: 500,
          body: withRecovery(
            { error: 'Internal error during ecash channel funding' },
            'action_needed', 'Ecash may have been melted before the channel open failed. Check your balances.', [
              'GET /api/v1/wallet/balance to check ecash balance',
              'GET /api/v1/capital/balance to check if capital was credited',
              'GET /api/v1/market/pending to check if a channel open is in progress',
            ],
          ),
        };
      },
    });
  });

  router.get('/api/v1/market/fund-from-ecash/:flowId', auth, marketPrivateRead, async (req, res) => {
    if (!daemon.ecashChannelFunder) {
      return res.status(503).json({ error: 'Ecash channel funder not initialized' });
    }
    const status = daemon.ecashChannelFunder.getFlowStatus(req.params.flowId);
    if (!status || status.agent_id !== req.agentId) {
      logAuthorizationDenied(req.path, req.agentId, req.params.flowId, getSocketAddress(req) || null);
      return err404NotFound(res, 'Funding flow');
    }
    res.json(status);
  });

  // =========================================================================
  // Plan G: Performance Dashboard
  // =========================================================================

  router.get('/api/v1/market/performance', auth, marketPrivateRead, async (req, res) => {
    if (!daemon.performanceTracker) {
      return res.status(503).json({ error: 'Performance tracker not initialized' });
    }
    try {
      const result = await daemon.performanceTracker.getAgentPerformance(req.agentId);
      res.json(result);
    } catch (err) {
      console.error(`[market/performance] Error: ${err.message}`);
      res.status(500).json({ error: 'Internal error fetching performance' });
    }
  });

  router.get('/api/v1/market/performance/:chanId', auth, marketPrivateRead, async (req, res) => {
    if (!daemon.performanceTracker) {
      return res.status(503).json({ error: 'Performance tracker not initialized' });
    }
    try {
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
        const attempts = await checkAndIncrement(`danger:market_rebalance:attempt:${req.agentId}`, 3, HOUR_MS);
        if (!attempts.allowed) {
          return {
            statusCode: 429,
            body: {
              error: 'cooldown_active',
              message: 'Too many rebalance attempts this hour.',
              retryable: true,
              retry_after_seconds: attempts.retryAfter,
              hint: 'Wait before trying another rebalance.',
            },
          };
        }
        const sharedAttempts = await checkAndIncrement('danger:market_rebalance:attempt:__shared__', SHARED_MARKET_REBALANCE_ATTEMPT_LIMIT, HOUR_MS);
        if (!sharedAttempts.allowed) {
          return {
            statusCode: 429,
            body: {
              error: 'cooldown_active',
              message: 'The node is handling too many rebalance attempts right now.',
              retryable: true,
              retry_after_seconds: sharedAttempts.retryAfter,
              hint: 'Wait a bit, then try another rebalance.',
            },
          };
        }
        const cooldown = await dangerPolicy.checkCooldown({
          scope: REBALANCE_CAPS.scope,
          agentId: req.agentId,
          cooldownMs: FIFTEEN_MIN_MS,
        });
        if (!cooldown.allowed) {
          return {
            statusCode: 429,
            body: {
              error: 'cooldown_active',
              message: 'A recent rebalance is still cooling down.',
              retryable: true,
              retry_after_seconds: cooldown.retryAfterSeconds,
              hint: 'Wait for the cooldown window to pass before rebalancing again.',
            },
          };
        }
        const sharedCooldown = await sharedDangerCooldown({
          dangerPolicy,
          scope: REBALANCE_CAPS.scope,
          cooldownMs: SHARED_MARKET_SUCCESS_COOLDOWN_MS,
        });
        if (!sharedCooldown.allowed) {
          return {
            statusCode: 429,
            body: {
              error: 'cooldown_active',
              message: 'The node is cooling down after a recent rebalance.',
              retryable: true,
              retry_after_seconds: sharedCooldown.retryAfterSeconds,
              hint: 'Wait a bit before another agent starts a rebalance on this node.',
            },
          };
        }
        if (Number.isInteger(amountSats) && amountSats > 0) {
          const policy = await applyMoneyPolicy({
            dangerPolicy,
            caps: REBALANCE_CAPS,
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
      const attempts = await checkAndIncrement(`danger:market_rebalance_estimate:attempt:${req.agentId}`, 6, FIFTEEN_MIN_MS);
      if (!attempts.allowed) {
        return res.status(429).json({
          error: 'cooldown_active',
          message: 'Too many rebalance-estimate attempts in a short window.',
          retryable: true,
          retry_after_seconds: attempts.retryAfter,
          hint: 'Wait a bit before running another fee estimate.',
        });
      }
      const sharedAttempts = await checkAndIncrement('danger:market_rebalance_estimate:attempt:__shared__', 24, FIFTEEN_MIN_MS);
      if (!sharedAttempts.allowed) {
        return res.status(429).json({
          error: 'cooldown_active',
          message: 'The node is handling too many rebalance estimates right now.',
          retryable: true,
          retry_after_seconds: sharedAttempts.retryAfter,
          hint: 'Wait a bit, then ask for another estimate.',
        });
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
