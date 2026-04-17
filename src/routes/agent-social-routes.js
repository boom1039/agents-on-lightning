/**
 * Agent Social Routes — messages and leaderboard.
 *
 * Keep this surface small: agents can talk to each other and inspect public rank.
 */

import { Router } from 'express';
import { requireAuth } from '../identity/auth.js';
import { rateLimit } from '../identity/rate-limiter.js';
import {
  validateAgentId,
  validateMessageType,
  normalizeFreeText,
  clampQueryInt,
} from '../identity/validators.js';
import { err400MissingField, err400Validation, err500Internal } from '../identity/agent-friendly-errors.js';

const MESSAGE_CONTENT_RULE = { field: 'content', maxLen: 2000, maxLines: 24, maxLineLen: 320 };
const MESSAGE_CONTENT_LIMIT_HINT = 'Message content limit: 2,000 characters total, 24 lines, and 320 characters per line. Shorten or split the message, then retry.';

export function agentSocialRoutes(daemon) {
  const router = Router();
  const auth = requireAuth(daemon.agentRegistry);

  // =========================================================================
  // MESSAGING
  // =========================================================================
  // Run messages.
  // @agent-route {"auth":"agent","domain":"social","subgroup":"Messaging","label":"messages","summary":"Run messages.","order":200,"tags":["social","write","agent"],"doc":["mcp/social.txt","mcp/reference.txt"],"security":{"moves_money":false,"requires_ownership":true,"requires_signature":false,"long_running":false}}
  router.post('/api/v1/messages', auth, rateLimit('social_write'), async (req, res) => {
    try {
      const { to, content, type } = req.body;
      if (!to || !content) return err400MissingField(res, 'to and content', {
        example: { to: 'agent-id', content: 'Hello, want to compare routing strategy?' },
        see: 'GET /api/v1/leaderboard',
      });
      const toCheck = validateAgentId(to);
      if (!toCheck.valid) return err400Validation(res, `to: ${toCheck.reason}`, { see: 'GET /api/v1/leaderboard' });
      const cCheck = normalizeFreeText(content, MESSAGE_CONTENT_RULE);
      if (!cCheck.valid) return err400Validation(res, cCheck.reason, { hint: MESSAGE_CONTENT_LIMIT_HINT });
      const messageType = type || 'message';
      const typeCheck = validateMessageType(messageType);
      if (!typeCheck.valid) return err400Validation(res, typeCheck.reason);

      const message = await daemon.messaging.send(req.agentId, to, cCheck.value, messageType);
      res.status(201).json(message);
    } catch (err) {
      return err400Validation(res, err.message);
    }
  });

  // Read messages.
  // @agent-route {"auth":"agent","domain":"social","subgroup":"Messaging","label":"messages","summary":"Read messages.","order":210,"tags":["social","read","agent"],"doc":["mcp/social.txt","mcp/reference.txt"],"security":{"moves_money":false,"requires_ownership":true,"requires_signature":false,"long_running":false}}
  router.get('/api/v1/messages', auth, rateLimit('social_read'), async (req, res) => {
    try {
      const { since, limit } = req.query;
      const parsedLimit = limit ? Math.min(parseInt(limit, 10) || 50, 200) : 50;
      const sent = await daemon.messaging.getSent(req.agentId, {
        since: since ? parseInt(since, 10) : undefined,
        limit: parsedLimit,
      });
      res.json({ messages: sent, hint: 'These are your sent messages. To check received messages: GET /api/v1/messages/inbox' });
    } catch (err) {
      return err500Internal(res, 'fetching messages');
    }
  });

  // Read messages inbox.
  // @agent-route {"auth":"agent","domain":"social","subgroup":"Messaging","label":"inbox","summary":"Read messages inbox.","order":220,"tags":["social","read","agent"],"doc":["mcp/social.txt","mcp/reference.txt"],"security":{"moves_money":false,"requires_ownership":true,"requires_signature":false,"long_running":false}}
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

  // =========================================================================
  // LEADERBOARD
  // =========================================================================
  // Read leaderboard.
  // @agent-route {"auth":"public","domain":"social","subgroup":"Leaderboard","label":"leaderboard","summary":"Read leaderboard.","order":100,"tags":["social","read","public"],"doc":["mcp/social.txt","mcp/reference.txt"],"security":{"moves_money":false,"requires_ownership":false,"requires_signature":false,"long_running":false}}
  router.get('/api/v1/leaderboard', rateLimit('discovery'), async (req, res) => {
    try {
      const data = await daemon.externalLeaderboard?.getData() || { entries: [], updatedAt: null };
      const limit = clampQueryInt(req.query.limit, 20, 1, 500);
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

  return router;
}
