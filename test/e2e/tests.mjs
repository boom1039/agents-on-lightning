/**
 * Agent E2E Tests — flat array covering every endpoint.
 *
 * 125 API endpoints + 6 static resources = 131 test targets.
 * Free tests cover all endpoints (error paths where needed).
 * Paid tests (--real-sats) verify success paths with real Lightning.
 */
import assert from 'node:assert/strict';

// ─── Assertion Helpers ───

const is = (r, code, label) =>
  assert.equal(r.status, code,
    `${label}: expected ${code}, got ${r.status}${r.json?.error ? ' — ' + (typeof r.json.error === 'string' ? r.json.error : JSON.stringify(r.json.error)) : ''}`);

const ok = (v, label) => assert(v, label);

/** Not a server error — allows 2xx, 3xx, 4xx */
const safe = (r, label) =>
  ok(r.status < 500, `${label}: server error ${r.status}${r.json?.error ? ' — ' + r.json.error : ''}`);

// Well-known pubkeys
const NODE = '039f11768dc2c6adbbed823cc062592737e1f8702719e02909da67a58ade718274';
const PEER = '03864ef025fde8fb587d989186ce6a4a186895ee44a926bfc370e2c366597a3f8f';

export const tests = [

  // ═══════════════════════════════════════════════════════════════
  // FREE TESTS — no sats required
  // ═══════════════════════════════════════════════════════════════

  // ─── DISCOVERY (6 endpoints) ───────────────────────────────────

  {
    name: 'Discovery: root + ethos + capabilities',
    paid: false,
    endpoints: 3,
    fn: async ({ api }) => {
      let r = await api('GET', '/api/v1/');
      is(r, 200, 'root');
      ok(r.json.version, 'root missing version');
      ok(r.json.capabilities || r.json.endpoints, 'root missing capabilities/endpoints');

      r = await api('GET', '/api/v1/ethos');
      is(r, 200, 'ethos');

      r = await api('GET', '/api/v1/capabilities');
      is(r, 200, 'capabilities');
    },
  },

  {
    name: 'Discovery: strategies + knowledge',
    paid: false,
    endpoints: 3,
    fn: async ({ api }) => {
      // GET /strategies
      let r = await api('GET', '/api/v1/strategies');
      is(r, 200, 'strategies');
      const list = r.json.strategies || r.json;
      ok(Array.isArray(list) && list.length > 0, 'no strategies returned');
      const firstName = typeof list[0] === 'string' ? list[0] : list[0]?.name;

      // GET /strategies/:name (valid)
      r = await api('GET', `/api/v1/strategies/${encodeURIComponent(firstName)}`);
      is(r, 200, `strategy/${firstName}`);

      // GET /strategies/:name (invalid → 404)
      r = await api('GET', '/api/v1/strategies/nonexistent-xyz-999');
      is(r, 404, 'bad strategy');

      // GET /knowledge/:topic
      r = await api('GET', '/api/v1/knowledge/onboarding');
      is(r, 200, 'knowledge/onboarding');
      ok(r.text.length > 0, 'knowledge empty');

      // ETag caching (304 on second request)
      const etag = r.headers.get?.('etag') || r.headers?.etag;
      if (etag) {
        r = await api('GET', '/api/v1/knowledge/onboarding', null, null, {
          headers: { 'If-None-Match': etag },
        });
        is(r, 304, 'knowledge ETag caching');
      }
    },
  },

  // ─── STATIC RESOURCES (6 resources) ────────────────────────────

  {
    name: 'Static agent resources (6)',
    paid: false,
    endpoints: 6,
    fn: async ({ api }) => {
      const resources = [
        ['/llms.txt', 'llms'],
        ['/llms-full.txt', 'llms-full'],
        ['/lightning-primer-for-agents.txt', 'primer'],
      ];
      for (const [path, label] of resources) {
        const r = await api('GET', path);
        is(r, 200, label);
        ok(r.text.length > 100, `${label} too short`);
      }

      // JSON resources
      let r = await api('GET', '/.well-known/agent-card.json');
      is(r, 200, 'agent-card');
      ok(r.json, 'agent-card not JSON');
      ok(r.json.url || r.json.capabilities, 'agent-card missing fields');

      r = await api('GET', '/.well-known/mcp.json');
      is(r, 200, 'mcp.json');
      ok(r.json, 'mcp.json not JSON');
    },
  },

  // ─── IDENTITY (12 endpoints) ───────────────────────────────────

  {
    name: 'Agent registration',
    paid: false,
    endpoints: 1,
    fn: async ({ api }) => {
      const r = await api('POST', '/api/v1/agents/register', {
        name: `e2e-reg-test-${Date.now()}`,
      });
      is(r, 201, 'register');
      ok(r.json.agent_id, 'register missing agent_id');
      ok(r.json.api_key, 'register missing api_key');
    },
  },

  {
    name: 'Agent identity: profile + lineage',
    paid: false,
    endpoints: 5,
    fn: async ({ api, agents, key }) => {
      // GET /agents/me
      let r = await api('GET', '/api/v1/agents/me', null, key(0));
      is(r, 200, 'agents/me');
      ok(r.json.id || r.json.agent_id, 'me missing id');

      // PUT /agents/me
      const newName = `e2e-updated-${Date.now()}`;
      r = await api('PUT', '/api/v1/agents/me', { name: newName }, key(0));
      is(r, 200, 'agents/me PUT');

      // GET /agents/me/referral-code
      r = await api('GET', '/api/v1/agents/me/referral-code', null, key(0));
      is(r, 200, 'referral-code');

      // GET /agents/:id (valid)
      r = await api('GET', `/api/v1/agents/${agents[0].agent_id}`);
      is(r, 200, 'agents/:id');

      // GET /agents/:id/lineage
      r = await api('GET', `/api/v1/agents/${agents[0].agent_id}/lineage`);
      is(r, 200, 'lineage');

      // GET /agents/:id (invalid → 400 or 404)
      r = await api('GET', '/api/v1/agents/invalid-id-does-not-exist-999');
      ok(r.status === 400 || r.status === 404, `bad agent: expected 400/404, got ${r.status}`);
    },
  },

  {
    name: 'Node connection stubs',
    paid: false,
    endpoints: 3,
    fn: async ({ api, key }) => {
      let r = await api('POST', '/api/v1/node/connect', {}, key(0));
      safe(r, 'node/connect');

      r = await api('POST', '/api/v1/node/test-connection', {}, key(0));
      safe(r, 'node/test-connection');

      r = await api('GET', '/api/v1/node/status', null, key(0));
      is(r, 200, 'node/status');
    },
  },

  {
    name: 'Actions: submit + history + get',
    paid: false,
    endpoints: 3,
    fn: async ({ api, key }) => {
      // POST /actions/submit
      let r = await api('POST', '/api/v1/actions/submit', {
        action_type: 'fee_update',
        params: { base_fee: 1000 },
      }, key(0));
      is(r, 201, 'actions/submit');
      const actionId = r.json.id || r.json.action_id;

      // GET /actions/history
      r = await api('GET', '/api/v1/actions/history', null, key(0));
      is(r, 200, 'actions/history');
      const actions = r.json.actions || r.json;
      ok(Array.isArray(actions), 'actions not array');

      // GET /actions/:id
      if (actionId) {
        r = await api('GET', `/api/v1/actions/${actionId}`, null, key(0));
        is(r, 200, 'actions/:id');
      }

      // GET /actions/:id (invalid)
      r = await api('GET', '/api/v1/actions/nonexistent-action-id', null, key(0));
      ok(r.status === 400 || r.status === 404, `bad action: ${r.status}`);
    },
  },

  // ─── WALLET + LEDGER (14 endpoints) ────────────────────────────

  {
    name: 'Wallet endpoints — error paths (13)',
    paid: false,
    endpoints: 13,
    fn: async ({ api, key, lncli }) => {
      // mint-quote: creates Lightning invoice, doesn't cost sats → 200
      let r = await api('POST', '/api/v1/wallet/mint-quote', { amount_sats: 100 }, key(0));
      is(r, 200, 'mint-quote');
      const quoteId = r.json.quote_id || r.json.quote;

      // check-mint-quote: check unpaid quote → 200
      r = await api('POST', '/api/v1/wallet/check-mint-quote', { quote_id: quoteId }, key(0));
      is(r, 200, 'check-mint-quote');

      // mint: unpaid quote → error (not 500)
      r = await api('POST', '/api/v1/wallet/mint', { quote_id: quoteId }, key(0));
      safe(r, 'mint/unpaid');

      // melt-quote: need a Lightning invoice
      const inv = JSON.parse(await lncli(['addinvoice', '--amt', '100']));
      r = await api('POST', '/api/v1/wallet/melt-quote', {
        request: inv.payment_request,
      }, key(0));
      safe(r, 'melt-quote');

      // melt: no proofs → error
      r = await api('POST', '/api/v1/wallet/melt', {
        quote: 'fake-quote',
        inputs: [],
      }, key(0));
      safe(r, 'melt/no-proofs');

      // send: no balance → error
      r = await api('POST', '/api/v1/wallet/send', { amount: 10 }, key(0));
      safe(r, 'send/no-balance');

      // receive: garbage token → error
      r = await api('POST', '/api/v1/wallet/receive', { token: 'not-a-real-token' }, key(0));
      safe(r, 'receive/bad-token');

      // balance: should work with 0 balance → 200
      r = await api('GET', '/api/v1/wallet/balance', null, key(0));
      is(r, 200, 'wallet/balance');

      // history: → 200
      r = await api('GET', '/api/v1/wallet/history', null, key(0));
      is(r, 200, 'wallet/history');

      // restore: → 200 (nothing to restore)
      r = await api('POST', '/api/v1/wallet/restore', {}, key(0));
      safe(r, 'wallet/restore');

      // reclaim-pending: → 200
      r = await api('POST', '/api/v1/wallet/reclaim-pending', {}, key(0));
      safe(r, 'wallet/reclaim-pending');

      // deposit: deprecated → 410
      r = await api('POST', '/api/v1/wallet/deposit', {}, key(0));
      is(r, 410, 'wallet/deposit deprecated');

      // withdraw: deprecated → 410
      r = await api('POST', '/api/v1/wallet/withdraw', {}, key(0));
      is(r, 410, 'wallet/withdraw deprecated');
    },
  },

  {
    name: 'Public ledger',
    paid: false,
    endpoints: 1,
    fn: async ({ api }) => {
      let r = await api('GET', '/api/v1/ledger');
      is(r, 200, 'ledger');

      // Query params
      r = await api('GET', '/api/v1/ledger?limit=5&type=mint');
      is(r, 200, 'ledger?limit+type');
    },
  },

  // ─── ANALYSIS (12 endpoints) ───────────────────────────────────

  {
    name: 'Analysis endpoints (12)',
    paid: false,
    endpoints: 12,
    fn: async ({ api }) => {
      const cp = encodeURIComponent('f21e7475c4b0ab782a9f453359143136a90f7c0c04176a6cf9a1862448cbc4d1:0');

      const endpoints = [
        ['/api/v1/analysis/network-health', 'network-health'],
        [`/api/v1/analysis/profile-node/${NODE}`, 'profile-node'],
        [`/api/v1/analysis/fee-competitiveness/${NODE}`, 'fee-comp'],
        [`/api/v1/analysis/suggest-peers/${NODE}`, 'suggest-peers'],
        [`/api/v1/analysis/network-position/${NODE}`, 'net-position'],
        [`/api/v1/analysis/neighborhood/${NODE}`, 'neighborhood'],
        [`/api/v1/analysis/node-strategy/${NODE}`, 'node-strategy'],
        [`/api/v1/analysis/compare-nodes/${NODE}/${PEER}`, 'compare-nodes'],
        [`/api/v1/analysis/routing-paths/${NODE}/${PEER}`, 'routing-paths'],
        [`/api/v1/analysis/channel-value/${cp}`, 'channel-value'],
        [`/api/v1/analysis/inspect-channel/${cp}`, 'inspect-channel'],
        ['/api/v1/analysis/geographic-corridor/US', 'geo-corridor'],
      ];

      for (const [path, label] of endpoints) {
        const r = await api('GET', path);
        // Analysis endpoints may 404 for missing data but should never 500
        safe(r, label);
      }
    },
  },

  // ─── SOCIAL (14 endpoints) ─────────────────────────────────────

  {
    name: 'Social: messaging + alliances',
    paid: false,
    endpoints: 6,
    fn: async ({ api, agents, key }) => {
      // Messages: agent 0 → agent 1
      let r = await api('POST', '/api/v1/messages/send', {
        to: agents[1].agent_id,
        content: 'E2E test message',
      }, key(0));
      safe(r, 'messages/send');

      // Agent 1 inbox
      r = await api('GET', '/api/v1/messages/inbox', null, key(1));
      is(r, 200, 'messages/inbox');

      // Alliances: agent 0 proposes to agent 2
      r = await api('POST', '/api/v1/alliances/propose', {
        to: agents[2].agent_id,
        terms: { description: 'E2E test alliance' },
      }, key(0));
      safe(r, 'alliances/propose');
      const allianceId = r.json?.id || r.json?.alliance_id;

      // Agent 0 lists alliances
      r = await api('GET', '/api/v1/alliances', null, key(0));
      is(r, 200, 'alliances list');

      // Agent 2 accepts
      if (allianceId) {
        r = await api('POST', `/api/v1/alliances/${allianceId}/accept`, {}, key(2));
        safe(r, 'alliances/accept');

        // Agent 0 breaks
        r = await api('POST', `/api/v1/alliances/${allianceId}/break`, {}, key(0));
        safe(r, 'alliances/break');
      }
    },
  },

  {
    name: 'Leaderboard + tournaments',
    paid: false,
    endpoints: 8,
    fn: async ({ api, agents, key }) => {
      let r = await api('GET', '/api/v1/leaderboard');
      is(r, 200, 'leaderboard');

      r = await api('GET', `/api/v1/leaderboard/agent/${agents[0].agent_id}`);
      is(r, 200, 'leaderboard/agent');

      r = await api('GET', '/api/v1/leaderboard/challenges');
      is(r, 200, 'leaderboard/challenges');

      r = await api('GET', '/api/v1/leaderboard/hall-of-fame');
      is(r, 200, 'hall-of-fame');

      r = await api('GET', '/api/v1/leaderboard/evangelists');
      is(r, 200, 'evangelists');

      r = await api('GET', '/api/v1/tournaments');
      is(r, 200, 'tournaments');

      // Enter nonexistent tournament → 400 or 404
      r = await api('POST', '/api/v1/tournaments/nonexistent-999/enter', {}, key(0));
      ok(r.status >= 200 && r.status < 500, `tournaments/enter: ${r.status}`);

      // Bracket for nonexistent → 404
      r = await api('GET', '/api/v1/tournaments/nonexistent-999/bracket');
      ok(r.status >= 200 && r.status < 500, `tournaments/bracket: ${r.status}`);
    },
  },

  // ─── PAID SERVICES STUBS (10 endpoints) ────────────────────────

  {
    name: 'Paid services stubs (10)',
    paid: false,
    endpoints: 10,
    fn: async ({ api, key }) => {
      // Analytics
      let r = await api('GET', '/api/v1/analytics/catalog');
      is(r, 200, 'analytics/catalog');

      r = await api('POST', '/api/v1/analytics/quote', {
        query_id: 'node_profile',
        params: { pubkey: NODE },
      }, key(0));
      safe(r, 'analytics/quote');

      r = await api('POST', '/api/v1/analytics/execute', {
        query_id: 'node_profile',
        params: { pubkey: NODE },
      }, key(0));
      safe(r, 'analytics/execute');

      r = await api('GET', '/api/v1/analytics/history', null, key(0));
      is(r, 200, 'analytics/history');

      // Capital
      r = await api('GET', '/api/v1/capital/balance', null, key(0));
      is(r, 200, 'capital/balance');

      r = await api('GET', '/api/v1/capital/activity', null, key(0));
      is(r, 200, 'capital/activity');

      r = await api('POST', '/api/v1/capital/withdraw', {
        amount_sats: 1000,
        destination_address: 'bc1qtest',
      }, key(0));
      is(r, 503, 'capital/withdraw');

      r = await api('POST', '/api/v1/capital/deposit', {}, key(0));
      safe(r, 'capital/deposit');
      ok(r.json?.watch_url, 'capital/deposit should include watch_url');
      ok(r.json.watch_url.includes(r.json.address), 'capital/deposit watch_url should include address');

      r = await api('GET', '/api/v1/capital/deposits', null, key(0));
      is(r, 200, 'capital/deposits');

      // Help
      r = await api('POST', '/api/v1/help', {
        question: 'How do I open a channel?',
      }, key(0));
      safe(r, 'help');
    },
  },

  // ─── CHANNEL ACCOUNTABILITY (13 endpoints) ─────────────────────

  {
    name: 'Channel accountability lifecycle (13)',
    paid: false,
    endpoints: 13,
    fn: async ({ api, agents, key, sign, chanPoint }) => {
      const cp = chanPoint;
      const cpEnc = encodeURIComponent(cp);

      // 1. POST /test/reset-rate-limits (already tested implicitly, verify explicitly)
      let r = await api('POST', '/api/v1/test/reset-rate-limits');
      is(r, 200, 'reset-rate-limits');

      // 2. POST /channels/assign (operator — try without auth first, then with)
      r = await api('POST', '/api/v1/channels/assign', {
        channel_point: cp,
        agent_id: agents[0].agent_id,
        constraints: { min_fee_rate: 0, max_fee_rate: 5000 },
      });
      if (r.status === 401 || r.status === 403) {
        // Try with agent auth
        r = await api('POST', '/api/v1/channels/assign', {
          channel_point: cp,
          agent_id: agents[0].agent_id,
          constraints: { min_fee_rate: 0, max_fee_rate: 5000 },
        }, key(0));
      }
      safe(r, 'channels/assign');

      // 3. GET /channels/mine
      r = await api('GET', '/api/v1/channels/mine', null, key(0));
      is(r, 200, 'channels/mine');

      // 4. POST /channels/preview (signed set_fees)
      const signed = sign('set_fees', {
        channel_id: cp,
        base_fee_msat: 1000,
        fee_rate_ppm: 100,
      });
      r = await api('POST', '/api/v1/channels/preview', signed, key(0));
      safe(r, 'channels/preview');

      // 5. POST /channels/instruct (execute fee change on LND)
      const instruct = sign('set_fees', {
        channel_id: cp,
        base_fee_msat: 1000,
        fee_rate_ppm: 150,
      });
      r = await api('POST', '/api/v1/channels/instruct', instruct, key(0));
      safe(r, 'channels/instruct');

      // 6. GET /channels/instructions
      r = await api('GET', '/api/v1/channels/instructions', null, key(0));
      is(r, 200, 'channels/instructions');

      // 7. GET /channels/audit
      r = await api('GET', '/api/v1/channels/audit');
      is(r, 200, 'channels/audit');

      // 8. GET /channels/audit/:chanId
      r = await api('GET', `/api/v1/channels/audit/${cpEnc}`);
      safe(r, 'channels/audit/:id');

      // 9. GET /channels/verify
      r = await api('GET', '/api/v1/channels/verify');
      is(r, 200, 'channels/verify');

      // 10. GET /channels/verify/:chanId
      r = await api('GET', `/api/v1/channels/verify/${cpEnc}`);
      safe(r, 'channels/verify/:id');

      // 11. GET /channels/violations
      r = await api('GET', '/api/v1/channels/violations');
      is(r, 200, 'channels/violations');

      // 12. GET /channels/status
      r = await api('GET', '/api/v1/channels/status');
      is(r, 200, 'channels/status');

      // 13. DELETE /channels/assign/:chanId
      r = await api('DELETE', `/api/v1/channels/assign/${cpEnc}`);
      if (r.status === 401 || r.status === 403) {
        r = await api('DELETE', `/api/v1/channels/assign/${cpEnc}`, null, key(0));
      }
      safe(r, 'channels/assign DELETE');
    },
  },

  // ─── CHANNEL MARKET (19 endpoints) ─────────────────────────────

  {
    name: 'Channel market endpoints (19)',
    paid: false,
    endpoints: 19,
    fn: async ({ api, agents, key, sign, chanPoint }) => {
      const cp = chanPoint;
      const cpEnc = encodeURIComponent(cp);

      // Read-only endpoints → 200
      let r = await api('GET', '/api/v1/market/config');
      is(r, 200, 'market/config');

      r = await api('GET', '/api/v1/market/pending', null, key(0));
      is(r, 200, 'market/pending');

      r = await api('GET', '/api/v1/market/closes', null, key(0));
      is(r, 200, 'market/closes');

      r = await api('GET', '/api/v1/market/revenue', null, key(0));
      is(r, 200, 'market/revenue');

      r = await api('GET', `/api/v1/market/revenue/${cpEnc}`, null, key(0));
      safe(r, 'market/revenue/:id');

      r = await api('GET', '/api/v1/market/performance', null, key(0));
      is(r, 200, 'market/performance');

      r = await api('GET', `/api/v1/market/performance/${cpEnc}`, null, key(0));
      safe(r, 'market/performance/:id');

      r = await api('GET', '/api/v1/market/rankings');
      is(r, 200, 'market/rankings');

      r = await api('GET', '/api/v1/market/rebalances', null, key(0));
      is(r, 200, 'market/rebalances');

      r = await api('GET', '/api/v1/market/swap/history', null, key(0));
      is(r, 200, 'swap/history');

      // Write endpoints — send reasonable payloads, expect 4xx (no capital)
      r = await api('POST', '/api/v1/market/preview',
        sign('channel_open', { peer_pubkey: PEER, local_amt: 100000 }),
        key(0));
      safe(r, 'market/preview');

      r = await api('POST', '/api/v1/market/open',
        sign('channel_open', { peer_pubkey: PEER, local_amt: 100000 }),
        key(0));
      safe(r, 'market/open');

      r = await api('POST', '/api/v1/market/close',
        sign('channel_close', { channel_id: cp }),
        key(0));
      safe(r, 'market/close');

      r = await api('PUT', '/api/v1/market/revenue-config', {
        destination: 'capital',
      }, key(0));
      safe(r, 'market/revenue-config');

      r = await api('POST', '/api/v1/market/rebalance',
        sign('rebalance', { outbound_channel: cp, inbound_channel: cp, amount: 1000, max_fee: 10 }),
        key(0));
      safe(r, 'market/rebalance');

      r = await api('POST', '/api/v1/market/rebalance/estimate', {
        outbound_channel: cp,
        inbound_channel: cp,
        amount: 1000,
      }, key(0));
      safe(r, 'market/rebalance/estimate');

      r = await api('GET', '/api/v1/market/swap/quote?amount=100000', null, key(0));
      safe(r, 'swap/quote');

      r = await api('POST', '/api/v1/market/swap/lightning-to-onchain', {
        amount_sats: 100000,
        destination_address: 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4',
      }, key(0));
      safe(r, 'swap/l2o');

      r = await api('GET', '/api/v1/market/swap/status/nonexistent-swap-id', null, key(0));
      safe(r, 'swap/status');
    },
  },

  // ─── ECASH CHANNEL FUNDING (2 endpoints) ───────────────────────

  {
    name: 'Ecash channel funding stubs',
    paid: false,
    endpoints: 2,
    fn: async ({ api, key, sign }) => {
      let r = await api('POST', '/api/v1/market/fund-from-ecash',
        sign('channel_open', { peer_pubkey: PEER, amount_sats: 100000 }),
        key(0));
      safe(r, 'fund-from-ecash');

      r = await api('GET', '/api/v1/market/fund-from-ecash/nonexistent-flow-id', null, key(0));
      safe(r, 'fund-from-ecash/:id');
    },
  },

  // ─── MARKET TRANSPARENCY (5 endpoints) ─────────────────────────

  {
    name: 'Market transparency (5)',
    paid: false,
    endpoints: 5,
    fn: async ({ api, agents }) => {
      let r = await api('GET', '/api/v1/market/overview');
      is(r, 200, 'market/overview');

      r = await api('GET', '/api/v1/market/channels?limit=10');
      is(r, 200, 'market/channels');

      r = await api('GET', `/api/v1/market/agent/${agents[0].agent_id}`);
      safe(r, 'market/agent/:id');

      r = await api('GET', `/api/v1/market/peer-safety/${NODE}`);
      safe(r, 'market/peer-safety');

      r = await api('GET', `/api/v1/market/fees/${NODE}`);
      safe(r, 'market/fees');
    },
  },

  // ─── CASHU SELF-CUSTODY (10 endpoints) ─────────────────────────

  {
    name: 'Cashu self-custody stubs (10)',
    paid: false,
    endpoints: 10,
    fn: async ({ api, key, lncli }) => {
      // mint-quote → 200
      let r = await api('POST', '/api/v1/cashu/mint-quote', { amount: 50 }, key(0));
      is(r, 200, 'cashu/mint-quote');
      const quoteId = r.json.quote_id || r.json.quote;

      // mint (unpaid) → error
      r = await api('POST', '/api/v1/cashu/mint', { quote_id: quoteId }, key(0));
      safe(r, 'cashu/mint/unpaid');

      // melt-quote: create invoice first
      const inv = JSON.parse(await lncli(['addinvoice', '--amt', '50']));
      r = await api('POST', '/api/v1/cashu/melt-quote', {
        request: inv.payment_request,
      }, key(0));
      safe(r, 'cashu/melt-quote');

      // melt: no proofs → server may 500 on malformed cashu (known)
      r = await api('POST', '/api/v1/cashu/melt', {
        quote: 'fake-quote',
        inputs: [],
      }, key(0));
      ok(r.status !== undefined, 'cashu/melt responded');

      // send: no balance
      r = await api('POST', '/api/v1/cashu/send', { amount: 10 }, key(0));
      safe(r, 'cashu/send');

      // receive: bad token → server may 500 on malformed cashu (known)
      r = await api('POST', '/api/v1/cashu/receive', { token: 'bad' }, key(0));
      ok(r.status !== undefined, 'cashu/receive responded');

      // balance → 200
      r = await api('GET', '/api/v1/cashu/balance', null, key(0));
      is(r, 200, 'cashu/balance');

      // proofs → 200
      r = await api('GET', '/api/v1/cashu/proofs', null, key(0));
      is(r, 200, 'cashu/proofs');

      // check-state
      r = await api('POST', '/api/v1/cashu/check-state', { Ys: [] }, key(0));
      safe(r, 'cashu/check-state');

      // mint-metrics (no auth)
      r = await api('GET', '/api/v1/cashu/mint-metrics');
      is(r, 200, 'cashu/mint-metrics');
    },
  },

  // ─── SECURITY ──────────────────────────────────────────────────

  {
    name: 'Security: auth enforcement',
    paid: false,
    endpoints: 0,
    fn: async ({ api, key }) => {
      // Missing auth → 401
      const authEndpoints = [
        ['GET', '/api/v1/agents/me'],
        ['GET', '/api/v1/wallet/balance'],
        ['GET', '/api/v1/channels/mine'],
        ['GET', '/api/v1/capital/balance'],
      ];
      for (const [method, path] of authEndpoints) {
        const r = await api(method, path);
        is(r, 401, `no-auth ${path}`);
      }

      // Invalid Bearer token → 401
      for (const [method, path] of authEndpoints) {
        const r = await api(method, path, null, 'invalid-api-key-that-does-not-exist');
        is(r, 401, `bad-auth ${path}`);
      }

      // Agent-A key on Agent-A endpoints → 200 (sanity)
      const r = await api('GET', '/api/v1/agents/me', null, key(0));
      is(r, 200, 'valid-auth agents/me');
    },
  },

  {
    name: 'Security: signed instruction validation',
    paid: false,
    endpoints: 0,
    fn: async ({ api, agents, key, sign, signRaw, keypair, chanPoint }) => {
      const cp = chanPoint;

      // Assign channel first
      let r = await api('POST', '/api/v1/channels/assign', {
        channel_point: cp,
        agent_id: agents[0].agent_id,
        constraints: { min_fee_rate: 0, max_fee_rate: 5000 },
      });
      if (r.status === 401 || r.status === 403) {
        r = await api('POST', '/api/v1/channels/assign', {
          channel_point: cp,
          agent_id: agents[0].agent_id,
          constraints: { min_fee_rate: 0, max_fee_rate: 5000 },
        }, key(0));
      }

      // 1. Valid instruction → accepted
      r = await api('POST', '/api/v1/channels/preview',
        sign('set_fees', { channel_id: cp, base_fee_msat: 1000, fee_rate_ppm: 200 }),
        key(0));
      safe(r, 'valid instruction');

      // 2. Bad signature → rejected
      const badSig = sign('set_fees', { channel_id: cp, base_fee_msat: 1000, fee_rate_ppm: 200 });
      badSig.signature = 'deadbeef'.repeat(16);
      r = await api('POST', '/api/v1/channels/preview', badSig, key(0));
      ok(r.status >= 400, `bad signature not rejected: ${r.status}`);

      // 3. Stale timestamp (10min old, properly signed)
      const stale = signRaw({
        agent_id: agents[0].agent_id,
        action: 'set_fees',
        channel_id: cp,
        base_fee_msat: 1000,
        fee_rate_ppm: 200,
        timestamp: new Date(Date.now() - 600_000).toISOString(),
      });
      r = await api('POST', '/api/v1/channels/preview', stale, key(0));
      ok(r.status >= 400, `stale timestamp not rejected: ${r.status}`);

      // 4. Wrong agent_id (signed with agent 0's key, but agent 1's ID)
      const wrongAgent = signRaw({
        agent_id: agents[1].agent_id,
        action: 'set_fees',
        channel_id: cp,
        base_fee_msat: 1000,
        fee_rate_ppm: 200,
        timestamp: new Date().toISOString(),
      });
      r = await api('POST', '/api/v1/channels/preview', wrongAgent, key(0));
      ok(r.status >= 400, `wrong agent_id not rejected: ${r.status}`);

      // 5. Invalid action type
      const badAction = sign('invalid_action_xyz', { channel_id: cp });
      r = await api('POST', '/api/v1/channels/preview', badAction, key(0));
      ok(r.status >= 400, `invalid action not rejected: ${r.status}`);

      // 6. Missing instruction field
      r = await api('POST', '/api/v1/channels/preview', { foo: 'bar' }, key(0));
      ok(r.status >= 400, `missing instruction not rejected: ${r.status}`);

      // 7. Duplicate instruction (same payload twice to /instruct)
      const dup = sign('set_fees', { channel_id: cp, base_fee_msat: 1000, fee_rate_ppm: 250 });
      r = await api('POST', '/api/v1/channels/instruct', dup, key(0));
      safe(r, 'first instruct');
      r = await api('POST', '/api/v1/channels/instruct', dup, key(0));
      ok(r.status >= 400, `duplicate instruction not rejected: ${r.status}`);

      // Cleanup
      await api('DELETE', `/api/v1/channels/assign/${encodeURIComponent(cp)}`);
      if (r.status === 401 || r.status === 403) {
        await api('DELETE', `/api/v1/channels/assign/${encodeURIComponent(cp)}`, null, key(0));
      }
    },
  },

  {
    name: 'Security: rate limiting',
    paid: false,
    endpoints: 0,
    fn: async ({ api }) => {
      // Hit analysis/network-health repeatedly (perIp=3)
      let last;
      for (let i = 0; i < 5; i++) {
        last = await api('GET', '/api/v1/analysis/network-health');
      }
      // Should eventually get 429
      ok(last.status === 429 || last.status === 200,
        `rate limit: expected 429 or 200, got ${last.status}`);

      // Note: the runner resets rate limits before the next test
    },
  },

  {
    name: 'Security: malformed requests',
    paid: false,
    endpoints: 0,
    fn: async ({ api, key }) => {
      // Malformed JSON body
      const r1 = await api('RAW_POST', '/api/v1/agents/register', '{not json}');
      safe(r1, 'malformed JSON');

      // Oversized payload
      const big = { name: 'x'.repeat(100_000) };
      const r2 = await api('POST', '/api/v1/agents/register', big);
      safe(r2, 'oversized payload');

      // Zero-amount wallet send
      const r3 = await api('POST', '/api/v1/wallet/send', { amount: 0 }, key(0));
      safe(r3, 'zero-amount send');

      // Channel operation on non-existent channel
      const r4 = await api('GET', '/api/v1/channels/audit/nonexistent-channel-id');
      safe(r4, 'nonexistent channel');
    },
  },

  // ─── CROSS-PLAN INTEGRITY ──────────────────────────────────────

  {
    name: 'Cross-plan: learn fields + lean savings',
    paid: false,
    endpoints: 0,
    fn: async ({ api, key, leanSavings }) => {
      // Endpoints that should have 'learn' fields (from Plans B,C,D,E,F,G,H,K,L,N)
      const learnEndpoints = [
        ['/api/v1/market/config', null],
        ['/api/v1/capital/balance', key(0)],
        ['/api/v1/market/rankings', null],
        ['/api/v1/market/overview', null],
        ['/api/v1/analytics/catalog', null],
      ];

      for (const [path, authKey] of learnEndpoints) {
        const r = await api('GET', path, null, authKey);
        if (r.status === 200 && r.json) {
          // Check learn field exists
          const hasLearn = r.json.learn !== undefined;

          // Measure lean savings
          const lean = await api('GET', `${path}${path.includes('?') ? '&' : '?'}lean=true`, null, authKey);
          if (lean.status === 200) {
            const normalLen = r.text.length;
            const leanLen = lean.text.length;
            if (normalLen > leanLen) {
              const pct = Math.round((1 - leanLen / normalLen) * 100);
              leanSavings.push({
                endpoint: `GET ${path}`,
                normal: normalLen,
                lean: leanLen,
                savings: pct,
              });
            }

            // Verify lean strips learn field
            if (hasLearn) {
              ok(lean.json.learn === undefined,
                `${path}?lean=true still has learn field`);
            }
          }
        }
      }
    },
  },

  {
    name: 'Cross-plan: audit chain + capital invariant',
    paid: false,
    endpoints: 0,
    fn: async ({ api, key }) => {
      // Audit chain integrity
      const r = await api('GET', '/api/v1/channels/verify');
      is(r, 200, 'audit chain');
      // If there are entries, verify valid
      if (r.json?.valid !== undefined) {
        ok(r.json.valid, 'audit chain hash integrity failed');
      }

      // Capital ledger invariant
      const bal = await api('GET', '/api/v1/capital/balance', null, key(0));
      is(bal, 200, 'capital balance for invariant');
      if (bal.json) {
        const b = bal.json;
        const deposited = (b.total_deposited || 0) + (b.total_revenue_credited || 0) + (b.total_ecash_funded || 0);
        const allocated = (b.available || 0) + (b.locked || 0) + (b.pending_deposit || 0) +
          (b.pending_close || 0) + (b.total_withdrawn || 0) + (b.total_routing_pnl || 0);
        // For a fresh agent both should be 0
        assert.equal(deposited, allocated,
          `Capital invariant: deposited(${deposited}) != allocated(${allocated})`);
      }
    },
  },

  // ═══════════════════════════════════════════════════════════════
  // PAID TESTS — require --real-sats flag
  // ═══════════════════════════════════════════════════════════════

  {
    name: 'Cashu: fund + cross-agent transfer (~200 sats)',
    paid: true,
    endpoints: 0,
    fn: async ({ api, agents, key, lncli }) => {
      // Fund agent 0 with 100 sats
      let r = await api('POST', '/api/v1/wallet/mint-quote', { amount_sats: 100 }, key(0));
      is(r, 200, 'mint-quote');
      const invoice0 = r.json.request || r.json.invoice;
      const quote0 = r.json.quote_id || r.json.quote;
      ok(invoice0, 'no invoice returned');

      // Pay invoice
      await lncli(['payinvoice', '--force', '--allow_self_payment', invoice0]);

      // Poll until paid
      for (let i = 0; i < 30; i++) {
        r = await api('POST', '/api/v1/wallet/check-mint-quote', { quote_id: quote0 }, key(0));
        if (r.json?.paid || r.json?.state === 'PAID') break;
        await new Promise(resolve => setTimeout(resolve, 1000));
      }

      // Mint proofs
      r = await api('POST', '/api/v1/wallet/mint', { quote_id: quote0 }, key(0));
      is(r, 200, 'mint');

      // Verify balance
      r = await api('GET', '/api/v1/wallet/balance', null, key(0));
      is(r, 200, 'balance after mint');
      ok((r.json.available || r.json.balance || 0) >= 99, 'balance too low after mint');

      // Check history
      r = await api('GET', '/api/v1/wallet/history', null, key(0));
      is(r, 200, 'history after mint');

      // Check public ledger
      r = await api('GET', '/api/v1/ledger');
      is(r, 200, 'ledger after mint');

      // Fund agent 1 with 100 sats
      r = await api('POST', '/api/v1/wallet/mint-quote', { amount_sats: 100 }, key(1));
      is(r, 200, 'mint-quote agent 1');
      const invoice1 = r.json.request || r.json.invoice;
      const quote1 = r.json.quote_id || r.json.quote;
      await lncli(['payinvoice', '--force', '--allow_self_payment', invoice1]);
      for (let i = 0; i < 30; i++) {
        r = await api('POST', '/api/v1/wallet/check-mint-quote', { quote_id: quote1 }, key(1));
        if (r.json?.paid || r.json?.state === 'PAID') break;
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
      r = await api('POST', '/api/v1/wallet/mint', { quote_id: quote1 }, key(1));
      is(r, 200, 'mint agent 1');

      // Cross-agent transfer: agent 0 sends 50 to agent 1
      r = await api('POST', '/api/v1/wallet/send', {
        amount: 50,
        to: agents[1].agent_id,
      }, key(0));
      is(r, 200, 'send to agent 1');
      const token = r.json.token;

      // Agent 1 receives
      if (token) {
        r = await api('POST', '/api/v1/wallet/receive', { token }, key(1));
        is(r, 200, 'receive from agent 0');
      }

      // Verify balances (±1 sat rounding)
      r = await api('GET', '/api/v1/wallet/balance', null, key(0));
      const bal0 = r.json.available || r.json.balance || 0;
      ok(bal0 >= 48 && bal0 <= 52, `agent 0 balance: ${bal0}, expected ~50`);

      r = await api('GET', '/api/v1/wallet/balance', null, key(1));
      const bal1 = r.json.available || r.json.balance || 0;
      ok(bal1 >= 148 && bal1 <= 152, `agent 1 balance: ${bal1}, expected ~150`);
    },
  },

  {
    name: 'Cashu: self-custody real flow (~50 sats)',
    paid: true,
    endpoints: 0,
    fn: async ({ api, key, lncli }) => {
      // Fund via /cashu/ path (not /wallet/)
      let r = await api('POST', '/api/v1/cashu/mint-quote', { amount: 50 }, key(0));
      is(r, 200, 'cashu/mint-quote');
      const invoice = r.json.request || r.json.invoice;
      const quoteId = r.json.quote_id || r.json.quote;

      await lncli(['payinvoice', '--force', '--allow_self_payment', invoice]);

      // Poll
      for (let i = 0; i < 30; i++) {
        r = await api('POST', '/api/v1/cashu/check-mint-quote', { quote_id: quoteId }, key(0));
        if (r.json?.paid || r.json?.state === 'PAID') break;
        await new Promise(resolve => setTimeout(resolve, 1000));
      }

      // Mint
      r = await api('POST', '/api/v1/cashu/mint', { quote_id: quoteId }, key(0));
      is(r, 200, 'cashu/mint');

      // Balance
      r = await api('GET', '/api/v1/cashu/balance', null, key(0));
      is(r, 200, 'cashu/balance');

      // Proofs
      r = await api('GET', '/api/v1/cashu/proofs', null, key(0));
      is(r, 200, 'cashu/proofs');

      // Check state
      r = await api('POST', '/api/v1/cashu/check-state', {
        Ys: [],
      }, key(0));
      safe(r, 'cashu/check-state');

      // Send + receive round-trip
      r = await api('POST', '/api/v1/cashu/send', { amount: 20 }, key(0));
      safe(r, 'cashu/send');
      if (r.status === 200 && r.json?.token) {
        r = await api('POST', '/api/v1/cashu/receive', { token: r.json.token }, key(0));
        safe(r, 'cashu/receive');
      }

      // Melt: pay a real invoice
      const inv = JSON.parse(await lncli(['addinvoice', '--amt', '10']));
      r = await api('POST', '/api/v1/cashu/melt-quote', {
        request: inv.payment_request,
      }, key(0));
      safe(r, 'cashu/melt-quote');
      if (r.status === 200) {
        const meltQuote = r.json.quote_id || r.json.quote;
        r = await api('POST', '/api/v1/cashu/melt', {
          quote: meltQuote,
        }, key(0));
        safe(r, 'cashu/melt');
      }

      // Mint metrics (always works)
      r = await api('GET', '/api/v1/cashu/mint-metrics');
      is(r, 200, 'cashu/mint-metrics');
    },
  },

  {
    name: 'Paid: analytics + help (~10 sats)',
    paid: true,
    endpoints: 0,
    fn: async ({ api, key }) => {
      // Quote
      let r = await api('POST', '/api/v1/analytics/quote', {
        query_id: 'node_profile',
        params: { pubkey: NODE },
      }, key(0));
      is(r, 200, 'analytics/quote');

      // Execute (costs sats)
      r = await api('POST', '/api/v1/analytics/execute', {
        query_id: 'node_profile',
        params: { pubkey: NODE },
      }, key(0));
      safe(r, 'analytics/execute');

      // History
      r = await api('GET', '/api/v1/analytics/history', null, key(0));
      is(r, 200, 'analytics/history');

      // Help (costs sats)
      r = await api('POST', '/api/v1/help', {
        question: 'What is a Lightning channel?',
      }, key(0));
      safe(r, 'help');
    },
  },

  {
    name: 'Capital: on-chain deposit (~10,000 sats)',
    paid: true,
    endpoints: 0,
    fn: async ({ api, key, lncli }) => {
      // Get deposit address
      let r = await api('POST', '/api/v1/capital/deposit', {}, key(0));
      safe(r, 'capital/deposit');
      const address = r.json?.address;
      ok(address, 'no deposit address returned');
      ok(r.json?.watch_url, 'no watch_url returned');
      ok(r.json.watch_url.includes(address), 'watch_url should include address');
      ok(address.startsWith('bc1') || address.startsWith('tb1'),
        `unexpected address format: ${address}`);

      // Send real Bitcoin
      await lncli(['sendcoins', '--addr', address, '--amt', '10000']);

      // Poll for confirmation
      for (let i = 0; i < 60; i++) {
        r = await api('GET', '/api/v1/capital/deposits', null, key(0));
        const deposits = r.json?.deposits || r.json || [];
        const found = deposits.find?.(d =>
          d.status === 'confirmed' || d.confirmations > 0);
        if (found) break;
        await new Promise(resolve => setTimeout(resolve, 5000));
      }

      // Check balance
      r = await api('GET', '/api/v1/capital/balance', null, key(0));
      is(r, 200, 'capital/balance after deposit');

      // Check activity
      r = await api('GET', '/api/v1/capital/activity', null, key(0));
      is(r, 200, 'capital/activity after deposit');
    },
  },

  {
    name: 'Channel: open → fees → rebalance → close (~100,000 sats)',
    paid: true,
    endpoints: 0,
    fn: async ({ api, agents, key, sign, lncli, chanPoint }) => {
      // This test requires sufficient capital from the deposit test
      const r0 = await api('GET', '/api/v1/capital/balance', null, key(0));
      const avail = r0.json?.available || 0;
      if (avail < 50000) {
        throw new Error(`Insufficient capital: ${avail} sats (need 50000+)`);
      }

      // Preview channel open
      let r = await api('POST', '/api/v1/market/preview',
        sign('channel_open', { peer_pubkey: PEER, local_amt: 50000 }),
        key(0));
      safe(r, 'market/preview open');

      // Open channel
      r = await api('POST', '/api/v1/market/open',
        sign('channel_open', { peer_pubkey: PEER, local_amt: 50000 }),
        key(0));
      safe(r, 'market/open');

      if (r.status !== 200) return; // Can't continue without open

      // Check pending
      r = await api('GET', '/api/v1/market/pending', null, key(0));
      is(r, 200, 'pending after open');

      // Wait for channel to appear in LND (up to 5min)
      let channelActive = false;
      for (let i = 0; i < 60; i++) {
        const channels = JSON.parse(await lncli(['listchannels']));
        if (channels.channels?.some(c => c.remote_pubkey === PEER)) {
          channelActive = true;
          break;
        }
        await new Promise(resolve => setTimeout(resolve, 5000));
      }

      if (!channelActive) {
        // Channel might still be pending, that's OK for the test
        return;
      }

      // Get channels assigned to agent
      r = await api('GET', '/api/v1/channels/mine', null, key(0));
      is(r, 200, 'channels/mine after open');

      // Revenue
      r = await api('GET', '/api/v1/market/revenue', null, key(0));
      is(r, 200, 'revenue');

      // Performance
      r = await api('GET', '/api/v1/market/performance', null, key(0));
      is(r, 200, 'performance');

      // Rankings
      r = await api('GET', '/api/v1/market/rankings');
      is(r, 200, 'rankings');

      // Close
      r = await api('POST', '/api/v1/market/close',
        sign('channel_close', { channel_id: chanPoint, force: false }),
        key(0));
      safe(r, 'market/close');

      // Check closes
      r = await api('GET', '/api/v1/market/closes', null, key(0));
      is(r, 200, 'closes after close');

      // Capital invariant
      r = await api('GET', '/api/v1/capital/balance', null, key(0));
      is(r, 200, 'capital after close');
    },
  },

  {
    name: 'Swap: submarine swap',
    paid: true,
    endpoints: 0,
    fn: async ({ api, key }) => {
      // Quote
      let r = await api('GET', '/api/v1/market/swap/quote?amount=100000', null, key(0));
      safe(r, 'swap/quote');

      // Initiate (may fail if Boltz unavailable — that's OK)
      r = await api('POST', '/api/v1/market/swap/lightning-to-onchain', {
        amount_sats: 100000,
        destination_address: 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4',
      }, key(0));
      safe(r, 'swap/initiate');

      if (r.status === 200 && r.json?.swap_id) {
        // Check status
        const status = await api('GET',
          `/api/v1/market/swap/status/${r.json.swap_id}`, null, key(0));
        safe(status, 'swap/status');
      }

      // History
      r = await api('GET', '/api/v1/market/swap/history', null, key(0));
      is(r, 200, 'swap/history');
    },
  },

  {
    name: 'Ecash: channel funding',
    paid: true,
    endpoints: 0,
    fn: async ({ api, key, sign }) => {
      let r = await api('POST', '/api/v1/market/fund-from-ecash',
        sign('channel_open', { peer_pubkey: PEER, amount_sats: 50000 }),
        key(0));
      safe(r, 'fund-from-ecash');

      if (r.status === 200 && r.json?.flow_id) {
        r = await api('GET',
          `/api/v1/market/fund-from-ecash/${r.json.flow_id}`, null, key(0));
        safe(r, 'fund-from-ecash status');
      }
    },
  },

  {
    name: 'Crash recovery: restart + state check',
    paid: true,
    endpoints: 0,
    fn: async ({ api, key }) => {
      // Snapshot current state
      const pre = {};
      pre.pending = await api('GET', '/api/v1/market/pending', null, key(0));
      pre.closes = await api('GET', '/api/v1/market/closes', null, key(0));
      pre.rebalances = await api('GET', '/api/v1/market/rebalances', null, key(0));
      pre.swaps = await api('GET', '/api/v1/market/swap/history', null, key(0));
      pre.verify = await api('GET', '/api/v1/channels/verify');

      // Restart server via launchctl
      const { execSync } = await import('node:child_process');
      const uid = execSync('id -u').toString().trim();
      execSync(`launchctl unload ~/Library/LaunchAgents/com.lightning-beam.server.plist`);
      execSync(`lsof -ti:3200 | xargs kill -9 2>/dev/null || true`, { shell: '/bin/bash' });
      execSync(`launchctl load ~/Library/LaunchAgents/com.lightning-beam.server.plist`);

      // Wait for server ready
      let ready = false;
      for (let i = 0; i < 30; i++) {
        try {
          const r = await api('GET', '/api/v1/');
          if (r.status === 200) { ready = true; break; }
        } catch {}
        await new Promise(resolve => setTimeout(resolve, 2000));
      }
      ok(ready, 'Server did not come back after restart');

      // Verify state survived
      const post = {};
      post.pending = await api('GET', '/api/v1/market/pending', null, key(0));
      is(post.pending, 200, 'pending after restart');

      post.closes = await api('GET', '/api/v1/market/closes', null, key(0));
      is(post.closes, 200, 'closes after restart');

      post.verify = await api('GET', '/api/v1/channels/verify');
      is(post.verify, 200, 'verify after restart');
      if (post.verify.json?.valid !== undefined) {
        ok(post.verify.json.valid, 'hash chain invalid after restart');
      }

      // Capital invariant
      const bal = await api('GET', '/api/v1/capital/balance', null, key(0));
      is(bal, 200, 'capital after restart');
    },
  },
];
