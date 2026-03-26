/**
 * Agent Advisory Routes — /api/v1/advisory/, /api/v1/bounties/
 *
 * Suggestions, bounty posting/claiming/judging.
 */

import { Router } from 'express';
import { requireAuth } from '../identity/auth.js';
import { rateLimit } from '../identity/rate-limiter.js';
import {
  validatePubkey, validateAgentId,
  validateString, validateAmount,
} from '../identity/validators.js';
import { err400Validation, err400MissingField, err404NotFound, err500Internal, agentError } from '../identity/agent-friendly-errors.js';

export function agentAdvisoryRoutes(daemon) {
  const router = Router();
  const auth = requireAuth(daemon.agentRegistry);

  async function readBounties() {
    try { return await daemon.dataLayer.readLog('data/bounties/active.jsonl'); } catch { return []; }
  }

  router.post(['/api/v1/advisory', '/api/v1/advisory/suggest'], auth, rateLimit('social_write'), async (req, res) => {
    try {
      const { target_pubkey, suggestion_type, content } = req.body;
      if (!content) return err400MissingField(res, 'content', {
        example: { content: 'Lower fees on channel X to increase routing volume', target_pubkey: '02abc...', suggestion_type: 'fee_adjustment' },
      });
      const cCheck = validateString(content, 5000);
      if (!cCheck.valid) return err400Validation(res, `content: ${cCheck.reason}`);
      if (target_pubkey) {
        const pkCheck = validatePubkey(target_pubkey);
        if (!pkCheck.valid) return err400Validation(res, `target_pubkey: ${pkCheck.reason}`);
      }
      if (suggestion_type) {
        const stCheck = validateString(suggestion_type, 100);
        if (!stCheck.valid) return err400Validation(res, `suggestion_type: ${stCheck.reason}`);
      }

      const suggestion = {
        suggestion_id: `sug-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        from_agent: req.agentId,
        target_pubkey: target_pubkey || null,
        suggestion_type: suggestion_type || 'general',
        content,
        status: 'pending',
        submitted_at: Date.now(),
      };

      await daemon.agentRegistry.logSuggestion(req.agentId, suggestion);
      res.status(201).json(suggestion);
    } catch (err) {
      return err400Validation(res, err.message);
    }
  });

  router.get('/api/v1/advisory/inbox', auth, async (req, res) => {
    try {
      const suggestions = await daemon.agentRegistry.getSuggestions(req.agentId);
      res.json({ suggestions });
    } catch (err) {
      return err500Internal(res, 'fetching advisory inbox');
    }
  });

  router.post('/api/v1/advisory/suggestions/:id/accept', auth, async (req, res) => {
    try {
      // Mark suggestion as accepted
      await daemon.agentRegistry.logSuggestion(req.agentId, {
        suggestion_id: req.params.id,
        action: 'accepted',
        accepted_at: Date.now(),
      });
      res.json({ status: 'accepted', suggestion_id: req.params.id });
    } catch (err) {
      return err400Validation(res, err.message);
    }
  });

  // Bounties
  router.post(['/api/v1/bounties', '/api/v1/bounties/post'], auth, rateLimit('bounty_write'), async (req, res) => {
    try {
      const { title, description, reward_sats, requirements } = req.body;
      if (!title || !reward_sats) {
        return err400MissingField(res, 'title and reward_sats', {
          example: { title: 'Find cheapest route NA→EU', reward_sats: 1000, description: 'optional details' },
        });
      }
      const titleCheck = validateString(title, 200);
      if (!titleCheck.valid) return err400Validation(res, `title: ${titleCheck.reason}`);
      if (description) {
        const dCheck = validateString(description, 2000);
        if (!dCheck.valid) return err400Validation(res, `description: ${dCheck.reason}`);
      }
      const rewardParsed = parseInt(reward_sats, 10);
      const rewardCheck = validateAmount(rewardParsed, 100, 10_000_000);
      if (!rewardCheck.valid) return err400Validation(res, `reward_sats: ${rewardCheck.reason}`, {
        hint: 'reward_sats must be between 100 and 10,000,000.',
      });
      if (requirements) {
        const rCheck = validateString(requirements, 2000);
        if (!rCheck.valid) return err400Validation(res, `requirements: ${rCheck.reason}`);
      }

      const bounty = {
        bounty_id: `bounty-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        posted_by: req.agentId,
        title: title.trim(),
        description: description?.trim() || '',
        reward_sats: rewardParsed,
        requirements: requirements?.trim() || null,
        status: 'open',
        claimed_by: null,
        posted_at: Date.now(),
      };

      await daemon.dataLayer.appendLog('data/bounties/active.jsonl', bounty);
      res.status(201).json(bounty);
    } catch (err) {
      return err400Validation(res, err.message);
    }
  });

  router.get('/api/v1/bounties', rateLimit('discovery'), async (_req, res) => {
    try {
      const bounties = await readBounties();

      // Only show open bounties
      const open = bounties.filter(b => b.status === 'open' || b.status === 'claimed');
      res.json({ bounties: open, count: open.length });
    } catch (err) {
      return err500Internal(res, 'fetching bounties');
    }
  });

  router.post('/api/v1/bounties/:id/claim', auth, rateLimit('bounty_write'), async (req, res) => {
    try {
      const bountyId = req.params.id;
      const idCheck = validateString(bountyId, 100);
      if (!idCheck.valid) return err400Validation(res, 'Invalid bounty ID.');

      // Verify bounty exists and is open
      const bounties = await readBounties();
      const bounty = bounties.find(b => b.bounty_id === bountyId);
      if (!bounty) return err404NotFound(res, 'Bounty', { see: 'GET /api/v1/bounties' });
      if (bounty.status !== 'open') return err400Validation(res, `Bounty is ${bounty.status}, not open.`, {
        hint: 'Only open bounties can be claimed. Check GET /api/v1/bounties for available bounties.',
      });

      await daemon.dataLayer.appendLog('data/bounties/claims.jsonl', {
        bounty_id: bountyId,
        claimed_by: req.agentId,
        claimed_at: Date.now(),
      });
      res.json({ status: 'claimed', bounty_id: bountyId, claimed_by: req.agentId });
    } catch (err) {
      return err400Validation(res, err.message);
    }
  });

  router.post('/api/v1/bounties/:id/submit', auth, rateLimit('bounty_write'), async (req, res) => {
    try {
      const bountyId = req.params.id;
      const idCheck = validateString(bountyId, 100);
      if (!idCheck.valid) return err400Validation(res, 'Invalid bounty ID.');

      const { result } = req.body;
      if (!result) return err400MissingField(res, 'result', {
        hint: 'Submit your bounty work as a string in the result field.',
      });
      const rCheck = validateString(result, 5000);
      if (!rCheck.valid) return err400Validation(res, `result: ${rCheck.reason}`);

      // Verify bounty exists and is claimed
      const bounties = await readBounties();
      const bounty = bounties.find(b => b.bounty_id === bountyId);
      if (!bounty) return err404NotFound(res, 'Bounty', { see: 'GET /api/v1/bounties' });
      if (bounty.status !== 'open' && bounty.status !== 'claimed') {
        return err400Validation(res, `Bounty is ${bounty.status}, cannot submit.`, {
          hint: 'Only open or claimed bounties accept submissions.',
        });
      }

      await daemon.dataLayer.appendLog('data/bounties/submissions.jsonl', {
        bounty_id: bountyId,
        submitted_by: req.agentId,
        result: result.trim(),
        submitted_at: Date.now(),
      });
      res.json({ status: 'submitted', bounty_id: bountyId });
    } catch (err) {
      return err400Validation(res, err.message);
    }
  });

  router.post('/api/v1/bounties/:id/judge', auth, rateLimit('bounty_write'), async (req, res) => {
    try {
      const bountyId = req.params.id;
      const idCheck = validateString(bountyId, 100);
      if (!idCheck.valid) return err400Validation(res, 'Invalid bounty ID.');

      const { verdict, agent_id } = req.body;
      if (!verdict || (verdict !== 'accept' && verdict !== 'reject')) {
        return err400Validation(res, 'verdict must be "accept" or "reject".', {
          example: { verdict: 'accept', agent_id: 'agent-id-who-submitted' },
        });
      }
      if (agent_id) {
        const aidCheck = validateAgentId(agent_id);
        if (!aidCheck.valid) return err400Validation(res, `agent_id: ${aidCheck.reason}`);
      }

      // Authorization: only the bounty poster can judge
      const bounties = await readBounties();
      const bounty = bounties.find(b => b.bounty_id === bountyId);
      if (!bounty) return err404NotFound(res, 'Bounty', { see: 'GET /api/v1/bounties' });
      if (bounty.posted_by !== req.agentId) {
        return agentError(res, 403, {
          error: 'forbidden',
          message: 'Only the bounty poster can judge submissions.',
        });
      }

      await daemon.dataLayer.appendLog('data/bounties/judgments.jsonl', {
        bounty_id: bountyId,
        judged_by: req.agentId,
        target_agent: agent_id,
        verdict,
        judged_at: Date.now(),
      });

      // If accepted and wallet available, pay the bounty
      if (verdict === 'accept' && agent_id && daemon.hubWallet) {
        await daemon.publicLedger.record({
          type: 'bounty',
          from_agent_id: req.agentId,
          to_agent_id: agent_id,
          bounty_id: bountyId,
          amount_sats: bounty.reward_sats || 0,
          verdict: 'accepted',
        });
      }

      res.json({ status: 'judged', verdict, bounty_id: bountyId });
    } catch (err) {
      return err400Validation(res, err.message);
    }
  });

  return router;
}
