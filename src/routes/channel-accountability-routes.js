/**
 * Channel Accountability Routes — /api/v1/channels/, /api/v1/test/
 *
 * Channel assignment, instruction execution, audit chain, violations, monitoring.
 */

import { Router } from 'express';
import { requireAuth } from '../identity/auth.js';
import { checkAndIncrement, rateLimit, resetCounters } from '../identity/rate-limiter.js';
import { IdempotencyStore } from '../identity/idempotency-store.js';
import { runIdempotentRoute } from '../identity/idempotency-route.js';
import { validateChannelIdOrPoint, clampQueryInt } from '../identity/validators.js';
import { rejectUnauthorizedOperatorRoute, rejectUnauthorizedTestRoute } from '../identity/request-security.js';
import { err400Validation } from '../identity/agent-friendly-errors.js';
import { DangerRoutePolicyStore, findUnexpectedKeys } from '../identity/danger-route-policy.js';

const AGENT_CHANNEL_PREVIEW_ATTEMPT_LIMIT = 8;
const AGENT_CHANNEL_INSTRUCT_ATTEMPT_LIMIT = 3;
const SHARED_CHANNEL_INSTRUCT_ATTEMPT_LIMIT = 8;
const SHARED_CHANNEL_INSTRUCT_COOLDOWN_MS = 60 * 1000;

function sendUnexpectedKeys(res, unexpected, see) {
  return err400Validation(res, `Unexpected field(s): ${unexpected.join(', ')}`, {
    hint: 'Send only the documented JSON keys for this route.',
    see,
  });
}

function summarizeAuditEntry(entry) {
  if (!entry || typeof entry !== 'object') return null;
  return {
    ts: entry._ts || null,
    type: entry.type || null,
    chan_id: entry.chan_id || entry.channel_id || null,
    agent_id: entry.agent_id || null,
    reason: entry.reason || null,
    hash: typeof entry.hash === 'string' ? entry.hash.slice(0, 12) : null,
  };
}

function summarizeVerifyResult(result, extra = {}) {
  return {
    ...extra,
    valid: Boolean(result?.valid),
    checked: Number(result?.checked || 0),
    total: Number(result?.total || 0),
    error_count: Array.isArray(result?.errors) ? result.errors.length : 0,
    warning_count: Array.isArray(result?.warnings) ? result.warnings.length : 0,
  };
}

export function channelAccountabilityRoutes(daemon) {
  const router = Router();
  const auth = requireAuth(daemon.agentRegistry);
  const idempotencyStore = daemon.dataLayer ? new IdempotencyStore({ dataLayer: daemon.dataLayer }) : null;
  const dangerPolicy = new DangerRoutePolicyStore({ dataLayer: daemon.dataLayer });

  // --- Test-only: reset rate limits for E2E tests (localhost only) ---
  router.post('/api/v1/test/reset-rate-limits', async (req, res) => {
    const rejection = rejectUnauthorizedTestRoute(req, res);
    if (rejection) return rejection;
    await resetCounters();
    await DangerRoutePolicyStore.resetAllForTests();
    await daemon.channelExecutor?.resetForTests?.();
    res.json({ status: 'ok', message: 'Local test rate limits, danger-route cooldowns, and signed-channel cooldowns cleared' });
  });

  // --- Operator-only: assign channel ---
  router.post('/api/v1/channels/assign', async (req, res) => {
    const rejection = rejectUnauthorizedOperatorRoute(req, res);
    if (rejection) return rejection;
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
    const rejection = rejectUnauthorizedOperatorRoute(req, res);
    if (rejection) return rejection;
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
  // Read channels mine.
  // @agent-route {"auth":"agent","domain":"channels","subgroup":"Signed","label":"mine","summary":"Read channels mine.","order":100,"tags":["channels","read","agent"],"doc":["skills/channels-signed-channel-lifecycle.txt","skills/market-close.txt","skills/channels.txt"]}
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
  // Preview channels.
  // @agent-route {"auth":"agent","domain":"channels","subgroup":"Signed","label":"preview","summary":"Preview channels.","order":110,"tags":["channels","write","agent"],"doc":["skills/channels-signed-channel-lifecycle.txt","skills/channels.txt"]}
  router.post('/api/v1/channels/preview', auth, rateLimit('channel_read'), async (req, res) => {
    const unexpected = findUnexpectedKeys(req.body, ['instruction', 'signature', 'idempotency_key']);
    if (unexpected.length > 0) {
      return sendUnexpectedKeys(res, unexpected, 'GET /api/v1/channels/mine');
    }
    try {
      const channelId = req.body?.instruction?.channel_id || 'unknown';
      const agentAttempts = await checkAndIncrement(`danger:channels_preview:attempt:${req.agentId}`, AGENT_CHANNEL_PREVIEW_ATTEMPT_LIMIT, 15 * 60 * 1000);
      if (!agentAttempts.allowed) {
        res.set('Retry-After', String(agentAttempts.retryAfter));
        return res.status(429).json({
          error: 'cooldown_active',
          message: 'Too many signed channel previews across your channels.',
          retry_after_seconds: agentAttempts.retryAfter,
          retryable: true,
          hint: 'Wait a bit before previewing another signed channel change.',
        });
      }
      const attempts = await checkAndIncrement(`danger:channels_preview:attempt:${req.agentId}:${channelId}`, 6, 15 * 60 * 1000);
      if (!attempts.allowed) {
        res.set('Retry-After', String(attempts.retryAfter));
        return res.status(429).json({
          error: 'cooldown_active',
          message: 'Too many signed channel previews in a short window.',
          retry_after_seconds: attempts.retryAfter,
          retryable: true,
          hint: 'Wait a bit before previewing another channel-policy change.',
        });
      }
      const sharedAttempts = await checkAndIncrement('danger:channels_preview:attempt:__shared__', 24, 15 * 60 * 1000);
      if (!sharedAttempts.allowed) {
        res.set('Retry-After', String(sharedAttempts.retryAfter));
        return res.status(429).json({
          error: 'cooldown_active',
          message: 'The node is handling too many signed channel previews right now.',
          retry_after_seconds: sharedAttempts.retryAfter,
          retryable: true,
          hint: 'Wait a bit, then preview your channel change again.',
        });
      }
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
  // Create instructions for channels.
  // @agent-route {"auth":"agent","domain":"channels","subgroup":"Signed","label":"instruct","summary":"Create instructions for channels.","order":120,"tags":["channels","write","agent"],"doc":["skills/channels-signed-channel-lifecycle.txt","skills/channels.txt"]}
  router.post('/api/v1/channels/instruct', auth, rateLimit('channel_instruct'), async (req, res) => {
    const unexpected = findUnexpectedKeys(req.body, ['instruction', 'signature', 'idempotency_key']);
    if (unexpected.length > 0) {
      return sendUnexpectedKeys(res, unexpected, 'GET /api/v1/channels/mine');
    }
    return runIdempotentRoute({
      req,
      res,
      store: idempotencyStore,
      scope: 'channels:instruct',
      handler: async () => {
        const channelId = req.body?.instruction?.channel_id || 'unknown';
        const agentAttempts = await checkAndIncrement(`danger:channels_instruct:attempt:${req.agentId}`, AGENT_CHANNEL_INSTRUCT_ATTEMPT_LIMIT, 60 * 60 * 1000);
        if (!agentAttempts.allowed) {
          return {
            statusCode: 429,
            body: {
              error: 'cooldown_active',
              message: 'Too many signed channel updates across your channels this hour.',
              retry_after_seconds: agentAttempts.retryAfter,
              hint: 'Wait before sending another signed channel update on this node.',
            },
          };
        }
        const attempts = await checkAndIncrement(`danger:channels_instruct:attempt:${req.agentId}:${channelId}`, 2, 60 * 60 * 1000);
        if (!attempts.allowed) {
          return {
            statusCode: 429,
            body: {
              error: 'cooldown_active',
              message: 'Too many signed channel updates for this channel this hour.',
              retry_after_seconds: attempts.retryAfter,
              hint: 'Wait before sending another fee-policy or HTLC update for this channel.',
            },
          };
        }
        const sharedAttempts = await checkAndIncrement('danger:channels_instruct:attempt:__shared__', SHARED_CHANNEL_INSTRUCT_ATTEMPT_LIMIT, 60 * 60 * 1000);
        if (!sharedAttempts.allowed) {
          return {
            statusCode: 429,
            body: {
              error: 'cooldown_active',
              message: 'The node is handling too many signed channel updates right now.',
              retry_after_seconds: sharedAttempts.retryAfter,
              hint: 'Wait a bit before sending another fee-policy or HTLC update.',
            },
          };
        }
        const sharedCooldown = await dangerPolicy.checkCooldown({
          scope: 'channels_instruct',
          agentId: '__shared__',
          cooldownMs: SHARED_CHANNEL_INSTRUCT_COOLDOWN_MS,
        });
        if (!sharedCooldown.allowed) {
          return {
            statusCode: 429,
            body: {
              error: 'cooldown_active',
              message: 'The node is cooling down after a recent signed channel update.',
              retry_after_seconds: sharedCooldown.retryAfterSeconds,
              hint: 'Wait a bit before sending another fee-policy or HTLC update anywhere on this node.',
            },
          };
        }
        const result = await daemon.channelExecutor.execute(req.agentId, req.body);
        const status = result.success ? 200 : (result.status || 400);
        const body = result.success
          ? { status: 'executed', ...result.result, learn: result.learn }
          : { error: result.error, hint: result.hint, failed_at: result.failed_at, checks_passed: result.checks_passed };
        if (result.success) {
          await dangerPolicy.recordSuccess({
            scope: 'channels_instruct',
            agentId: '__shared__',
          });
        }
        if (result.retry_after_seconds) {
          body.retry_after_seconds = result.retry_after_seconds;
        }
        return { statusCode: status, body };
      },
      onError: (err) => {
        console.error(`[Gateway] ${req.path}: ${err.message}`);
        return {
          statusCode: 500,
          body: {
            error: 'Internal server error',
            hint: 'Unexpected server error during instruction execution. This is a bug — please report it.',
          },
        };
      },
    });
  });

  // --- Agent: instruction history ---
  // Read channels instructions.
  // @agent-route {"auth":"agent","domain":"channels","subgroup":"Signed","label":"instructions","summary":"Read channels instructions.","order":130,"tags":["channels","read","agent"],"doc":["skills/channels-signed-channel-lifecycle.txt","skills/channels.txt"]}
  router.get('/api/v1/channels/instructions', auth, rateLimit('channel_read'), async (req, res) => {
    try {
      const limit = clampQueryInt(req.query.limit, 100, 1, 1000);
      const instructions = await daemon.channelExecutor.getInstructions(req.agentId, limit);
      res.json({ instructions });
    } catch (err) {
      console.error(`[Gateway] ${req.path}: ${err.message}`);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // --- Public: audit chain ---
  // Read channels audit.
  // @agent-route {"auth":"public","domain":"channels","subgroup":"Audit","label":"audit","summary":"Read channels audit.","order":200,"tags":["channels","read","public"],"doc":["skills/channels-audit-and-monitoring.txt","skills/channels.txt"]}
  router.get('/api/v1/channels/audit', rateLimit('channel_read'), async (_req, res) => {
    try {
      const limit = clampQueryInt(_req.query.limit, 100, 1, 1000);
      const since = _req.query.since ? clampQueryInt(_req.query.since, 0, 0, Number.MAX_SAFE_INTEGER) : undefined;
      const entries = await daemon.channelAuditLog.readAll({ since, limit });
      res.json({
        entries: entries.map(summarizeAuditEntry).filter(Boolean),
        count: entries.length,
        learn: 'Public audit summaries show what happened without exposing raw monitor internals.',
      });
    } catch (err) {
      console.error(`[Gateway] ${_req.path}: ${err.message}`);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // --- Public: audit chain for specific channel ---
  // Read channels audit by chanId.
  // @agent-route {"auth":"public","domain":"channels","subgroup":"Audit","label":"audit-by-channel","summary":"Read channels audit by chanId.","order":210,"tags":["channels","read","dynamic","public"],"doc":["skills/channels-audit-and-monitoring.txt","skills/channels.txt"]}
  router.get('/api/v1/channels/audit/:chanId', rateLimit('channel_read'), async (req, res) => {
    const chanCheck = validateChannelIdOrPoint(req.params.chanId);
    if (!chanCheck.valid) return res.status(400).json({ error: chanCheck.reason });
    try {
      const limit = clampQueryInt(req.query.limit, 100, 1, 1000);
      const entries = await daemon.channelAuditLog.readByChannel(req.params.chanId, limit);
      res.json({
        chan_id: req.params.chanId,
        entries: entries.map(summarizeAuditEntry).filter(Boolean),
        count: entries.length,
        learn: 'This public view is summary-only. Owners and operators use deeper tools for raw channel details.',
      });
    } catch (err) {
      console.error(`[Gateway] ${req.path}: ${err.message}`);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // --- Public: verify chain integrity ---
  // Read channels verify.
  // @agent-route {"auth":"public","domain":"channels","subgroup":"Verify","label":"verify","summary":"Read channels verify.","order":300,"tags":["channels","read","public"],"doc":["skills/channels-audit-and-monitoring.txt","skills/channels.txt"]}
  router.get('/api/v1/channels/verify', rateLimit('channel_read'), async (_req, res) => {
    try {
      const result = await daemon.channelAuditLog.verify();
      res.json(summarizeVerifyResult(result));
    } catch (err) {
      console.error(`[Gateway] ${_req.path}: ${err.message}`);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // --- Public: verify chain for specific channel ---
  // Read channels verify by chanId.
  // @agent-route {"auth":"public","domain":"channels","subgroup":"Verify","label":"verify-by-channel","summary":"Read channels verify by chanId.","order":310,"tags":["channels","read","dynamic","public"],"doc":["skills/channels-audit-and-monitoring.txt","skills/channels.txt"]}
  router.get('/api/v1/channels/verify/:chanId', rateLimit('channel_read'), async (req, res) => {
    const chanCheck = validateChannelIdOrPoint(req.params.chanId);
    if (!chanCheck.valid) return res.status(400).json({ error: chanCheck.reason });
    try {
      const result = await daemon.channelAuditLog.verify(req.params.chanId);
      res.json(summarizeVerifyResult(result, { chan_id: req.params.chanId }));
    } catch (err) {
      console.error(`[Gateway] ${req.path}: ${err.message}`);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // --- Public: violations ---
  // Read channels violations.
  // @agent-route {"auth":"public","domain":"channels","subgroup":"Status","label":"violations","summary":"Read channels violations.","order":400,"tags":["channels","read","public"],"doc":["skills/channels-audit-and-monitoring.txt","skills/channels.txt"]}
  router.get('/api/v1/channels/violations', rateLimit('channel_read'), async (req, res) => {
    try {
      const limit = clampQueryInt(req.query.limit, 100, 1, 1000);
      const violations = await daemon.channelAuditLog.readByType('violation_detected', limit);
      res.json({
        violations: violations.map(summarizeAuditEntry).filter(Boolean),
        count: violations.length,
      });
    } catch (err) {
      console.error(`[Gateway] ${req.path}: ${err.message}`);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // --- Public: monitor status ---
  // Read channels status.
  // @agent-route {"auth":"public","domain":"channels","subgroup":"Status","label":"status","summary":"Read channels status.","order":410,"tags":["channels","read","public"],"doc":["skills/channels-audit-and-monitoring.txt","skills/channels.txt"]}
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

