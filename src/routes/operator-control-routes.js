import { Router } from 'express';
import { resetCounters } from '../identity/rate-limiter.js';
import { DangerRoutePolicyStore } from '../identity/danger-route-policy.js';
import { rejectUnauthorizedOperatorRoute, rejectUnauthorizedTestRoute } from '../identity/request-security.js';
import { validateChannelIdOrPoint } from '../identity/validators.js';

export function operatorControlRoutes(daemon) {
  const router = Router();

  router.post('/api/v1/test/reset-rate-limits', async (req, res) => {
    const rejection = rejectUnauthorizedTestRoute(req, res);
    if (rejection) return rejection;
    await resetCounters();
    await DangerRoutePolicyStore.resetAllForTests();
    await daemon.channelExecutor?.resetForTests?.();
    return res.json({ status: 'ok', message: 'Local test guards cleared.' });
  });

  router.post('/api/v1/channels/assign', async (req, res) => {
    const rejection = rejectUnauthorizedOperatorRoute(req, res);
    if (rejection) return rejection;
    try {
      const { channel_point, remote_pubkey, agent_id, constraints } = req.body;
      if (!agent_id) return res.status(400).json({ error: 'agent_id required' });
      if (!channel_point && !remote_pubkey) return res.status(400).json({ error: 'channel_point or remote_pubkey required' });

      const profile = daemon.agentRegistry.getById(agent_id);
      if (!profile) return res.status(404).json({ error: 'Agent not found' });

      const node = daemon.nodeManager.getScopedDefaultNodeOrNull('read');
      if (!node) return res.status(503).json({ error: 'LND node not available' });

      const channelsResp = await node.listChannels();
      const channels = channelsResp.channels || [];

      let match;
      if (channel_point) {
        match = channels.find((c) => c.channel_point === channel_point);
        if (!match) return res.status(404).json({ error: 'Channel not found in LND' });
      } else {
        const peerChannels = channels.filter((c) => c.remote_pubkey === remote_pubkey);
        if (peerChannels.length === 0) return res.status(404).json({ error: 'No channels with this peer' });
        if (peerChannels.length > 1) {
          return res.status(400).json({
            error: 'Multiple channels to this peer — specify channel_point',
            channel_points: peerChannels.map((c) => c.channel_point),
          });
        }
        match = peerChannels[0];
      }

      const result = await daemon.channelAssignments.assign(
        match.chan_id,
        match.channel_point,
        agent_id,
        { remote_pubkey: match.remote_pubkey, capacity: match.capacity },
        constraints || null,
      );
      return res.json({ status: 'assigned', assignment: result });
    } catch (err) {
      return res.status(err.status || 500).json({ error: err.message });
    }
  });

  router.delete('/api/v1/channels/assign/:chanId', async (req, res) => {
    const rejection = rejectUnauthorizedOperatorRoute(req, res);
    if (rejection) return rejection;
    const chanCheck = validateChannelIdOrPoint(req.params.chanId);
    if (!chanCheck.valid) return res.status(400).json({ error: chanCheck.reason });
    try {
      const revoked = await daemon.channelAssignments.revoke(req.params.chanId);
      return res.json({ status: 'revoked', revoked });
    } catch (err) {
      return res.status(err.status || 500).json({ error: err.message });
    }
  });

  return router;
}
