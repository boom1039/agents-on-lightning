/**
 * Agent Events Routes — GET /api/v1/agents/me/events
 *
 * Unified chronological event feed. Merges wallet transactions,
 * messages, capital ledger activity, channel state, security events,
 * and social activity into a single stream sorted newest-first.
 */

import { Router } from 'express';
import { requireAuth } from '../identity/auth.js';
import { rateLimit } from '../identity/rate-limiter.js';
import { err400Validation, err500Internal } from '../identity/agent-friendly-errors.js';
import { listStoredJourneyEvents } from '../monitor/journey-monitor.js';

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

/**
 * Parse a `since` value into a Unix timestamp (ms).
 * Accepts ISO 8601 strings or epoch milliseconds.
 * Returns null if the value is falsy or unparseable.
 */
function parseSince(raw) {
  if (!raw) return null;

  // Epoch ms (numeric string or number)
  const asNum = Number(raw);
  if (Number.isFinite(asNum) && asNum > 0) {
    // If it looks like seconds (< 1e12), convert to ms
    return asNum < 1e12 ? asNum * 1000 : asNum;
  }

  // ISO 8601 string
  const parsed = Date.parse(raw);
  if (Number.isFinite(parsed)) return parsed;

  return null;
}

/**
 * Normalize any timestamp (epoch ms, epoch s, or ISO string) to ISO 8601.
 */
function toISO(ts) {
  if (!ts) return null;
  if (typeof ts === 'string') {
    // Already ISO — validate and return
    const d = new Date(ts);
    return Number.isFinite(d.getTime()) ? d.toISOString() : null;
  }
  if (typeof ts === 'number') {
    // epoch seconds vs ms heuristic
    const ms = ts < 1e12 ? ts * 1000 : ts;
    return new Date(ms).toISOString();
  }
  return null;
}

/**
 * Extract a numeric timestamp (epoch ms) from an event-like object.
 * Different subsystems use different field names.
 */
function extractTs(obj) {
  // Try common fields in priority order
  for (const field of ['sent_at', 'recorded_at', '_ts', 'proposed_at', 'accepted_at', 'broken_at']) {
    const val = obj[field];
    if (typeof val === 'number' && val > 0) return val;
    if (typeof val === 'string') {
      const parsed = Date.parse(val);
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  return 0;
}

/**
 * Collect events from a single source. Swallows errors so one failing
 * subsystem never blocks the whole feed.
 */
async function collectSafe(_label, fn) {
  try {
    return await fn();
  } catch (err) {
    // Best-effort — skip this source silently
    return [];
  }
}

export function agentEventsRoutes(daemon) {
  const router = Router();
  const auth = requireAuth(daemon.agentRegistry);

  // Read agents me events.
  // @agent-route {"auth":"agent","domain":"identity","subgroup":"Agents","label":"events","summary":"Read agents me events.","order":100,"tags":["identity","read","agent"],"doc":"skills/identity.txt"}
  router.get('/api/v1/agents/me/events', auth, rateLimit('identity_read'), async (req, res) => {
    try {
      const sinceRaw = req.query.since;
      const limitRaw = req.query.limit;

      // Parse since
      const since = parseSince(sinceRaw);
      if (sinceRaw && since === null) {
        return err400Validation(res, 'Invalid "since" parameter. Use ISO 8601 (e.g. 2026-04-04T00:00:00Z) or epoch milliseconds.', {
          hint: 'Example: ?since=2026-04-04T00:00:00.000Z or ?since=1743724800000',
        });
      }

      // Parse limit
      let limit = parseInt(limitRaw, 10) || DEFAULT_LIMIT;
      if (limit < 1) limit = 1;
      if (limit > MAX_LIMIT) limit = MAX_LIMIT;

      const agentId = req.agentId;
      const events = [];

      // --- Wallet transactions ---
      const walletEvents = await collectSafe('wallet', async () => {
        const txs = await daemon.publicLedger?.getAgentTransactions(agentId);
        if (!txs) return [];
        return txs.map(tx => ({
          type: `wallet:${tx.type || 'unknown'}`,
          timestamp: toISO(tx.recorded_at || tx._ts),
          _sort_ts: tx.recorded_at || tx._ts || 0,
          data: {
            ledger_id: tx.ledger_id,
            amount_sats: tx.amount_sats,
            type: tx.type,
            from_agent_id: tx.from_agent_id || null,
            to_agent_id: tx.to_agent_id || null,
          },
        }));
      });
      events.push(...walletEvents);

      // --- Messages (inbox — received messages) ---
      const messageEvents = await collectSafe('messages', async () => {
        const msgs = await daemon.messaging?.getInbox(agentId, {});
        if (!msgs) return [];
        return msgs.map(m => ({
          type: `message:${m.direction || 'received'}`,
          timestamp: toISO(m.sent_at || m._ts),
          _sort_ts: m.sent_at || m._ts || 0,
          data: {
            message_id: m.message_id,
            from: m.from,
            to: m.to,
            message_type: m.type,
            content: m.content,
          },
        }));
      });
      events.push(...messageEvents);

      // --- Capital ledger activity ---
      const capitalEvents = await collectSafe('capital', async () => {
        const result = await daemon.capitalLedger?.readActivity({ agentId, limit: MAX_LIMIT });
        if (!result?.entries) return [];
        return result.entries.map(e => ({
          type: `capital:${e.type || 'unknown'}`,
          timestamp: toISO(e._ts),
          _sort_ts: e._ts || 0,
          data: {
            type: e.type,
            amount_sats: e.amount_sats,
            from_bucket: e.from_bucket || null,
            to_bucket: e.to_bucket || null,
            reference: e.reference || null,
            balance_after: e.balance_after || null,
          },
        }));
      });
      events.push(...capitalEvents);

      // --- Channel state (open requests from channel opener) ---
      const channelEvents = await collectSafe('channels', async () => {
        if (!daemon.channelOpener?._state) return [];
        const entries = Object.values(daemon.channelOpener._state)
          .filter(e => e.agent_id === agentId);
        return entries.map(e => ({
          type: `channel:${e.status || 'unknown'}`,
          timestamp: toISO(e.requested_at || e.opened_at || e._ts),
          _sort_ts: extractTs({ _ts: e.requested_at ? Date.parse(e.requested_at) : (e._ts || 0) }),
          data: {
            channel_point: e.channel_point || null,
            peer_pubkey: e.peer_pubkey || null,
            local_funding_amount: e.local_funding_amount || null,
            status: e.status,
            failed_reason: e.failed_reason || null,
          },
        }));
      });
      events.push(...channelEvents);

      // --- Security audit events for this agent ---
      const securityEvents = await collectSafe('security', async () => {
        const agentEntries = await listStoredJourneyEvents({
          agentId,
          order: 'DESC',
          limit: MAX_LIMIT * 10,
        });
        return agentEntries.map(e => ({
          type: `security:${e.event || 'unknown'}`,
          timestamp: toISO(e._ts),
          _sort_ts: e._ts || 0,
          data: {
            event: e.event,
            category: e.category || null,
            operation: e.operation || null,
            method: e.method || null,
            path: e.path || null,
            status: e.status || null,
          },
        }));
      });
      events.push(...securityEvents);

      // --- Social: alliances involving this agent ---
      const allianceEvents = await collectSafe('social', async () => {
        const alliances = await daemon.allianceManager?.list(agentId);
        if (!alliances) return [];
        return alliances.map(a => ({
          type: `social:alliance_${a.status || 'unknown'}`,
          timestamp: toISO(a.accepted_at || a.proposed_at || a.broken_at),
          _sort_ts: a.accepted_at || a.proposed_at || a.broken_at || 0,
          data: {
            alliance_id: a.alliance_id,
            proposer: a.proposer,
            partner: a.partner,
            status: a.status,
            description: a.terms?.description || null,
          },
        }));
      });
      events.push(...allianceEvents);

      // --- Apply since filter ---
      let filtered = events;
      if (since) {
        filtered = events.filter(e => e._sort_ts >= since);
      }

      // --- Sort newest first ---
      filtered.sort((a, b) => b._sort_ts - a._sort_ts);

      // --- Apply limit ---
      const page = filtered.slice(0, limit);

      // --- Compute cursor (timestamp of oldest event in response for pagination) ---
      const cursor = page.length > 0
        ? toISO(page[page.length - 1]._sort_ts)
        : null;

      // --- Strip internal _sort_ts from response ---
      const output = page.map(({ _sort_ts, ...rest }) => rest);

      res.json({
        events: output,
        cursor,
      });
    } catch (err) {
      return err500Internal(res, 'fetching event feed');
    }
  });

  return router;
}

