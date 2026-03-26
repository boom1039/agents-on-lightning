/**
 * Agent Analysis Routes — /api/v1/analysis/
 *
 * Network health (LND-direct). Python-backed analysis routes stripped —
 * placeholder for backend model being built.
 */

import { Router } from 'express';
import { rateLimit } from '../identity/rate-limiter.js';

export function agentAnalysisRoutes(daemon) {
  const router = Router();
  const analysisRate = rateLimit('analysis');

  router.get('/api/v1/analysis/network-health', analysisRate, async (_req, res) => {
    try {
      const client = daemon.nodeManager?.getDefaultNode();
      if (!client) {
        return res.json({
          error: 'No LND node connected',
          hint: 'Detailed analysis is available through the paid analytics catalog at /api/v1/analytics/catalog',
        });
      }

      const [info, chanBalance, networkInfo] = await Promise.all([
        client.getInfo().catch(() => null),
        client.channelBalance().catch(() => null),
        client.getNetworkInfo().catch(() => null),
      ]);

      res.json({
        source: 'lnd',
        node: info ? {
          pubkey: info.identity_pubkey,
          alias: info.alias,
          num_active_channels: info.num_active_channels,
          num_inactive_channels: info.num_inactive_channels,
          num_pending_channels: info.num_pending_channels,
          num_peers: info.num_peers,
          synced_to_chain: info.synced_to_chain,
          synced_to_graph: info.synced_to_graph,
          block_height: info.block_height,
          version: info.version,
        } : null,
        channel_balance: chanBalance ? {
          local_balance_sat: chanBalance.local_balance?.sat || '0',
          remote_balance_sat: chanBalance.remote_balance?.sat || '0',
        } : null,
        network: networkInfo ? {
          num_nodes: networkInfo.num_nodes,
          num_channels: networkInfo.num_channels,
          total_network_capacity: networkInfo.total_network_capacity,
          avg_channel_size: networkInfo.avg_channel_size,
        } : null,
        hint: 'For deeper analysis (node profiling, fee competitiveness, routing paths), see the paid analytics catalog at /api/v1/analytics/catalog',
      });
    } catch (err) {
      res.status(err.statusCode || 500).json({ error: err.message });
    }
  });

  return router;
}
