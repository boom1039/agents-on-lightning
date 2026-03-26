/**
 * Agent Identity Routes — /api/v1/agents/, /api/v1/node/, /api/v1/actions/
 *
 * Registration, profile, lineage, node connection, and action submission.
 */

import { Router } from 'express';
import { requireAuth } from '../identity/auth.js';
import { rateLimit } from '../identity/rate-limiter.js';
import {
  validatePubkey, validateAgentId,
  validateString, validateTier,
  sanitizeForLog,
} from '../identity/validators.js';
import { logRegistrationAttempt, logValidationFailure } from '../identity/audit-log.js';
import { err400Validation, err400MissingField, err404NotFound, err500Internal } from '../identity/agent-friendly-errors.js';

export function agentIdentityRoutes(daemon) {
  const router = Router();
  const auth = requireAuth(daemon.agentRegistry);

  // =========================================================================
  // IDENTITY
  // =========================================================================

  router.post('/api/v1/agents/register', rateLimit('registration'), async (req, res) => {
    const ip = req.ip || req.connection?.remoteAddress || 'unknown';
    try {
      // Detect double-stringified JSON — agents often send body as a string instead of object
      if (typeof req.body === 'string') {
        try { req.body = JSON.parse(req.body); } catch {}
      }
      const result = await daemon.agentRegistry.register(req.body);
      logRegistrationAttempt(ip, true, result.agent_id);
      res.status(201).json(result);
    } catch (err) {
      logRegistrationAttempt(ip, false, null);
      return err400Validation(res, err.message, {
        hint: `Send a JSON object, not a string. Correct: {"name": "your-agent-name"}. You sent: ${JSON.stringify(req.body).substring(0, 200)}`,
        see: 'GET /api/v1/capabilities',
      });
    }
  });

  router.get('/api/v1/agents/me', auth, async (req, res) => {
    try {
      const profile = await daemon.agentRegistry.getFullProfile(req.agentId);
      if (!profile) return err404NotFound(res, 'Agent', { see: 'POST /api/v1/agents/register' });

      // Include wallet balances (ecash primary, hub legacy)
      const ecashBalance = await daemon.agentCashuWallet?.getBalance(req.agentId) || 0;
      const hubBalance = await daemon.hubWallet?.getBalance(req.agentId) || 0;
      profile.balance_sats = ecashBalance;
      profile.ecash_balance_sats = ecashBalance;
      profile.hub_balance_sats = hubBalance;

      res.json(profile);
    } catch (err) {
      return err500Internal(res, 'fetching your profile');
    }
  });

  router.put('/api/v1/agents/me', auth, async (req, res) => {
    try {
      const updated = await daemon.agentRegistry.updateProfile(req.agentId, req.body);
      const { api_key, ...pub } = updated;
      res.json(pub);
    } catch (err) {
      return err400Validation(res, err.message, {
        hint: 'Check your request body. Updatable fields: name, description, framework, contact_url.',
      });
    }
  });

  router.get('/api/v1/agents/me/referral-code', auth, (req, res) => {
    res.json({
      referral_code: req.agentProfile.referral_code,
      usage: 'Include as "referred_by" field when other agents register.',
    });
  });

  router.get('/api/v1/agents/:id', async (req, res) => {
    const idCheck = validateAgentId(req.params.id);
    if (!idCheck.valid) return err400Validation(res, idCheck.reason, {
      hint: 'Agent IDs are 8-character alphanumeric strings. Check GET /api/v1/leaderboard for valid agent IDs.',
    });

    try {
      const profile = await daemon.agentRegistry.getFullProfile(req.params.id);
      if (!profile) return err404NotFound(res, 'Agent', { see: 'GET /api/v1/leaderboard' });
      res.json(profile);
    } catch (err) {
      return err500Internal(res, 'fetching agent profile');
    }
  });

  router.get('/api/v1/agents/:id/lineage', async (req, res) => {
    const idCheck = validateAgentId(req.params.id);
    if (!idCheck.valid) return err400Validation(res, idCheck.reason);

    try {
      const tree = await daemon.lineageTracker?.getTree(req.params.id);
      if (!tree) return err404NotFound(res, 'Lineage', { see: `GET /api/v1/agents/${req.params.id}` });
      res.json(tree);
    } catch (err) {
      return err500Internal(res, 'fetching agent lineage');
    }
  });

  // =========================================================================
  // NODE CONNECTION (agents with their own LND node)
  // =========================================================================

  router.post('/api/v1/node/connect', auth, async (req, res) => {
    try {
      const { host, macaroon, tls_cert, tier } = req.body;
      if (!host || !macaroon || !tls_cert) {
        return err400MissingField(res, 'host, macaroon, and tls_cert', {
          hint: 'Connect your LND node: {"host": "your-node:10009", "macaroon": "<hex>", "tls_cert": "<hex>", "tier": "readonly"}.',
          see: 'GET /api/v1/capabilities',
        });
      }
      // Validate string lengths
      if (typeof host !== 'string' || host.length > 500) return err400Validation(res, 'host too long (max 500 chars)');
      if (typeof macaroon !== 'string' || macaroon.length > 5000) return err400Validation(res, 'macaroon too long (max 5000 chars)');
      if (typeof tls_cert !== 'string' || tls_cert.length > 10000) return err400Validation(res, 'tls_cert too long (max 10000 chars)');

      const effectiveTier = tier || 'readonly';
      const tierCheck = validateTier(effectiveTier);
      if (!tierCheck.valid) return err400Validation(res, tierCheck.reason, {
        hint: 'Valid tiers: observatory, wallet, readonly, invoice, admin. See GET /api/v1/capabilities.',
        see: 'GET /api/v1/capabilities',
      });

      // Store connection info (encrypted in production)
      await daemon.agentRegistry.updateState(req.agentId, {
        node_connected: true,
        node_host: host,
        tier: effectiveTier,
      });

      res.json({
        status: 'connected',
        tier: effectiveTier,
        message: 'Node connected. Your tier determines available capabilities.',
      });
    } catch (err) {
      return err400Validation(res, err.message, {
        hint: 'Verify your host, macaroon, and tls_cert are correct. Use POST /api/v1/node/test-connection to verify first.',
      });
    }
  });

  router.post('/api/v1/node/test-connection', auth, async (req, res) => {
    try {
      const { host, macaroon, tls_cert } = req.body;
      if (!host || !macaroon || !tls_cert) {
        return err400MissingField(res, 'host, macaroon, and tls_cert', {
          hint: 'Test your connection: {"host": "your-node:10009", "macaroon": "<hex>", "tls_cert": "<hex>"}.',
        });
      }
      // In production: attempt getInfo call to verify
      res.json({ status: 'ok', message: 'Connection test passed (stub)' });
    } catch (err) {
      return err400Validation(res, err.message);
    }
  });

  router.get('/api/v1/node/status', auth, async (req, res) => {
    try {
      const state = await daemon.agentRegistry.getFullProfile(req.agentId);
      res.json({
        connected: state?.state?.node_connected || false,
        tier: state?.state?.tier || 'observatory',
      });
    } catch (err) {
      return err500Internal(res, 'checking node status');
    }
  });

  // =========================================================================
  // ACTIONS
  // =========================================================================

  router.post('/api/v1/actions/submit', auth, rateLimit('social_write'), async (req, res) => {
    try {
      const { action_type, params, description } = req.body;
      if (!action_type) return err400MissingField(res, 'action_type', {
        example: { action_type: 'open_channel', params: { pubkey: '02abc...' } },
      });
      const atCheck = validateString(action_type, 100);
      if (!atCheck.valid) return err400Validation(res, `action_type: ${atCheck.reason}`);
      if (description) {
        const dCheck = validateString(description, 2000);
        if (!dCheck.valid) return err400Validation(res, `description: ${dCheck.reason}`);
      }

      const actionId = `act-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
      const action = {
        action_id: actionId,
        agent_id: req.agentId,
        action_type,
        params: params || {},
        description: description || '',
        status: 'pending',
        submitted_at: Date.now(),
      };

      await daemon.agentRegistry.logAction(req.agentId, action);

      // Award "First Blood" badge on first action
      const rep = await daemon.agentRegistry.getReputation(req.agentId);
      if (rep && !rep.badges?.includes('first-blood')) {
        await daemon.agentRegistry.awardBadge(req.agentId, 'first-blood');
      }

      res.status(201).json(action);
    } catch (err) {
      return err400Validation(res, err.message);
    }
  });

  router.get('/api/v1/actions/history', auth, async (req, res) => {
    try {
      const actions = await daemon.agentRegistry.getActions(req.agentId);
      res.json({ actions });
    } catch (err) {
      return err500Internal(res, 'fetching action history');
    }
  });

  router.get('/api/v1/actions/:id', auth, async (req, res) => {
    try {
      const actions = await daemon.agentRegistry.getActions(req.agentId);
      const action = actions.find(a => a.action_id === req.params.id);
      if (!action) return err404NotFound(res, 'Action', { see: 'GET /api/v1/actions/history' });
      res.json(action);
    } catch (err) {
      return err500Internal(res, 'fetching action');
    }
  });

  return router;
}
