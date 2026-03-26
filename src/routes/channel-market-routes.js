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
import { rateLimit } from '../identity/rate-limiter.js';
import { agentError } from '../identity/agent-friendly-errors.js';

export function channelMarketRoutes(daemon) {
  const router = Router();
  const auth = requireAuth(daemon.agentRegistry);

  // =========================================================================
  // Plan D: Channel Open
  // =========================================================================

  router.get('/api/v1/market/config', (req, res) => {
    if (!daemon.channelOpener) {
      return res.status(503).json({ error: 'Channel opener not initialized' });
    }
    res.json(daemon.channelOpener.getConfig());
  });

  router.get('/api/v1/market/preview', auth, (_req, res) => {
    agentError(res, 405, {
      error: 'method_not_allowed',
      message: 'Use POST, not GET. This endpoint validates a channel open request.',
      hint: 'POST /api/v1/market/preview with a signed instruction. See GET /api/v1/market/config for requirements.',
      see: 'GET /api/v1/market/config',
    });
  });

  router.post('/api/v1/market/preview', auth, async (req, res) => {
    if (!daemon.channelOpener) {
      return res.status(503).json({ error: 'Channel opener not initialized' });
    }
    try {
      const result = await daemon.channelOpener.preview(req.agentId, req.body);
      res.status(result.valid ? 200 : (result.status || 400)).json(result);
    } catch (err) {
      console.error(`[market/preview] Error: ${err.message}`);
      res.status(500).json({ error: 'Internal error during preview' });
    }
  });

  router.get('/api/v1/market/open', auth, (_req, res) => {
    agentError(res, 405, {
      error: 'method_not_allowed',
      message: 'Use POST, not GET. This endpoint opens a channel.',
      hint: 'POST /api/v1/market/open with a signed instruction. Preview first: POST /api/v1/market/preview.',
      see: 'POST /api/v1/market/preview',
    });
  });

  router.post('/api/v1/market/open', auth, async (req, res) => {
    if (!daemon.channelOpener) {
      return res.status(503).json({ error: 'Channel opener not initialized' });
    }
    try {
      const result = await daemon.channelOpener.open(req.agentId, req.body);
      if (result.success) {
        res.status(200).json(result);
      } else {
        res.status(result.status || 400).json(result);
      }
    } catch (err) {
      console.error(`[market/open] Error: ${err.message}`);
      res.status(500).json({ error: 'Internal error during channel open' });
    }
  });

  router.get('/api/v1/market/pending', auth, async (req, res) => {
    if (!daemon.channelOpener) {
      return res.status(503).json({ error: 'Channel opener not initialized' });
    }
    try {
      const pending = daemon.channelOpener.getPendingForAgent(req.agentId);
      res.json({
        agent_id: req.agentId,
        pending_opens: pending,
        count: pending.length,
        learn: pending.length > 0
          ? 'Your pending channel opens are listed above. Once a funding transaction confirms ' +
            '(~3 blocks / ~30 min), the channel will be auto-assigned to you and appear in ' +
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

  router.get('/api/v1/market/close', auth, (_req, res) => {
    agentError(res, 405, {
      error: 'method_not_allowed',
      message: 'Use POST, not GET. This endpoint closes a channel.',
      hint: 'POST /api/v1/market/close with a signed instruction containing "action": "channel_close" and "params": {"channel_id": "..."}.',
      see: 'GET /api/v1/market/closes',
    });
  });

  router.post('/api/v1/market/close', auth, async (req, res) => {
    if (!daemon.channelCloser) {
      return res.status(503).json({ error: 'Channel closer not initialized' });
    }
    try {
      const result = await daemon.channelCloser.requestClose(req.agentId, req.body);
      if (result.success) {
        res.status(200).json(result);
      } else {
        res.status(result.status || 400).json(result);
      }
    } catch (err) {
      console.error(`[market/close] Error: ${err.message}`);
      res.status(500).json({ error: 'Internal error during channel close' });
    }
  });

  router.get('/api/v1/market/closes', auth, async (req, res) => {
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

  router.get('/api/v1/market/revenue', auth, async (req, res) => {
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

  router.get('/api/v1/market/revenue/:chanId', auth, async (req, res) => {
    if (!daemon.revenueTracker) {
      return res.status(503).json({ error: 'Revenue tracker not initialized' });
    }
    try {
      const revenue = daemon.revenueTracker.getChannelRevenue(req.params.chanId);
      res.json(revenue);
    } catch (err) {
      console.error(`[market/revenue/:chanId] Error: ${err.message}`);
      res.status(500).json({ error: 'Internal error fetching channel revenue' });
    }
  });

  router.put('/api/v1/market/revenue-config', auth, async (req, res) => {
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

  router.get('/api/v1/market/swap/quote', auth, async (req, res) => {
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

  router.post('/api/v1/market/swap/lightning-to-onchain', auth, async (req, res) => {
    if (!daemon.swapProvider) {
      return res.status(503).json({ error: 'Swap provider not initialized' });
    }
    try {
      const result = await daemon.swapProvider.createSwap(req.agentId, req.body);
      if (result.success) {
        res.json(result);
      } else {
        res.status(result.status || 400).json(result);
      }
    } catch (err) {
      console.error(`[market/swap/create] Error: ${err.message}`);
      res.status(500).json({ error: 'Internal error creating swap' });
    }
  });

  router.get('/api/v1/market/swap/status/:swapId', auth, async (req, res) => {
    if (!daemon.swapProvider) {
      return res.status(503).json({ error: 'Swap provider not initialized' });
    }
    const status = daemon.swapProvider.getSwapStatus(req.params.swapId);
    if (!status) {
      return res.status(404).json({ error: 'Swap not found' });
    }
    res.json(status);
  });

  router.get('/api/v1/market/swap/history', auth, async (req, res) => {
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

  router.post('/api/v1/market/fund-from-ecash', auth, async (req, res) => {
    if (!daemon.ecashChannelFunder) {
      return res.status(503).json({ error: 'Ecash channel funder not initialized' });
    }
    try {
      const result = await daemon.ecashChannelFunder.fundChannelFromEcash(req.agentId, req.body);
      if (result.success) {
        res.status(200).json(result);
      } else {
        res.status(result.status || 400).json(result);
      }
    } catch (err) {
      console.error(`[market/fund-from-ecash] Error: ${err.message}`);
      res.status(500).json({ error: 'Internal error during ecash channel funding' });
    }
  });

  router.get('/api/v1/market/fund-from-ecash/:flowId', auth, async (req, res) => {
    if (!daemon.ecashChannelFunder) {
      return res.status(503).json({ error: 'Ecash channel funder not initialized' });
    }
    const status = daemon.ecashChannelFunder.getFlowStatus(req.params.flowId);
    if (!status) {
      return res.status(404).json({ error: 'Funding flow not found' });
    }
    res.json(status);
  });

  // =========================================================================
  // Plan G: Performance Dashboard
  // =========================================================================

  router.get('/api/v1/market/performance', auth, async (req, res) => {
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

  router.get('/api/v1/market/performance/:chanId', auth, async (req, res) => {
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

  router.post('/api/v1/market/rebalance', auth, async (req, res) => {
    if (!daemon.rebalanceExecutor) {
      return res.status(503).json({ error: 'Rebalance executor not initialized' });
    }
    try {
      const result = await daemon.rebalanceExecutor.requestRebalance(req.agentId, req.body);
      if (result.success) {
        res.status(200).json(result);
      } else {
        res.status(result.status || 400).json(result);
      }
    } catch (err) {
      console.error(`[market/rebalance] Error: ${err.message}`);
      res.status(500).json({ error: 'Internal error during rebalance' });
    }
  });

  router.post('/api/v1/market/rebalance/estimate', auth, async (req, res) => {
    if (!daemon.rebalanceExecutor) {
      return res.status(503).json({ error: 'Rebalance executor not initialized' });
    }
    try {
      const result = await daemon.rebalanceExecutor.estimateRebalanceFee(req.agentId, req.body);
      if (result.success) {
        res.json(result);
      } else {
        res.status(result.status || 400).json(result);
      }
    } catch (err) {
      console.error(`[market/rebalance/estimate] Error: ${err.message}`);
      res.status(500).json({ error: 'Internal error during fee estimation' });
    }
  });

  router.get('/api/v1/market/rebalances', auth, async (req, res) => {
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

  const marketRL = rateLimit('market_read');

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
