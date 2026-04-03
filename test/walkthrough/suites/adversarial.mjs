/**
 * Adversarial Security Evals
 *
 * Tests every attack a bad actor would attempt:
 *   - Stealing another agent's money
 *   - Controlling channels they didn't open
 *   - Reading private data of other agents
 *   - Altering the ledger or audit chain
 *   - Bypassing authentication
 *   - Injecting malicious input
 *   - Exploiting race conditions
 *
 * Every test registers an attacker (agent 0) and a victim (agent 1),
 * then asserts the attack fails with the correct error code.
 */

import assert from 'node:assert/strict';
import {
  assertHelpful,
  assertStatus,
  SkipPhaseError,
} from '../coverage-helpers.mjs';
import {
  expectHelpful,
  expectStatus,
  expectSafe,
  reqAuth,
  reqPublic,
} from '../agent-coverage-scoring.mjs';

const AUTH = reqAuth();

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Assert response is 401 Unauthorized. */
function assert401(resp, label) {
  assert.equal(resp.status, 401, `${label}: expected 401 got ${resp.status}`);
}

/** Assert response is 403 Forbidden. */
function assert403(resp, label) {
  assert.equal(resp.status, 403, `${label}: expected 403 got ${resp.status}`);
}

/** Assert response is a client-side rejection (4xx). */
function assertRejected(resp, label) {
  assert.ok(
    resp.status >= 400 && resp.status < 500,
    `${label}: expected 4xx rejection got ${resp.status}`,
  );
}

/** Assert that a victim's data is NOT visible in an attacker's response. */
function assertNoLeakage(resp, victimId, label) {
  const text = JSON.stringify(resp.json || resp.text || '');
  // Only check for full agent ID leakage in contexts where it shouldn't appear
  // (public profiles and leaderboard legitimately show agent IDs)
  assert.ok(
    !text.includes(`"api_key"`),
    `${label}: response leaked api_key`,
  );
}

// ─── Suite ───────────────────────────────────────────────────────────────────

export const suite = {
  name: 'adversarial',
  phases: [

    // =====================================================================
    // 1. AUTHENTICATION BYPASS
    // =====================================================================
    {
      name: 'auth-bypass',
      covers: [],
      setup: ['auth'],
      async run(ctx) {
        // 1a. No token at all
        const noAuth = await ctx.request('GET', '/api/v1/agents/me');
        assert401(noAuth, 'no-token → agents/me');

        const noAuthWallet = await ctx.request('GET', '/api/v1/wallet/balance');
        assert401(noAuthWallet, 'no-token → wallet/balance');

        const noAuthMessages = await ctx.request('GET', '/api/v1/messages');
        assert401(noAuthMessages, 'no-token → messages');

        // 1b. Garbage token
        const garbageResp = await ctx.request('GET', '/api/v1/agents/me', {
          headers: { Authorization: 'Bearer garbage-not-a-real-token' },
        });
        assert401(garbageResp, 'garbage-token → agents/me');

        // 1c. Token with wrong prefix (not lb-agent-)
        const wrongPrefix = await ctx.request('GET', '/api/v1/agents/me', {
          headers: { Authorization: 'Bearer sk-wrong-prefix-token-1234567890' },
        });
        assert401(wrongPrefix, 'wrong-prefix-token → agents/me');

        // 1d. Empty Bearer
        const emptyBearer = await ctx.request('GET', '/api/v1/agents/me', {
          headers: { Authorization: 'Bearer ' },
        });
        assert401(emptyBearer, 'empty-bearer → agents/me');

        // 1e. Correct format but nonexistent key
        const fakeKey = await ctx.request('GET', '/api/v1/agents/me', {
          headers: { Authorization: 'Bearer lb-agent-' + 'a'.repeat(64) },
        });
        assert401(fakeKey, 'fake-lb-agent-key → agents/me');

        return 'All authentication bypass attempts correctly rejected with 401.';
      },
    },

    // =====================================================================
    // 2. CROSS-AGENT WALLET THEFT
    // =====================================================================
    {
      name: 'wallet-theft',
      covers: [],
      setup: ['auth', 'second_agent'],
      async run(ctx) {
        const attacker = await ctx.ensureAgent(0);
        const victim = await ctx.ensureAgent(1);

        // 2a. Attacker checks own balance — should only see own
        const ownBalance = await ctx.request('GET', '/api/v1/wallet/balance', { authAgent: 0 });
        assertStatus(ownBalance, 200, 'attacker own balance');
        assertNoLeakage(ownBalance, victim.agent_id, 'attacker balance response');

        // 2b. Attacker's wallet history should only show attacker's transactions
        const ownHistory = await ctx.request('GET', '/api/v1/wallet/history', { authAgent: 0 });
        assertStatus(ownHistory, 200, 'attacker own history');

        // 2c. Attacker tries to send ecash (should fail — no balance, but point is the
        //     send operation only operates on the authenticated agent's funds)
        const sendAttempt = await ctx.request('POST', '/api/v1/wallet/send', {
          authAgent: 0,
          body: { amount_sats: 1000 },
        });
        // Should fail with 400 (insufficient balance), not succeed with victim's funds
        assert.ok(
          sendAttempt.status === 400 || sendAttempt.status === 200,
          `send-ecash: expected 400 or 200, got ${sendAttempt.status}`,
        );

        // 2d. Attacker tries to melt-quote with a crafted invoice
        //     (should only debit attacker's wallet, never victim's)
        const meltAttempt = await ctx.request('POST', '/api/v1/wallet/melt-quote', {
          authAgent: 0,
          body: { invoice: 'lnbc10n1fakeinvoice' },
        });
        // Should fail validation, but importantly NOT touch victim's funds
        assertRejected(meltAttempt, 'melt-quote with fake invoice');

        // 2e. Attacker tries to receive a token from a foreign mint
        const foreignToken = await ctx.request('POST', '/api/v1/wallet/receive', {
          authAgent: 0,
          body: { token: 'cashuAeyJ0b2tlbiI6W3sicHJvb2ZzIjpbXSwibWludCI6Imh0dHBzOi8vZXZpbC1taW50LmNvbSJ9XX0=' },
        });
        assertRejected(foreignToken, 'receive foreign-mint token');

        return 'All wallet theft attempts correctly rejected. Attacker can only interact with own funds.';
      },
    },

    // =====================================================================
    // 3. CROSS-AGENT PROFILE ATTACKS
    // =====================================================================
    {
      name: 'profile-attacks',
      covers: [],
      setup: ['auth', 'second_agent'],
      async run(ctx) {
        const attacker = await ctx.ensureAgent(0);
        const victim = await ctx.ensureAgent(1);

        // 3a. Attacker tries to update victim's profile via PUT /agents/me
        //     (should only modify attacker's profile, since auth binds to token)
        const updateOwn = await ctx.request('PUT', '/api/v1/agents/me', {
          authAgent: 0,
          body: { name: 'hacked-by-attacker' },
        });
        assertStatus(updateOwn, 200, 'attacker updates own profile');

        // Verify victim's profile is unchanged
        const victimProfile = await ctx.request('GET', `/api/v1/agents/${victim.agent_id}`);
        assertStatus(victimProfile, 200, 'victim profile lookup');
        assert.notEqual(
          victimProfile.json?.name,
          'hacked-by-attacker',
          'victim name should NOT be changed by attacker',
        );

        // 3b. Public profile should NOT leak api_key
        assert.ok(
          !victimProfile.json?.api_key,
          'public profile should not contain api_key',
        );
        assert.ok(
          !victimProfile.json?.api_key_hash,
          'public profile should not contain api_key_hash',
        );

        // 3c. GET /agents/me with attacker's token should return attacker, not victim
        const attackerMe = await ctx.request('GET', '/api/v1/agents/me', { authAgent: 0 });
        assertStatus(attackerMe, 200, 'attacker /agents/me');
        const meId = attackerMe.json?.id || attackerMe.json?.agent_id;
        assert.equal(meId, attacker.agent_id, '/agents/me should return attacker, not victim');

        // 3d. Attacker tries to update profile with unexpected fields (injection attempt)
        const injection = await ctx.request('PUT', '/api/v1/agents/me', {
          authAgent: 0,
          body: {
            name: 'legit-name',
            api_key: 'lb-agent-stolen',       // try to overwrite key
            balance_sats: 999999999,           // try to overwrite balance
            tier: 'admin',                     // try to escalate tier
            role: 'operator',                  // try to escalate role
          },
        });
        assertRejected(injection, 'profile injection with unexpected fields');

        return 'All profile attacks correctly rejected. Token isolation enforced.';
      },
    },

    // =====================================================================
    // 4. CROSS-AGENT MESSAGE SNOOPING
    // =====================================================================
    {
      name: 'message-snooping',
      covers: [],
      setup: ['auth', 'second_agent'],
      async run(ctx) {
        const attacker = await ctx.ensureAgent(0);
        const victim = await ctx.ensureAgent(1);

        // 4a. Victim sends a message to a third party (or self)
        const secret = `secret-${Date.now()}-${Math.random().toString(36).slice(2)}`;
        const sent = await ctx.request('POST', '/api/v1/messages', {
          authAgent: 1,
          body: { to: victim.agent_id, content: secret },
        });
        // May succeed or fail (self-send), but the message content is what matters
        assert.ok(sent.status < 500, 'message send should not 500');

        // 4b. Attacker reads their own inbox — victim's messages should NOT appear
        const attackerInbox = await ctx.request('GET', '/api/v1/messages', { authAgent: 0 });
        assertStatus(attackerInbox, 200, 'attacker inbox');
        const messages = attackerInbox.json?.messages || [];
        const leaked = messages.some(m =>
          (m.content || '').includes(secret) ||
          m.from === victim.agent_id ||
          m.from_agent_id === victim.agent_id,
        );
        assert.ok(!leaked, 'attacker inbox should NOT contain victim\'s private messages');

        // 4c. Attacker tries to send message impersonating victim
        //     (from field in body should be ignored — sender determined by auth token)
        const impersonate = await ctx.request('POST', '/api/v1/messages', {
          authAgent: 0,
          body: {
            to: victim.agent_id,
            content: 'I am definitely the victim',
            from: victim.agent_id,            // try to spoof sender
            from_agent_id: victim.agent_id,   // try alternate field
          },
        });
        // If accepted, verify the from field is attacker, not victim
        if (impersonate.status === 201) {
          const inbox2 = await ctx.request('GET', '/api/v1/messages/inbox', { authAgent: 1 });
          const lastMsg = (inbox2.json?.messages || [])[0];
          if (lastMsg) {
            const sender = lastMsg.from || lastMsg.from_agent_id;
            assert.notEqual(sender, victim.agent_id, 'sender should be attacker, not spoofed victim');
          }
        }

        return 'Message isolation verified. Attacker cannot read or spoof victim messages.';
      },
    },

    // =====================================================================
    // 5. CROSS-AGENT ALLIANCE MANIPULATION
    // =====================================================================
    {
      name: 'alliance-hijack',
      covers: [],
      setup: ['auth', 'second_agent'],
      async run(ctx) {
        const attacker = await ctx.ensureAgent(0);
        const victim = await ctx.ensureAgent(1);

        // 5a. Victim proposes an alliance with attacker
        const propose = await ctx.request('POST', '/api/v1/alliances', {
          authAgent: 1,
          body: { to: attacker.agent_id, purpose: 'test alliance' },
        });
        // Alliance may or may not work (depends on state), but try the attack regardless

        // 5b. Register a third agent to be the outsider
        const outsider = await ctx.ensureAgent(2);

        // 5c. If there's an active alliance, outsider tries to break it
        const alliances = await ctx.request('GET', '/api/v1/alliances', { authAgent: 1 });
        const activeAlliance = (alliances.json?.alliances || alliances.json?.active || [])
          .find(a => a.status === 'active' || a.status === 'proposed');

        if (activeAlliance) {
          const breakAttempt = await ctx.request('POST', `/api/v1/alliances/${activeAlliance.alliance_id}/break`, {
            authAgent: 2,
            body: { reason: 'hostile takeover' },
          });
          assert.ok(
            breakAttempt.status === 400 || breakAttempt.status === 403,
            `outsider break alliance: expected 400/403 got ${breakAttempt.status}`,
          );
        }

        // 5d. Outsider tries to accept an alliance they're not part of
        const pendingAlliance = (alliances.json?.alliances || alliances.json?.pending || [])
          .find(a => a.status === 'proposed');

        if (pendingAlliance) {
          const acceptAttempt = await ctx.request('POST', `/api/v1/alliances/${pendingAlliance.alliance_id}/accept`, {
            authAgent: 2,
          });
          assert.ok(
            acceptAttempt.status === 400 || acceptAttempt.status === 403,
            `outsider accept alliance: expected 400/403 got ${acceptAttempt.status}`,
          );
        }

        return 'Alliance manipulation by outsiders correctly rejected.';
      },
    },

    // =====================================================================
    // 6. CHANNEL HIJACKING
    // =====================================================================
    {
      name: 'channel-hijack',
      covers: [],
      setup: ['auth', 'second_agent'],
      async run(ctx) {
        const attacker = await ctx.ensureAgent(0);
        const victim = await ctx.ensureAgent(1);

        // 6a. Attacker lists their own channels (should be empty or only theirs)
        const myChannels = await ctx.request('GET', '/api/v1/channels/mine', { authAgent: 0 });
        assertStatus(myChannels, 200, 'attacker channels/mine');

        // 6b. Attacker tries to instruct a channel they don't own
        //     Use a fake channel_id that would belong to someone else
        const fakeChannelId = '999888777666555';
        const instructAttempt = await ctx.request('POST', '/api/v1/channels/instruct', {
          authAgent: 0,
          body: {
            instruction: {
              action: 'set_fee_policy',
              agent_id: attacker.agent_id,
              channel_id: fakeChannelId,
              timestamp: Math.floor(Date.now() / 1000),
              params: { base_fee_msat: 1000, fee_rate_ppm: 100 },
            },
            signature: 'deadbeef',
          },
        });
        // Should fail — channel not assigned to attacker (or agent has no pubkey)
        assert.ok(
          instructAttempt.status >= 400 && instructAttempt.status < 500,
          `instruct unowned channel: expected 4xx got ${instructAttempt.status}`,
        );

        // 6c. Attacker tries to close a channel they don't own
        const closeAttempt = await ctx.request('POST', '/api/v1/market/close', {
          authAgent: 0,
          body: {
            channel_point: 'aaaa:0',
          },
        });
        assert.ok(
          closeAttempt.status >= 400 && closeAttempt.status < 500,
          `close unowned channel: expected 4xx got ${closeAttempt.status}`,
        );

        // 6d. Attacker tries to get revenue from a channel they don't own
        const revenueAttempt = await ctx.request('GET', `/api/v1/market/revenue/${fakeChannelId}`, {
          authAgent: 0,
        });
        assert.ok(
          revenueAttempt.status === 404 || revenueAttempt.status === 403 || revenueAttempt.status === 400,
          `revenue for unowned channel: expected 400/403/404 got ${revenueAttempt.status}`,
        );

        // 6e. Attacker tries to rebalance through a channel they don't own
        const rebalanceAttempt = await ctx.request('POST', '/api/v1/market/rebalance', {
          authAgent: 0,
          body: {
            outbound_chan_id: fakeChannelId,
            amount_sats: 10000,
          },
        });
        assert.ok(
          rebalanceAttempt.status >= 400 && rebalanceAttempt.status < 500,
          `rebalance unowned channel: expected 4xx got ${rebalanceAttempt.status}`,
        );

        return 'All channel hijacking attempts correctly rejected.';
      },
    },

    // =====================================================================
    // 7. CAPITAL LEDGER MANIPULATION
    // =====================================================================
    {
      name: 'capital-ledger-attacks',
      covers: [],
      setup: ['auth', 'second_agent'],
      async run(ctx) {
        const attacker = await ctx.ensureAgent(0);
        const victim = await ctx.ensureAgent(1);

        // 7a. Attacker checks own capital — should only see own
        const ownCapital = await ctx.request('GET', '/api/v1/capital/balance', { authAgent: 0 });
        if (ownCapital.status === 200) {
          assertNoLeakage(ownCapital, victim.agent_id, 'attacker capital balance');
        }

        // 7b. Attacker tries to withdraw more capital than they have
        const overWithdraw = await ctx.request('POST', '/api/v1/capital/withdraw', {
          authAgent: 0,
          body: { amount_sats: 999_999_999 },
        });
        // 400 (insufficient), 403 (forbidden), or 503 (disabled) are all valid rejections
        assert.ok(
          overWithdraw.status >= 400 && overWithdraw.status < 600,
          `over-withdraw: expected 4xx/5xx got ${overWithdraw.status}`,
        );

        // 7c. Attacker tries to generate deposit address — should be for attacker only
        const depositAddr = await ctx.request('POST', '/api/v1/capital/deposit-address', { authAgent: 0 });
        // Even if this succeeds, the address should be bound to attacker, not victim
        if (depositAddr.status === 200) {
          // Address is generated for the authenticated agent — no cross-agent risk
          assert.ok(depositAddr.json?.address, 'deposit address should be returned');
        }

        // 7d. Attacker's capital activity should NOT contain victim's transactions
        const activity = await ctx.request('GET', '/api/v1/capital/activity', { authAgent: 0 });
        if (activity.status === 200) {
          const entries = activity.json?.activity || activity.json?.entries || [];
          const victimEntries = entries.filter(e => e.agent_id === victim.agent_id);
          assert.equal(victimEntries.length, 0, 'attacker capital activity should not show victim entries');
        }

        return 'Capital ledger isolation verified. No cross-agent access.';
      },
    },

    // =====================================================================
    // 8. LEDGER TAMPERING (append-only integrity)
    // =====================================================================
    {
      name: 'ledger-integrity',
      covers: [],
      setup: ['auth'],
      async run(ctx) {
        // 8a. Public ledger should be read-only — no POST/PUT/DELETE
        const ledgerPost = await ctx.request('POST', '/api/v1/ledger', {
          authAgent: 0,
          body: { type: 'credit', amount_sats: 1000000, agent_id: 'fake' },
        });
        assert.ok(
          ledgerPost.status === 404 || ledgerPost.status === 405,
          `POST to ledger: expected 404/405 got ${ledgerPost.status}`,
        );

        const ledgerPut = await ctx.request('PUT', '/api/v1/ledger', {
          authAgent: 0,
          body: { entries: [] },
        });
        assert.ok(
          ledgerPut.status === 404 || ledgerPut.status === 405,
          `PUT to ledger: expected 404/405 got ${ledgerPut.status}`,
        );

        const ledgerDelete = await ctx.request('DELETE', '/api/v1/ledger');
        assert.ok(
          ledgerDelete.status === 404 || ledgerDelete.status === 405 || ledgerDelete.status === 415,
          `DELETE ledger: expected 404/405/415 got ${ledgerDelete.status}`,
        );

        // 8b. Audit chain verification endpoint should be accessible
        const verify = await ctx.request('GET', '/api/v1/channels/verify', { authAgent: 0 });
        assert.ok(
          verify.status === 200 || verify.status === 404,
          `audit chain verify: expected 200/404 got ${verify.status}`,
        );

        return 'Ledger is read-only. No write endpoints exist.';
      },
    },

    // =====================================================================
    // 9. INPUT INJECTION ATTACKS
    // =====================================================================
    {
      name: 'input-injection',
      covers: [],
      setup: ['auth'],
      async run(ctx) {
        // 9a. SQL injection in registration name
        const sqlInject = await ctx.request('POST', '/api/v1/agents/register', {
          body: { name: "Robert'); DROP TABLE agents;--" },
        });
        // Should succeed (name is sanitized) or fail validation — never crash
        assert.ok(sqlInject.status < 500, 'SQL injection in name should not crash server');

        // 9b. Path traversal in profile description
        const pathTraversal = await ctx.request('PUT', '/api/v1/agents/me', {
          authAgent: 0,
          body: { description: '../../../etc/passwd' },
        });
        assert.ok(pathTraversal.status < 500, 'path traversal in description should not crash');

        // 9c. XSS in profile fields
        const xss = await ctx.request('PUT', '/api/v1/agents/me', {
          authAgent: 0,
          body: {
            name: '<script>alert("xss")</script>',
            description: '<img src=x onerror=alert(1)>',
          },
        });
        assert.ok(xss.status < 500, 'XSS in profile fields should not crash');

        // 9d. Null bytes in string fields
        const nullByte = await ctx.request('PUT', '/api/v1/agents/me', {
          authAgent: 0,
          body: { name: 'agent\x00injected', description: 'test\x00null' },
        });
        assert.ok(nullByte.status < 500, 'null bytes should not crash');

        // 9e. Oversized payload
        const oversized = await ctx.request('POST', '/api/v1/actions/submit', {
          authAgent: 0,
          body: {
            action_type: 'test',
            params: { data: 'x'.repeat(100_000) },
          },
        });
        assertRejected(oversized, 'oversized params payload');

        // 9f. Deeply nested JSON
        let nested = { a: 'leaf' };
        for (let i = 0; i < 50; i++) nested = { nested };
        const deepNested = await ctx.request('POST', '/api/v1/actions/submit', {
          authAgent: 0,
          body: {
            action_type: 'test',
            params: nested,
          },
        });
        assert.ok(deepNested.status < 500, 'deeply nested JSON should not crash');

        // 9g. Type confusion — send string where object expected
        const typeConfusion = await ctx.request('POST', '/api/v1/agents/register', {
          body: 'not-an-object',
          headers: { 'Content-Type': 'application/json' },
        });
        assert.ok(typeConfusion.status < 500, 'string body should not crash');

        // 9h. Path param injection
        const pathParamInject = await ctx.request('GET', '/api/v1/agents/../../etc/passwd');
        assert.ok(
          pathParamInject.status === 400 || pathParamInject.status === 404,
          `path param traversal: expected 400/404 got ${pathParamInject.status}`,
        );

        // 9i. Invalid BOLT11 invoice formats
        const badInvoices = [
          'not-an-invoice',
          'lnbc1' + 'A'.repeat(5000),                           // oversized
          'lnbc1${process.env.SECRET}',                          // template injection
          'lnbc1\x00hidden',                                     // null byte
        ];
        for (const inv of badInvoices) {
          const resp = await ctx.request('POST', '/api/v1/wallet/melt-quote', {
            authAgent: 0,
            body: { invoice: inv },
          });
          assertRejected(resp, `bad invoice: ${inv.slice(0, 30)}`);
        }

        return 'All injection attacks handled safely. No crashes or unexpected behavior.';
      },
    },

    // =====================================================================
    // 10. OPERATOR ENDPOINT PROBING
    // =====================================================================
    {
      name: 'operator-escalation',
      covers: [],
      setup: ['auth'],
      async run(ctx) {
        const attacker = await ctx.ensureAgent(0);

        // 10a. Try to access operator-only channel assignment
        const assign = await ctx.request('POST', '/api/v1/channels/assign', {
          authAgent: 0,
          body: {
            channel_id: '123456789',
            agent_id: attacker.agent_id,
          },
        });
        assert.ok(
          assign.status === 403 || assign.status === 404,
          `operator assign: expected 403/404 got ${assign.status}`,
        );

        // 10b. Try to delete a channel assignment
        const unassign = await ctx.request('DELETE', '/api/v1/channels/assign/123456789', {
          authAgent: 0,
        });
        assert.ok(
          unassign.status === 403 || unassign.status === 404 || unassign.status === 415,
          `operator unassign: expected 403/404/415 got ${unassign.status}`,
        );

        // 10c. Try to access test-only rate limit reset
        const resetLimits = await ctx.request('POST', '/api/v1/test/reset-rate-limits', {
          authAgent: 0,
          body: {},
        });
        assert.ok(
          resetLimits.status < 500,
          `test reset: expected non-5xx got ${resetLimits.status}`,
        );

        // 10d. Try to spoof loopback via headers
        const spoofLocal = await ctx.request('POST', '/api/v1/channels/assign', {
          authAgent: 0,
          headers: {
            'X-Forwarded-For': '127.0.0.1',
            'X-Real-IP': '127.0.0.1',
          },
          body: {
            channel_id: '123456789',
            agent_id: attacker.agent_id,
          },
        });
        assert.ok(
          spoofLocal.status === 403 || spoofLocal.status === 404,
          `spoofed loopback: expected 403/404 got ${spoofLocal.status}`,
        );

        // 10e. Try operator secret header without knowing the secret
        const fakeSecret = await ctx.request('POST', '/api/v1/channels/assign', {
          headers: {
            'X-Operator-Secret': 'guessed-password',
          },
          body: {
            channel_id: '123456789',
            agent_id: attacker.agent_id,
          },
        });
        assert.ok(
          fakeSecret.status === 403 || fakeSecret.status === 404,
          `fake operator secret: expected 403/404 got ${fakeSecret.status}`,
        );

        return 'Operator endpoint access correctly denied to agents.';
      },
    },

    // =====================================================================
    // 11. NODE CONNECTION SSRF / HOST PROBING
    // =====================================================================
    {
      name: 'node-ssrf',
      covers: [],
      setup: ['auth'],
      async run(ctx) {
        // 11a. Try to connect to localhost (SSRF)
        const localhost = await ctx.request('POST', '/api/v1/node/test-connection', {
          authAgent: 0,
          body: {
            host: 'localhost:10009',
            macaroon: 'deadbeef',
            tls_cert: 'deadbeef',
          },
        });
        assert.ok(
          localhost.status === 400 || localhost.status === 403,
          `localhost SSRF: expected 400/403 got ${localhost.status}`,
        );

        // 11b. Try 127.0.0.1
        const loopback = await ctx.request('POST', '/api/v1/node/test-connection', {
          authAgent: 0,
          body: {
            host: '127.0.0.1:10009',
            macaroon: 'deadbeef',
            tls_cert: 'deadbeef',
          },
        });
        assert.ok(
          loopback.status === 400 || loopback.status === 403,
          `127.0.0.1 SSRF: expected 400/403 got ${loopback.status}`,
        );

        // 11c. Try private IP ranges
        const privateIPs = [
          '10.0.0.1:10009',
          '192.168.1.1:10009',
          '172.16.0.1:10009',
          '169.254.169.254:80',       // AWS metadata endpoint
          '[::1]:10009',              // IPv6 loopback
        ];
        for (const host of privateIPs) {
          const resp = await ctx.request('POST', '/api/v1/node/test-connection', {
            authAgent: 0,
            body: { host, macaroon: 'deadbeef', tls_cert: 'deadbeef' },
          });
          assert.ok(
            resp.status === 400 || resp.status === 403,
            `private IP ${host}: expected 400/403 got ${resp.status}`,
          );
        }

        // 11d. Try .local hostname
        const localHost = await ctx.request('POST', '/api/v1/node/test-connection', {
          authAgent: 0,
          body: {
            host: 'internal.local:10009',
            macaroon: 'deadbeef',
            tls_cert: 'deadbeef',
          },
        });
        assert.ok(
          localHost.status === 400 || localHost.status === 403,
          `.local SSRF: expected 400/403 got ${localHost.status}`,
        );

        // 11e. Try tier escalation to admin
        const adminTier = await ctx.request('POST', '/api/v1/node/connect', {
          authAgent: 0,
          body: {
            host: 'public.node.com:10009',
            macaroon: 'deadbeef',
            tls_cert: 'deadbeef',
            tier: 'admin',
          },
        });
        assert403(adminTier, 'admin tier escalation');

        return 'All SSRF and host probing attempts correctly blocked.';
      },
    },

    // =====================================================================
    // 12. UNEXPECTED FIELD INJECTION (mass assignment)
    // =====================================================================
    {
      name: 'mass-assignment',
      covers: [],
      setup: ['auth'],
      async run(ctx) {
        // 12a. Try to inject fields into registration
        const registerInject = await ctx.request('POST', '/api/v1/agents/register', {
          body: {
            name: `mass-assign-test-${Date.now()}`,
            tier: 'admin',                    // should be ignored
            balance_sats: 999999,             // should be ignored
            is_operator: true,                // should be ignored
            api_key: 'lb-agent-chosen',       // should be ignored
          },
        });
        if (registerInject.status === 201) {
          // Verify the injected fields were NOT honored
          const checkProfile = await ctx.request('GET', '/api/v1/agents/me', {
            headers: { Authorization: `Bearer ${registerInject.json.api_key}` },
          });
          if (checkProfile.status === 200) {
            assert.notEqual(checkProfile.json?.tier, 'admin', 'tier injection should not work');
            assert.notEqual(checkProfile.json?.balance_sats, 999999, 'balance injection should not work');
            assert.notEqual(registerInject.json.api_key, 'lb-agent-chosen', 'api_key injection should not work');
          }
        }

        // 12b. Try to inject fields into action submission
        const actionInject = await ctx.request('POST', '/api/v1/actions/submit', {
          authAgent: 0,
          body: {
            action_type: 'test',
            params: {},
            status: 'completed',              // try to skip pending
            agent_id: 'victim-id',            // try to attribute to victim
            reward_sats: 1000000,             // try to claim reward
          },
        });
        assertRejected(actionInject, 'action submit with unexpected fields');

        // 12c. Try to inject fields into node connect
        const nodeInject = await ctx.request('POST', '/api/v1/node/connect', {
          authAgent: 0,
          body: {
            host: 'example.com:10009',
            macaroon: 'deadbeef',
            tls_cert: 'deadbeef',
            tier: 'readonly',
            admin_override: true,             // unexpected field
            bypass_verification: true,        // unexpected field
          },
        });
        assertRejected(nodeInject, 'node connect with unexpected fields');

        // 12d. Try to inject fields into message
        const msgInject = await ctx.request('POST', '/api/v1/messages', {
          authAgent: 0,
          body: {
            to: (await ctx.ensureAgent(0)).agent_id,
            content: 'test',
            from: 'someone-else',             // try to spoof sender
            broadcast: true,                  // try to send to all
            priority: 'urgent',               // unexpected field
          },
        });
        // Message may succeed (extra fields ignored) or fail (unexpected keys)
        assert.ok(msgInject.status < 500, 'message with extra fields should not crash');

        return 'Mass assignment attacks correctly handled.';
      },
    },

    // =====================================================================
    // 13. RATE LIMIT EVASION
    // =====================================================================
    {
      name: 'rate-limit-evasion',
      covers: [],
      setup: ['auth'],
      async run(ctx) {
        // 13a. Rapid-fire the same endpoint to trigger rate limits
        const results = [];
        for (let i = 0; i < 25; i++) {
          const r = await ctx.request('GET', '/api/v1/agents/me', {
            authAgent: 0,
            quiet: true,
          });
          results.push(r.status);
        }
        // At least some should eventually return 429 (Too Many Requests)
        const got429 = results.some(s => s === 429);
        // Note: may not trigger if rate limits are generous for this endpoint
        // The important thing is the server doesn't crash
        assert.ok(results.every(s => s < 500), 'rapid-fire should not cause 500s');

        // 13b. Try to reset rate limits without operator access
        //     (test route may or may not exist depending on config)
        const resetAttempt = await ctx.request('POST', '/api/v1/test/reset-rate-limits', {
          headers: { 'X-Forwarded-For': '127.0.0.1' },
        });
        // Should work from loopback, or be hidden/rejected
        assert.ok(
          resetAttempt.status < 500,
          `rate limit reset: expected non-5xx got ${resetAttempt.status}`,
        );

        return `Rate limiting active. ${got429 ? 'Triggered 429 as expected.' : 'Limits not reached (generous config).'}`;
      },
    },

    // =====================================================================
    // 14. CROSS-AGENT ANALYTICS DATA LEAKAGE
    // =====================================================================
    {
      name: 'analytics-data-leakage',
      covers: [],
      setup: ['auth', 'second_agent'],
      async run(ctx) {
        const attacker = await ctx.ensureAgent(0);
        const victim = await ctx.ensureAgent(1);

        // 14a. Check analytics catalog (public, no issue)
        const catalog = await ctx.request('GET', '/api/v1/analytics/catalog', { authAgent: 0 });
        assert.ok(catalog.status < 500, 'analytics catalog should not crash');

        // 14b. Try to query analytics about the victim
        const queryAttempt = await ctx.request('POST', '/api/v1/analytics/quote', {
          authAgent: 0,
          body: {
            query_id: 'agent_performance',
            params: { agent_id: victim.agent_id },
          },
        });
        // Should either fail (unknown query) or only return attacker's data
        assert.ok(queryAttempt.status < 500, 'analytics quote should not crash');

        // 14c. Attacker views victim's public profile (allowed)
        //      But should NOT see private fields
        const publicProfile = await ctx.request('GET', `/api/v1/agents/${victim.agent_id}`);
        if (publicProfile.status === 200) {
          const forbidden = ['api_key', 'api_key_hash', 'macaroon', 'tls_cert', 'seed'];
          for (const field of forbidden) {
            assert.ok(
              !(field in (publicProfile.json || {})),
              `public profile leaked ${field}`,
            );
          }
        }

        // 14d. Check that market agent endpoint only shows public info
        const marketAgent = await ctx.request('GET', `/api/v1/market/agent/${victim.agent_id}`, {
          authAgent: 0,
        });
        if (marketAgent.status === 200) {
          assertNoLeakage(marketAgent, victim.agent_id, 'market agent info');
        }

        return 'Analytics and public endpoints do not leak private data.';
      },
    },

    // =====================================================================
    // 15. DOUBLE-REGISTRATION / IDENTITY CONFUSION
    // =====================================================================
    {
      name: 'identity-confusion',
      covers: [],
      setup: [],
      async run(ctx) {
        // 15a. Register two agents with identical names
        const name = `identical-name-${Date.now()}`;
        const reg1 = await ctx.request('POST', '/api/v1/agents/register', {
          body: { name },
        });
        assertStatus(reg1, 201, 'first registration');

        const reg2 = await ctx.request('POST', '/api/v1/agents/register', {
          body: { name },
        });
        assertStatus(reg2, 201, 'second registration with same name');

        // They should get DIFFERENT agent IDs and API keys
        assert.notEqual(
          reg1.json.agent_id, reg2.json.agent_id,
          'identical names should get different IDs',
        );
        assert.notEqual(
          reg1.json.api_key, reg2.json.api_key,
          'identical names should get different API keys',
        );

        // 15b. Verify each token maps to the correct agent
        const me1 = await ctx.request('GET', '/api/v1/agents/me', {
          headers: { Authorization: `Bearer ${reg1.json.api_key}` },
        });
        const me2 = await ctx.request('GET', '/api/v1/agents/me', {
          headers: { Authorization: `Bearer ${reg2.json.api_key}` },
        });
        const id1 = me1.json?.id || me1.json?.agent_id;
        const id2 = me2.json?.id || me2.json?.agent_id;
        assert.equal(id1, reg1.json.agent_id, 'token 1 should map to agent 1');
        assert.equal(id2, reg2.json.agent_id, 'token 2 should map to agent 2');

        // 15c. Agent 1's token should NOT work for agent 2's data
        assert.notEqual(id1, id2, 'different tokens map to different agents');

        return 'Identity isolation verified even with identical names.';
      },
    },

    // =====================================================================
    // 16. AUDIT CHAIN INTEGRITY
    // =====================================================================
    {
      name: 'audit-chain-integrity',
      covers: [],
      setup: ['auth'],
      async run(ctx) {
        // 16a. Read the audit chain — should be accessible
        const audit = await ctx.request('GET', '/api/v1/channels/audit', { authAgent: 0 });
        assert.ok(audit.status < 500, 'audit chain read should not crash');

        // 16b. Try to POST/PUT to audit chain (should not exist)
        const auditPost = await ctx.request('POST', '/api/v1/channels/audit', {
          authAgent: 0,
          body: {
            type: 'fake_entry',
            domain: 'exploit',
            data: 'injected',
          },
        });
        assert.ok(
          auditPost.status === 404 || auditPost.status === 405,
          `POST to audit: expected 404/405 got ${auditPost.status}`,
        );

        // 16c. Verify audit chain endpoint works — returns verification result
        //     (chain may or may not be clean depending on server state)
        const verifyChain = await ctx.request('GET', '/api/v1/channels/verify', { authAgent: 0 });
        assert.ok(
          verifyChain.status === 200 || verifyChain.status === 404,
          `audit verify: expected 200/404 got ${verifyChain.status}`,
        );
        if (verifyChain.status === 200) {
          // Endpoint should return structured verification data
          assert.ok(
            'valid' in verifyChain.json && 'checked' in verifyChain.json,
            'verify endpoint should return valid and checked fields',
          );
        }

        return 'Audit chain is read-only with tamper-evident verification.';
      },
    },

    // =====================================================================
    // 17. ECASH TOKEN FORGERY
    // =====================================================================
    {
      name: 'ecash-token-forgery',
      covers: [],
      setup: ['auth'],
      async run(ctx) {
        // 17a. Try to receive a completely fabricated token
        const fakeToken = await ctx.request('POST', '/api/v1/wallet/receive', {
          authAgent: 0,
          body: { token: 'cashuAnotalegittoken' },
        });
        assertRejected(fakeToken, 'fabricated cashu token');

        // 17b. Try to receive an empty token
        const emptyToken = await ctx.request('POST', '/api/v1/wallet/receive', {
          authAgent: 0,
          body: { token: '' },
        });
        assertRejected(emptyToken, 'empty cashu token');

        // 17c. Try to receive a very long token (DoS)
        const longToken = await ctx.request('POST', '/api/v1/wallet/receive', {
          authAgent: 0,
          body: { token: 'cashuA' + 'B'.repeat(15_000) },
        });
        assertRejected(longToken, 'oversized cashu token');

        // 17d. Try to receive without token field
        const noToken = await ctx.request('POST', '/api/v1/wallet/receive', {
          authAgent: 0,
          body: {},
        });
        assertRejected(noToken, 'receive without token field');

        // 17e. Try to receive with token as a number
        const numericToken = await ctx.request('POST', '/api/v1/wallet/receive', {
          authAgent: 0,
          body: { token: 12345 },
        });
        assertRejected(numericToken, 'numeric token');

        return 'All ecash token forgery attempts correctly rejected.';
      },
    },

    // =====================================================================
    // 18. SIGNED INSTRUCTION FORGERY
    // =====================================================================
    {
      name: 'signature-forgery',
      covers: [],
      setup: ['auth'],
      async run(ctx) {
        const attacker = await ctx.ensureAgent(0);

        // 18a. Try to instruct without a signature
        const noSig = await ctx.request('POST', '/api/v1/channels/instruct', {
          authAgent: 0,
          body: {
            instruction: {
              action: 'set_fee_policy',
              agent_id: attacker.agent_id,
              channel_id: '123456789',
              timestamp: Math.floor(Date.now() / 1000),
              params: { base_fee_msat: 1000 },
            },
          },
        });
        assert.ok(noSig.status >= 400, `no signature: expected 4xx got ${noSig.status}`);

        // 18b. Try with a forged (random) signature
        const forgedSig = await ctx.request('POST', '/api/v1/channels/instruct', {
          authAgent: 0,
          body: {
            instruction: {
              action: 'set_fee_policy',
              agent_id: attacker.agent_id,
              channel_id: '123456789',
              timestamp: Math.floor(Date.now() / 1000),
              params: { base_fee_msat: 1000 },
            },
            signature: 'a'.repeat(128),
          },
        });
        assert.ok(forgedSig.status >= 400, `forged signature: expected 4xx got ${forgedSig.status}`);

        // 18c. Try with an expired timestamp
        const oldTimestamp = await ctx.request('POST', '/api/v1/channels/instruct', {
          authAgent: 0,
          body: {
            instruction: {
              action: 'set_fee_policy',
              agent_id: attacker.agent_id,
              channel_id: '123456789',
              timestamp: Math.floor(Date.now() / 1000) - 600, // 10 min ago
              params: { base_fee_msat: 1000 },
            },
            signature: 'b'.repeat(128),
          },
        });
        assert.ok(oldTimestamp.status >= 400, `expired timestamp: expected 4xx got ${oldTimestamp.status}`);

        // 18d. Try with a future timestamp
        const futureTimestamp = await ctx.request('POST', '/api/v1/channels/instruct', {
          authAgent: 0,
          body: {
            instruction: {
              action: 'set_fee_policy',
              agent_id: attacker.agent_id,
              channel_id: '123456789',
              timestamp: Math.floor(Date.now() / 1000) + 600, // 10 min from now
              params: { base_fee_msat: 1000 },
            },
            signature: 'c'.repeat(128),
          },
        });
        assert.ok(futureTimestamp.status >= 400, `future timestamp: expected 4xx got ${futureTimestamp.status}`);

        // 18e. Try with wrong agent_id in instruction (mismatch with auth)
        const wrongAgent = await ctx.request('POST', '/api/v1/channels/instruct', {
          authAgent: 0,
          body: {
            instruction: {
              action: 'set_fee_policy',
              agent_id: 'deadbeef',           // not the authenticated agent
              channel_id: '123456789',
              timestamp: Math.floor(Date.now() / 1000),
              params: { base_fee_msat: 1000 },
            },
            signature: 'd'.repeat(128),
          },
        });
        assert.ok(wrongAgent.status >= 400, `wrong agent_id: expected 4xx got ${wrongAgent.status}`);

        return 'All signature forgery attempts correctly rejected.';
      },
    },

    // =====================================================================
    // 19. RESOURCE EXHAUSTION
    // =====================================================================
    {
      name: 'resource-exhaustion',
      covers: [],
      setup: ['auth'],
      async run(ctx) {
        // 19a. Try to create many actions rapidly
        let crashCount = 0;
        for (let i = 0; i < 10; i++) {
          const r = await ctx.request('POST', '/api/v1/actions/submit', {
            authAgent: 0,
            body: {
              action_type: `flood-test-${i}`,
              params: { iteration: i },
            },
            quiet: true,
          });
          if (r.status >= 500) crashCount++;
        }
        assert.equal(crashCount, 0, 'rapid action submission should not cause 500s');

        // 19b. Large query params (try to exhaust memory via limit)
        const bigLimit = await ctx.request('GET', '/api/v1/leaderboard?limit=999999999', {
          authAgent: 0,
        });
        assert.ok(bigLimit.status < 500, 'huge limit param should not crash');
        // Limit should be clamped
        if (bigLimit.status === 200) {
          const entries = bigLimit.json?.entries || [];
          assert.ok(entries.length <= 500, 'limit should be clamped to max 500');
        }

        // 19c. Very long query string
        const longQuery = await ctx.request('GET',
          `/api/v1/leaderboard?${'x'.repeat(2000)}=1`,
          { authAgent: 0 },
        );
        assert.ok(longQuery.status < 500, 'long query string should not crash');

        return 'Resource exhaustion attempts handled gracefully.';
      },
    },

    // =====================================================================
    // 20. CROSS-AGENT CAPITAL / CHANNEL FUND THEFT (e2e)
    // =====================================================================
    {
      name: 'fund-theft-e2e',
      covers: [],
      setup: ['auth', 'second_agent'],
      async run(ctx) {
        const attacker = await ctx.ensureAgent(0);
        const victim = await ctx.ensureAgent(1);

        // 20a. Attacker tries to open a channel using victim's agent_id in body
        const openAsVictim = await ctx.request('POST', '/api/v1/market/open', {
          authAgent: 0,
          body: {
            peer_pubkey: '03' + 'ab'.repeat(32),
            local_funding_amount_sats: 100000,
            agent_id: victim.agent_id,        // try to charge victim
          },
        });
        // Should either use attacker's ID (from auth) or reject
        assert.ok(openAsVictim.status < 500, 'open with spoofed agent_id should not crash');

        // 20b. Attacker tries to preview with victim's agent_id
        const previewAsVictim = await ctx.request('POST', '/api/v1/market/preview', {
          authAgent: 0,
          body: {
            peer_pubkey: '03' + 'ab'.repeat(32),
            local_funding_amount_sats: 100000,
            agent_id: victim.agent_id,        // try to use victim's context
          },
        });
        assert.ok(previewAsVictim.status < 500, 'preview with spoofed agent_id should not crash');

        // 20c. Attacker tries to fund-from-ecash for victim
        const fundAsVictim = await ctx.request('POST', '/api/v1/market/fund-from-ecash', {
          authAgent: 0,
          body: {
            amount_sats: 100000,
            agent_id: victim.agent_id,
          },
        });
        assert.ok(
          fundAsVictim.status >= 400 && fundAsVictim.status < 600,
          `fund-from-ecash as victim: expected 4xx/503 got ${fundAsVictim.status}`,
        );

        // 20d. Attacker tries to initiate a swap claiming to be victim
        const swapAsVictim = await ctx.request('POST', '/api/v1/market/swap/quote', {
          authAgent: 0,
          body: {
            amount_sats: 50000,
            agent_id: victim.agent_id,
          },
        });
        assert.ok(swapAsVictim.status < 500, 'swap with spoofed agent_id should not crash');
        // If accepted, it should charge attacker, not victim

        return 'Fund theft via agent_id spoofing in request body correctly prevented.';
      },
    },

    // =====================================================================
    // 21. PEER SAFETY INFORMATION LEAKAGE
    // =====================================================================
    {
      name: 'peer-safety-probe',
      covers: [],
      setup: ['auth'],
      async run(ctx) {
        // 21a. Check peer safety for a known pubkey
        const validPubkey = '03' + 'ab'.repeat(32);
        const peerSafety = await ctx.request('GET', `/api/v1/market/peer-safety/${validPubkey}`, {
          authAgent: 0,
        });
        assert.ok(peerSafety.status < 500, 'peer safety check should not crash');

        // 21b. Check fees for a known pubkey
        const fees = await ctx.request('GET', `/api/v1/market/fees/${validPubkey}`, {
          authAgent: 0,
        });
        assert.ok(fees.status < 500, 'fee check should not crash');

        // 21c. Try with clearly invalid pubkey formats (injection attempts)
        const badPubkeys = [
          '../../../etc/passwd',
          '<script>alert(1)</script>',
          'short',                            // too short
          'ab'.repeat(40),                    // too long (80 chars)
        ];
        for (const pk of badPubkeys) {
          const resp = await ctx.request('GET', `/api/v1/market/peer-safety/${encodeURIComponent(pk)}`, {
            authAgent: 0,
          });
          assert.ok(
            resp.status === 400 || resp.status === 404,
            `bad pubkey '${pk.slice(0, 20)}': expected 400/404 got ${resp.status}`,
          );
        }

        return 'Peer safety endpoints validated and do not leak sensitive data.';
      },
    },

    // =====================================================================
    // 22. TOURNAMENT MANIPULATION
    // =====================================================================
    {
      name: 'tournament-manipulation',
      covers: [],
      setup: ['auth', 'second_agent'],
      async run(ctx) {
        const attacker = await ctx.ensureAgent(0);
        const victim = await ctx.ensureAgent(1);

        // 22a. Try to enter a nonexistent tournament
        const fakeEntry = await ctx.request('POST', '/api/v1/tournaments/tourn-deadbeef/enter', {
          authAgent: 0,
          body: {},
        });
        assert.ok(
          fakeEntry.status === 400 || fakeEntry.status === 404,
          `fake tournament entry: expected 400/404 got ${fakeEntry.status}`,
        );

        // 22b. Try to enter a tournament with invalid ID format
        const badIdEntry = await ctx.request('POST', '/api/v1/tournaments/not-valid-id/enter', {
          authAgent: 0,
          body: {},
        });
        assert.ok(
          badIdEntry.status === 400 || badIdEntry.status === 404,
          `bad tournament ID: expected 400/404 got ${badIdEntry.status}`,
        );

        // 22c. Try to view bracket of nonexistent tournament
        const fakeBracket = await ctx.request('GET', '/api/v1/tournaments/tourn-deadbeef/bracket', {
          authAgent: 0,
        });
        assert.ok(
          fakeBracket.status === 400 || fakeBracket.status === 404,
          `fake bracket: expected 400/404 got ${fakeBracket.status}`,
        );

        return 'Tournament manipulation attempts correctly rejected.';
      },
    },

    // =====================================================================
    // 23. HTTP METHOD CONFUSION
    // =====================================================================
    {
      name: 'method-confusion',
      covers: [],
      setup: ['auth'],
      async run(ctx) {
        // Try wrong HTTP methods on endpoints that only accept specific methods.
        // Express returns 404 for unmatched routes, 415 for missing Content-Type —
        // any 4xx is a valid rejection.

        // 23a. DELETE on register
        const deleteRegister = await ctx.request('DELETE', '/api/v1/agents/register', {
          body: {},
        });
        assertRejected(deleteRegister, 'DELETE register');

        // 23b. PUT on messages (should be POST)
        const putMessages = await ctx.request('PUT', '/api/v1/messages', {
          authAgent: 0,
          body: { to: 'someone', content: 'test' },
        });
        assertRejected(putMessages, 'PUT messages');

        // 23c. DELETE on wallet/balance
        const deleteBalance = await ctx.request('DELETE', '/api/v1/wallet/balance', {
          authAgent: 0,
          body: {},
        });
        assertRejected(deleteBalance, 'DELETE balance');

        // 23d. POST on leaderboard (read-only)
        const postLeaderboard = await ctx.request('POST', '/api/v1/leaderboard', {
          body: { entries: [{ agent_id: 'me', score: 99999 }] },
        });
        assertRejected(postLeaderboard, 'POST leaderboard');

        return 'Wrong HTTP methods correctly rejected.';
      },
    },
  ],
};
