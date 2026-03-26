/**
 * Channel Accountability Routes — /api/v1/channels/, /api/v1/test/
 *
 * Channel assignment, instruction execution, audit chain, violations, monitoring.
 */

import { Router } from 'express';
import { requireAuth } from '../identity/auth.js';
import { rateLimit, resetCounters } from '../identity/rate-limiter.js';
import { validateChannelIdOrPoint } from '../identity/validators.js';

const isLocalhost = (req) => ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.ip);

export function channelAccountabilityRoutes(daemon) {
  const router = Router();
  const auth = requireAuth(daemon.agentRegistry);

  // --- Test-only: reset rate limits for E2E tests (localhost only) ---
  router.post('/api/v1/test/reset-rate-limits', (req, res) => {
    if (!isLocalhost(req)) return res.status(403).json({ error: 'Localhost only' });
    resetCounters();
    res.json({ status: 'ok', message: 'Rate limit counters cleared' });
  });

  // --- Operator-only: assign channel ---
  router.post('/api/v1/channels/assign', async (req, res) => {
    if (!isLocalhost(req)) return res.status(403).json({ error: 'Operator-only (localhost)' });
    try {
      const { channel_point, remote_pubkey, agent_id, constraints } = req.body;
      if (!agent_id) return res.status(400).json({ error: 'agent_id required' });
      if (!channel_point && !remote_pubkey) return res.status(400).json({ error: 'channel_point or remote_pubkey required' });

      // Verify agent exists
      const profile = daemon.agentRegistry.getById(agent_id);
      if (!profile) return res.status(404).json({ error: 'Agent not found' });

      // Get node client
      const node = daemon.nodeManager.getDefaultNodeOrNull();
      if (!node) return res.status(503).json({ error: 'LND node not available' });

      const channelsResp = await node.listChannels();
      const channels = channelsResp.channels || [];

      let match;
      if (channel_point) {
        match = channels.find(c => c.channel_point === channel_point);
        if (!match) return res.status(404).json({ error: 'Channel not found in LND' });
      } else {
        // Find by remote_pubkey
        const peerChannels = channels.filter(c => c.remote_pubkey === remote_pubkey);
        if (peerChannels.length === 0) return res.status(404).json({ error: 'No channels with this peer' });
        if (peerChannels.length > 1) {
          return res.status(400).json({
            error: 'Multiple channels to this peer — specify channel_point',
            channel_points: peerChannels.map(c => c.channel_point),
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
      res.json({ status: 'assigned', assignment: result });
    } catch (err) {
      const status = err.status || 500;
      res.status(status).json({ error: err.message });
    }
  });

  // --- Operator-only: revoke assignment ---
  router.delete('/api/v1/channels/assign/:chanId', async (req, res) => {
    if (!isLocalhost(req)) return res.status(403).json({ error: 'Operator-only (localhost)' });
    const chanCheck = validateChannelIdOrPoint(req.params.chanId);
    if (!chanCheck.valid) return res.status(400).json({ error: chanCheck.reason });
    try {
      const revoked = await daemon.channelAssignments.revoke(req.params.chanId);
      res.json({ status: 'revoked', revoked });
    } catch (err) {
      const status = err.status || 500;
      res.status(status).json({ error: err.message });
    }
  });

  // --- Agent: my assigned channels ---
  router.get('/api/v1/channels/mine', auth, rateLimit('channel_read'), async (req, res) => {
    try {
      const assignments = daemon.channelAssignments.getByAgent(req.agentId);

      // Enrich with current fees from LND
      const node = daemon.nodeManager.getDefaultNodeOrNull();
      let feeMap = new Map();
      if (node) {
        try {
          const report = await node.feeReport();
          for (const ch of report.channel_fees || []) {
            feeMap.set(ch.channel_point, {
              base_fee_msat: ch.base_fee_msat,
              fee_per_mil: ch.fee_per_mil,
            });
          }
        } catch { /* non-fatal */ }
      }

      const enriched = assignments.map(a => ({
        ...a,
        current_fees: feeMap.get(a.channel_point) || null,
      }));
      res.json({ channels: enriched });
    } catch (err) {
      console.error(`[Gateway] ${req.path}: ${err.message}`);
      const status = err.status || err.statusCode || 500;
      res.status(status).json({ error: status < 500 ? err.message : 'Internal server error' });
    }
  });

  // --- Agent: preview signed instruction (dry-run validation) ---
  router.post('/api/v1/channels/preview', auth, rateLimit('channel_read'), async (req, res) => {
    try {
      const result = await daemon.channelExecutor.preview(req.agentId, req.body);
      const status = result.valid ? 200 : (result.status || 400);
      if (result.retry_after_seconds) {
        res.set('Retry-After', String(result.retry_after_seconds));
      }
      res.status(status).json(result);
    } catch (err) {
      console.error(`[Gateway] ${req.path}: ${err.message}`);
      res.status(500).json({
        error: 'Internal server error',
        hint: 'Unexpected server error during preview. This is a bug — please report it.',
      });
    }
  });

  // --- Agent: submit signed instruction ---
  router.post('/api/v1/channels/instruct', auth, rateLimit('channel_instruct'), async (req, res) => {
    try {
      const result = await daemon.channelExecutor.execute(req.agentId, req.body);
      const status = result.success ? 200 : (result.status || 400);
      const body = result.success
        ? { status: 'executed', ...result.result, learn: result.learn }
        : { error: result.error, hint: result.hint, failed_at: result.failed_at, checks_passed: result.checks_passed };
      if (result.retry_after_seconds) {
        res.set('Retry-After', String(result.retry_after_seconds));
        body.retry_after_seconds = result.retry_after_seconds;
      }
      res.status(status).json(body);
    } catch (err) {
      console.error(`[Gateway] ${req.path}: ${err.message}`);
      res.status(500).json({
        error: 'Internal server error',
        hint: 'Unexpected server error during instruction execution. This is a bug — please report it.',
      });
    }
  });

  // --- Agent: instruction history ---
  router.get('/api/v1/channels/instructions', auth, rateLimit('channel_read'), async (req, res) => {
    try {
      const limit = Math.min(parseInt(req.query.limit, 10) || 100, 1000);
      const instructions = await daemon.channelExecutor.getInstructions(req.agentId, limit);
      res.json({ instructions });
    } catch (err) {
      console.error(`[Gateway] ${req.path}: ${err.message}`);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // --- Public: audit chain ---
  router.get('/api/v1/channels/audit', rateLimit('channel_read'), async (_req, res) => {
    try {
      const limit = Math.min(parseInt(_req.query.limit, 10) || 100, 1000);
      const since = _req.query.since ? parseInt(_req.query.since, 10) : undefined;
      const entries = await daemon.channelAuditLog.readAll({ since, limit });
      res.json({ entries, count: entries.length });
    } catch (err) {
      console.error(`[Gateway] ${_req.path}: ${err.message}`);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // --- Public: audit chain for specific channel ---
  router.get('/api/v1/channels/audit/:chanId', rateLimit('channel_read'), async (req, res) => {
    const chanCheck = validateChannelIdOrPoint(req.params.chanId);
    if (!chanCheck.valid) return res.status(400).json({ error: chanCheck.reason });
    try {
      const limit = Math.min(parseInt(req.query.limit, 10) || 100, 1000);
      const entries = await daemon.channelAuditLog.readByChannel(req.params.chanId, limit);
      res.json({ entries, count: entries.length });
    } catch (err) {
      console.error(`[Gateway] ${req.path}: ${err.message}`);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // --- Public: verify chain integrity ---
  router.get('/api/v1/channels/verify', rateLimit('channel_read'), async (_req, res) => {
    try {
      const result = await daemon.channelAuditLog.verify();
      res.json(result);
    } catch (err) {
      console.error(`[Gateway] ${_req.path}: ${err.message}`);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // --- Public: verify chain for specific channel ---
  router.get('/api/v1/channels/verify/:chanId', rateLimit('channel_read'), async (req, res) => {
    const chanCheck = validateChannelIdOrPoint(req.params.chanId);
    if (!chanCheck.valid) return res.status(400).json({ error: chanCheck.reason });
    try {
      const result = await daemon.channelAuditLog.verify(req.params.chanId);
      res.json(result);
    } catch (err) {
      console.error(`[Gateway] ${req.path}: ${err.message}`);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // --- Public: violations ---
  router.get('/api/v1/channels/violations', rateLimit('channel_read'), async (req, res) => {
    try {
      const limit = Math.min(parseInt(req.query.limit, 10) || 100, 1000);
      const violations = await daemon.channelAuditLog.readByType('violation_detected', limit);
      res.json({ violations, count: violations.length });
    } catch (err) {
      console.error(`[Gateway] ${req.path}: ${err.message}`);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // --- Public: monitor status ---
  router.get('/api/v1/channels/status', rateLimit('channel_read'), async (_req, res) => {
    try {
      const monitorStatus = daemon.channelMonitor.getStatus();
      const chainStatus = await daemon.channelAuditLog.getStatus();
      res.json({ monitor: monitorStatus, chain: chainStatus });
    } catch (err) {
      console.error(`[Gateway] ${_req.path}: ${err.message}`);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  return router;
}
