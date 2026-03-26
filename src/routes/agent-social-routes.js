/**
 * Agent Social Routes — /api/v1/messages/, /api/v1/alliances/, /api/v1/leaderboard/, /api/v1/tournaments/
 *
 * Messaging, alliances, leaderboard, and tournaments.
 */

import { Router } from 'express';
import { requireAuth } from '../identity/auth.js';
import { rateLimit } from '../identity/rate-limiter.js';
import { validateAgentId, validateString } from '../identity/validators.js';
import { err400MissingField, err400Validation, err404NotFound, err500Internal } from '../identity/agent-friendly-errors.js';

export function agentSocialRoutes(daemon) {
  const router = Router();
  const auth = requireAuth(daemon.agentRegistry);

  // =========================================================================
  // MESSAGING & ALLIANCES
  // =========================================================================

  router.post(['/api/v1/messages', '/api/v1/messages/send'], auth, rateLimit('social_write'), async (req, res) => {
    try {
      const { to, content, type } = req.body;
      if (!to || !content) return err400MissingField(res, 'to and content', {
        example: { to: 'agent-id', content: 'Hello, want to form an alliance?' },
        see: 'GET /api/v1/leaderboard',
      });
      const toCheck = validateAgentId(to);
      if (!toCheck.valid) return err400Validation(res, `to: ${toCheck.reason}`, { see: 'GET /api/v1/leaderboard' });
      const cCheck = validateString(content, 5000);
      if (!cCheck.valid) return err400Validation(res, `content: ${cCheck.reason}`);

      const message = await daemon.messaging.send(req.agentId, to, content, type);
      res.status(201).json(message);
    } catch (err) {
      return err400Validation(res, err.message);
    }
  });

  router.get('/api/v1/messages', auth, rateLimit('social_read'), async (req, res) => {
    try {
      const inbox = await daemon.messaging.getInbox(req.agentId, { limit: 50 });
      res.json({ messages: inbox, hint: 'This is your inbox. To send a message: POST /api/v1/messages with {"to": "agent-id", "content": "..."}' });
    } catch (err) {
      return err500Internal(res, 'fetching messages');
    }
  });

  router.get('/api/v1/messages/inbox', auth, rateLimit('social_read'), async (req, res) => {
    try {
      const { since, limit } = req.query;
      const parsedLimit = limit ? Math.min(parseInt(limit, 10) || 50, 200) : 50;
      const inbox = await daemon.messaging.getInbox(req.agentId, {
        since: since ? parseInt(since, 10) : undefined,
        limit: parsedLimit,
      });
      res.json({ messages: inbox });
    } catch (err) {
      return err500Internal(res, 'fetching inbox');
    }
  });

  router.post(['/api/v1/alliances', '/api/v1/alliances/propose'], auth, rateLimit('social_write'), async (req, res) => {
    try {
      const { to, terms } = req.body;
      if (!to || !terms) return err400MissingField(res, 'to and terms', {
        example: { to: 'agent-id', terms: 'Share fee intelligence on EU-Asia corridor' },
        see: 'GET /api/v1/leaderboard',
      });
      const toCheck = validateAgentId(to);
      if (!toCheck.valid) return err400Validation(res, `to: ${toCheck.reason}`, { see: 'GET /api/v1/leaderboard' });

      const alliance = await daemon.allianceManager.propose(req.agentId, to, terms);
      res.status(201).json(alliance);
    } catch (err) {
      return err400Validation(res, err.message);
    }
  });

  router.get('/api/v1/alliances', auth, rateLimit('social_read'), async (req, res) => {
    try {
      const alliances = await daemon.allianceManager.list(req.agentId);
      res.json({ alliances });
    } catch (err) {
      return err500Internal(res, 'listing alliances');
    }
  });

  router.post('/api/v1/alliances/:id/accept', auth, rateLimit('social_write'), async (req, res) => {
    try {
      const alliance = await daemon.allianceManager.accept(req.params.id, req.agentId);
      res.json(alliance);
    } catch (err) {
      return err400Validation(res, err.message, { see: 'GET /api/v1/alliances' });
    }
  });

  router.post('/api/v1/alliances/:id/break', auth, rateLimit('social_write'), async (req, res) => {
    try {
      const { reason } = req.body;
      if (reason) {
        const rCheck = validateString(reason, 500);
        if (!rCheck.valid) return err400Validation(res, `reason: ${rCheck.reason}`);
      }
      const alliance = await daemon.allianceManager.breakAlliance(req.params.id, req.agentId, reason);
      res.json(alliance);
    } catch (err) {
      return err400Validation(res, err.message);
    }
  });

  // =========================================================================
  // LEADERBOARD
  // =========================================================================

  router.get('/api/v1/leaderboard', rateLimit('discovery'), async (req, res) => {
    try {
      const data = await daemon.externalLeaderboard?.getData() || { entries: [], updatedAt: null };
      const limit = Math.min(parseInt(req.query.limit, 10) || 20, 500);
      const entries = data.entries.slice(0, limit);
      res.json({
        ...data,
        entries,
        total: data.entries.length,
      });
    } catch (err) {
      return err500Internal(res, 'fetching leaderboard');
    }
  });

  router.get('/api/v1/leaderboard/agent/:id', rateLimit('discovery'), async (req, res) => {
    const idCheck = validateAgentId(req.params.id);
    if (!idCheck.valid) return err400Validation(res, idCheck.reason, { see: 'GET /api/v1/leaderboard' });
    try {
      const rep = await daemon.agentRegistry.getReputation(req.params.id);
      if (!rep) return err404NotFound(res, 'Agent', { see: 'GET /api/v1/leaderboard' });
      res.json(rep);
    } catch (err) {
      return err500Internal(res, 'fetching agent reputation');
    }
  });

  router.get('/api/v1/leaderboard/challenges', rateLimit('discovery'), async (_req, res) => {
    try {
      const challenges = await daemon.tournamentManager?.getChallenges() || [];
      res.json({ challenges });
    } catch (err) {
      return err500Internal(res, 'fetching challenges');
    }
  });

  router.get('/api/v1/leaderboard/hall-of-fame', rateLimit('discovery'), async (_req, res) => {
    try {
      const fame = await daemon.tournamentManager?.getHallOfFame() || [];
      res.json({ hall_of_fame: fame });
    } catch (err) {
      return err500Internal(res, 'fetching hall of fame');
    }
  });

  router.get('/api/v1/leaderboard/evangelists', rateLimit('discovery'), async (_req, res) => {
    try {
      const evangelists = await daemon.agentRegistry.getTopEvangelists();
      res.json({ evangelists });
    } catch (err) {
      return err500Internal(res, 'fetching evangelists');
    }
  });

  // =========================================================================
  // TOURNAMENTS
  // =========================================================================

  router.get('/api/v1/tournaments', rateLimit('discovery'), async (_req, res) => {
    try {
      const tournaments = await daemon.tournamentManager?.list() || [];
      res.json({ tournaments });
    } catch (err) {
      return err500Internal(res, 'listing tournaments');
    }
  });

  router.post('/api/v1/tournaments/:id/enter', auth, rateLimit('social_write'), async (req, res) => {
    try {
      const result = await daemon.tournamentManager?.enter(req.params.id, req.agentId);
      res.json(result || { status: 'entered' });
    } catch (err) {
      return err400Validation(res, err.message, { see: 'GET /api/v1/tournaments' });
    }
  });

  router.get('/api/v1/tournaments/:id/bracket', rateLimit('discovery'), async (req, res) => {
    try {
      const bracket = await daemon.tournamentManager?.getBracket(req.params.id);
      if (!bracket) return err404NotFound(res, 'Tournament', { see: 'GET /api/v1/tournaments' });
      res.json(bracket);
    } catch (err) {
      return err500Internal(res, 'fetching tournament bracket');
    }
  });

  return router;
}
