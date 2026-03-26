/**
 * Tests for HelpEndpoint (Concierge).
 *
 * All Claude API calls are mocked — no real API calls in tests.
 * Run: node --test ai_panel/server/channel-market/help-endpoint.test.js
 */

import { describe, it, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';

// ---------------------------------------------------------------------------
// Mock infrastructure
// ---------------------------------------------------------------------------

/** Minimal mock for AgentRegistry */
function createMockRegistry() {
  const agents = new Map();
  return {
    getById(id) {
      return agents.get(id) || null;
    },
    _addAgent(profile) {
      agents.set(profile.id, profile);
    },
  };
}

/** Minimal mock for ChannelAssignmentRegistry */
function createMockAssignments() {
  const byAgent = new Map();
  const byChan = new Map();
  return {
    getByAgent(agentId) {
      return byAgent.get(agentId) || [];
    },
    getAssignment(chanId) {
      return byChan.get(chanId) || null;
    },
    _addAssignment(agentId, assignment) {
      const list = byAgent.get(agentId) || [];
      list.push(assignment);
      byAgent.set(agentId, list);
      if (assignment.chan_id) {
        byChan.set(assignment.chan_id, { ...assignment, agent_id: agentId });
      }
    },
  };
}

/** Minimal mock for HashChainAuditLog */
function createMockAuditLog() {
  const entries = [];
  return {
    async readAll({ limit = 100 } = {}) {
      return entries.slice(-limit);
    },
    async readByChannel(chanId, limit = 20) {
      return entries.filter(e => e.chan_id === chanId).slice(-limit);
    },
    _addEntry(entry) {
      entries.push({ _ts: Date.now(), ...entry });
    },
  };
}

/** Minimal mock for wallet operations (Cashu) */
function createMockWalletOps({ balance = 100, failSend = false, failReceive = false } = {}) {
  let currentBalance = balance;
  const sentTokens = [];
  const receivedTokens = [];
  return {
    async getBalance(_agentId) {
      return currentBalance;
    },
    async sendEcash(agentId, amount) {
      if (failSend) throw new Error('Mint connection failed');
      if (amount > currentBalance) {
        throw new Error(`Insufficient ecash balance. Have ${currentBalance} sats, need ${amount}`);
      }
      currentBalance -= amount;
      const token = `mock-token-${Date.now()}-${amount}`;
      sentTokens.push({ agentId, amount, token });
      return { token, amount, balance: currentBalance };
    },
    async receiveEcash(agentId, token) {
      if (failReceive) throw new Error('Receive failed');
      // Find the matching sent token to determine amount
      const sent = sentTokens.find(s => s.token === token);
      const amount = sent ? sent.amount : 0;
      currentBalance += amount;
      receivedTokens.push({ agentId, token });
      return { amount, proofCount: 1, balance: currentBalance };
    },
    _getBalance() { return currentBalance; },
    _getSentTokens() { return sentTokens; },
    _getReceivedTokens() { return receivedTokens; },
  };
}

/** Minimal mock for DataLayer */
function createMockDataLayer() {
  return {
    async readJSON() { return {}; },
    async writeJSON() {},
    async readLog() { return []; },
    async appendLog() {},
  };
}

/**
 * Create a HelpEndpoint with mocked Anthropic client.
 * The mock LLM returns a predictable response based on the user message.
 */
async function createTestHelpEndpoint(overrides = {}) {
  // Dynamically import to avoid module resolution issues at test time
  const { HelpEndpoint } = await import('./help-endpoint.js');

  const registry = overrides.registry || createMockRegistry();
  const assignments = overrides.assignments || createMockAssignments();
  const auditLog = overrides.auditLog || createMockAuditLog();
  const walletOps = overrides.walletOps || createMockWalletOps(overrides.walletConfig);
  const dataLayer = overrides.dataLayer || createMockDataLayer();

  const endpoint = new HelpEndpoint({
    agentRegistry: registry,
    assignmentRegistry: assignments,
    auditLog,
    capitalLedger: overrides.capitalLedger || null,
    performanceTracker: overrides.performanceTracker || null,
    marketTransparency: overrides.marketTransparency || null,
    walletOps,
    dataLayer,
  });

  // Set ANTHROPIC_API_KEY for the test
  process.env.ANTHROPIC_API_KEY = 'sk-ant-test-key-for-testing';

  // Initialize to load system prompt
  await endpoint.initialize();

  // Replace the Anthropic client with a mock
  endpoint._anthropic = {
    messages: {
      async create({ model, max_tokens, system, messages }) {
        // Validate inputs
        assert.ok(model, 'model must be provided');
        assert.ok(max_tokens > 0, 'max_tokens must be positive');
        assert.ok(system, 'system prompt must be provided');
        assert.ok(messages.length > 0, 'messages must not be empty');

        const userMsg = messages[0].content;

        // Simulate different responses based on question content
        let responseText;
        if (userMsg.includes('how do I open a channel')) {
          responseText = 'To open a channel, use POST /api/v1/channels/instruct with a signed instruction. First, get assigned a channel via the market. Then submit a fee instruction with your Ed25519 signature.\n\nNext step: POST /api/v1/channels/preview to test your instruction format.';
        } else if (userMsg.includes('why did my instruction fail')) {
          responseText = 'Your instruction failed because the signature was invalid. Check that you are signing the canonical JSON (RFC 8785) of your instruction, not the pretty-printed version.\n\nUse POST /api/v1/channels/preview to validate before submitting.';
        } else if (userMsg.includes('FORCE_ERROR')) {
          throw new Error('API rate limit exceeded');
        } else {
          responseText = `Here is the answer to your question. Check the knowledge base at GET /api/v1/knowledge/index for more details.\n\nFor further help, use POST /api/v1/help again.`;
        }

        return {
          content: [{ type: 'text', text: responseText }],
          model,
          usage: { input_tokens: 100, output_tokens: 50 },
        };
      },
    },
  };

  return { endpoint, registry, assignments, auditLog, walletOps, dataLayer };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('HelpEndpoint', () => {

  describe('classifyQuestion', () => {
    it('classifies simple questions at 1 sat', async () => {
      const { endpoint } = await createTestHelpEndpoint();
      const result = endpoint.classifyQuestion('What endpoints are available?');
      assert.equal(result.tier, 'simple');
      assert.equal(result.cost_sats, 1);
      assert.equal(result.needsData, false);
    });

    it('classifies data-lookup questions at 3 sats', async () => {
      const { endpoint } = await createTestHelpEndpoint();
      const result = endpoint.classifyQuestion('Why did my last instruction fail?');
      assert.equal(result.tier, 'data');
      assert.equal(result.cost_sats, 3);
      assert.equal(result.needsData, true);
    });

    it('classifies questions about agent channels as data-lookup', async () => {
      const { endpoint } = await createTestHelpEndpoint();
      const result = endpoint.classifyQuestion('What are my channels?');
      assert.equal(result.tier, 'data');
      assert.equal(result.cost_sats, 3);
      assert.equal(result.needsData, true);
    });

    it('classifies questions about balance as data-lookup', async () => {
      const { endpoint } = await createTestHelpEndpoint();
      const result = endpoint.classifyQuestion('What is my balance?');
      assert.equal(result.tier, 'data');
      assert.equal(result.cost_sats, 3);
      assert.equal(result.needsData, true);
    });

    it('classifies complex questions at 5 sats', async () => {
      const { endpoint } = await createTestHelpEndpoint();
      const result = endpoint.classifyQuestion('What is the optimal fee strategy for my node?');
      assert.equal(result.tier, 'complex');
      assert.equal(result.cost_sats, 5);
    });

    it('classifies complex data questions at 5 sats', async () => {
      const { endpoint } = await createTestHelpEndpoint();
      const result = endpoint.classifyQuestion('Should I recommend a fee change on my channel?');
      assert.equal(result.tier, 'complex');
      assert.equal(result.cost_sats, 5);
      assert.equal(result.needsData, true);
    });

    it('respects explicit context flags for data classification', async () => {
      const { endpoint } = await createTestHelpEndpoint();
      // Simple question text but context requests audit data
      const result = endpoint.classifyQuestion('Hello', { include_audit: true });
      assert.equal(result.needsData, true);
      assert.ok(result.cost_sats >= 3);
    });

    it('respects channel_id in context for data classification', async () => {
      const { endpoint } = await createTestHelpEndpoint();
      const result = endpoint.classifyQuestion('What is happening?', { chan_id: '12345' });
      assert.equal(result.needsData, true);
    });
  });

  describe('ask — validation', () => {
    it('rejects missing agent_id', async () => {
      const { endpoint } = await createTestHelpEndpoint();
      await assert.rejects(
        () => endpoint.ask(null, 'hello'),
        { message: 'agent_id is required' },
      );
    });

    it('rejects missing question', async () => {
      const { endpoint } = await createTestHelpEndpoint();
      await assert.rejects(
        () => endpoint.ask('agent-01', null),
        { message: 'question is required' },
      );
    });

    it('rejects empty question', async () => {
      const { endpoint } = await createTestHelpEndpoint();
      await assert.rejects(
        () => endpoint.ask('agent-01', ''),
        { message: 'question is required' },
      );
    });

    it('rejects question exceeding 500 chars', async () => {
      const { endpoint } = await createTestHelpEndpoint();
      const longQuestion = 'x'.repeat(501);
      await assert.rejects(
        () => endpoint.ask('agent-01', longQuestion),
        (err) => {
          assert.ok(err.message.includes('Question too long'));
          assert.equal(err.status, 400);
          return true;
        },
      );
    });

    it('allows question at exactly 500 chars', async () => {
      const { endpoint, registry } = await createTestHelpEndpoint();
      registry._addAgent({ id: 'agent-01', name: 'Test', tier: 'observatory', registered_at: Date.now() });
      const question = 'x'.repeat(500);
      const result = await endpoint.ask('agent-01', question);
      assert.ok(result.answer);
    });
  });

  describe('ask — rate limiting', () => {
    it('allows up to 10 questions per hour', async () => {
      // Use a unique agent ID to avoid rate limit contamination from other tests
      const agentId = `rate-test-${Date.now()}`;
      const { endpoint, registry } = await createTestHelpEndpoint({
        walletConfig: { balance: 1000 },
      });
      registry._addAgent({ id: agentId, name: 'RateTest', tier: 'observatory', registered_at: Date.now() });

      // Ask 10 questions — should all succeed
      for (let i = 0; i < 10; i++) {
        const result = await endpoint.ask(agentId, `Question ${i}`);
        assert.ok(result.answer);
      }

      // 11th question — should be rate limited
      await assert.rejects(
        () => endpoint.ask(agentId, 'One too many'),
        (err) => {
          assert.ok(err.message.includes('rate limit'));
          assert.equal(err.status, 429);
          assert.ok(err.retryAfter > 0);
          return true;
        },
      );
    });
  });

  describe('ask — payment', () => {
    it('deducts sats from agent wallet for simple question', async () => {
      const walletOps = createMockWalletOps({ balance: 50 });
      const { endpoint, registry } = await createTestHelpEndpoint({ walletOps });
      registry._addAgent({ id: 'pay-01', name: 'Payer', tier: 'observatory', registered_at: Date.now() });

      const result = await endpoint.ask('pay-01', 'What endpoints are available?');
      assert.equal(result.cost_sats, 1);
      // Balance should be 50 - 1 = 49
      assert.equal(walletOps._getBalance(), 49);
    });

    it('deducts 3 sats for data-lookup question', async () => {
      const walletOps = createMockWalletOps({ balance: 50 });
      const { endpoint, registry } = await createTestHelpEndpoint({ walletOps });
      registry._addAgent({ id: 'pay-02', name: 'Payer2', tier: 'observatory', registered_at: Date.now() });

      const result = await endpoint.ask('pay-02', 'Why did my last instruction fail?');
      assert.equal(result.cost_sats, 3);
      assert.equal(walletOps._getBalance(), 47);
    });

    it('deducts 5 sats for complex question', async () => {
      const walletOps = createMockWalletOps({ balance: 50 });
      const { endpoint, registry } = await createTestHelpEndpoint({ walletOps });
      registry._addAgent({ id: 'pay-03', name: 'Payer3', tier: 'observatory', registered_at: Date.now() });

      const result = await endpoint.ask('pay-03', 'What is the optimal fee for maximum routing revenue?');
      assert.equal(result.cost_sats, 5);
      assert.equal(walletOps._getBalance(), 45);
    });

    it('returns 402 when balance is insufficient', async () => {
      const walletOps = createMockWalletOps({ balance: 0 });
      const { endpoint } = await createTestHelpEndpoint({ walletOps });

      await assert.rejects(
        () => endpoint.ask('broke-agent', 'Help me'),
        (err) => {
          assert.ok(err.message.includes('Insufficient balance'));
          assert.equal(err.status, 402);
          return true;
        },
      );
    });

    it('refunds on LLM failure', async () => {
      const walletOps = createMockWalletOps({ balance: 50 });
      const { endpoint, registry } = await createTestHelpEndpoint({ walletOps });
      registry._addAgent({ id: 'refund-01', name: 'Refunder', tier: 'observatory', registered_at: Date.now() });

      // The mock LLM throws when it sees FORCE_ERROR
      await assert.rejects(
        () => endpoint.ask('refund-01', 'FORCE_ERROR please break'),
        (err) => {
          assert.ok(err.message.includes('temporarily unavailable'));
          assert.equal(err.status, 503);
          assert.equal(err.refunded, true);
          return true;
        },
      );

      // Balance should be restored
      assert.equal(walletOps._getBalance(), 50);
    });
  });

  describe('ask — LLM response', () => {
    it('returns structured response with answer, sources, cost, learn', async () => {
      const { endpoint, registry } = await createTestHelpEndpoint();
      registry._addAgent({ id: 'resp-01', name: 'Responder', tier: 'observatory', registered_at: Date.now() });

      const result = await endpoint.ask('resp-01', 'What endpoints are available?');
      assert.ok(typeof result.answer === 'string');
      assert.ok(result.answer.length > 0);
      assert.ok(Array.isArray(result.sources));
      assert.ok(typeof result.cost_sats === 'number');
      assert.ok(typeof result.learn === 'string');
    });

    it('includes relevant API endpoint in response for channel question', async () => {
      const { endpoint, registry } = await createTestHelpEndpoint();
      registry._addAgent({ id: 'resp-02', name: 'Responder2', tier: 'observatory', registered_at: Date.now() });

      const result = await endpoint.ask('resp-02', 'how do I open a channel');
      assert.ok(result.answer.includes('/api/v1/channels'));
    });

    it('explains failure when agent asks about failed instruction', async () => {
      const { endpoint, registry, auditLog } = await createTestHelpEndpoint();
      registry._addAgent({ id: 'resp-03', name: 'Responder3', tier: 'observatory', registered_at: Date.now() });
      auditLog._addEntry({
        type: 'fee_instruction_rejected',
        agent_id: 'resp-03',
        chan_id: '999',
        reason: 'signature_invalid',
      });

      const result = await endpoint.ask('resp-03', 'why did my instruction fail');
      assert.ok(result.answer.includes('signature'));
      assert.ok(result.sources.includes('audit_log'));
    });
  });

  describe('ask — context gathering', () => {
    it('gathers agent profile when data lookup is needed', async () => {
      const { endpoint, registry } = await createTestHelpEndpoint();
      registry._addAgent({
        id: 'ctx-01',
        name: 'ContextAgent',
        tier: 'observatory',
        registered_at: Date.now(),
      });

      const result = await endpoint.ask('ctx-01', 'What is my balance?');
      // Sources should include profile and wallet data
      assert.ok(result.sources.includes('agent_profile'));
      assert.ok(result.sources.includes('wallet_balance'));
    });

    it('gathers channel assignments when agent has channels', async () => {
      const { endpoint, registry, assignments } = await createTestHelpEndpoint();
      registry._addAgent({ id: 'ctx-02', name: 'ChanAgent', tier: 'observatory', registered_at: Date.now() });
      assignments._addAssignment('ctx-02', {
        chan_id: '12345',
        channel_point: 'abc:0',
        remote_pubkey: '02' + '0'.repeat(64),
        capacity: 1000000,
        assigned_at: Date.now(),
      });

      const result = await endpoint.ask('ctx-02', 'What are my channels?');
      assert.ok(result.sources.includes('channel_assignments'));
    });

    it('gathers channel-specific audit when chan_id is in context (owned channel)', async () => {
      const { endpoint, registry, auditLog, assignments } = await createTestHelpEndpoint();
      registry._addAgent({ id: 'ctx-03', name: 'AuditAgent', tier: 'observatory', registered_at: Date.now() });
      // Assign the channel to the agent so ownership check passes
      assignments._addAssignment('ctx-03', { chan_id: '555', channel_point: 'abc:0' });
      auditLog._addEntry({
        type: 'fee_instruction_executed',
        agent_id: 'ctx-03',
        chan_id: '555',
        old_policy: { fee_rate_ppm: 100 },
        new_policy: { fee_rate_ppm: 200 },
      });

      const result = await endpoint.ask('ctx-03', 'What happened to this channel?', { chan_id: '555' });
      assert.ok(result.sources.some(s => s.includes('audit_log:channel:555')));
    });

    it('skips context for simple questions', async () => {
      const { endpoint, registry } = await createTestHelpEndpoint();
      registry._addAgent({ id: 'ctx-04', name: 'SimpleAgent', tier: 'observatory', registered_at: Date.now() });

      const result = await endpoint.ask('ctx-04', 'How does Lightning routing work?');
      // Simple question — no data sources needed
      assert.deepEqual(result.sources, []);
    });
  });

  describe('ask — read-only access', () => {
    it('cannot modify channels through the help endpoint', async () => {
      const { endpoint } = await createTestHelpEndpoint();
      // The HelpEndpoint class has no write methods — verify by checking the instance
      assert.equal(typeof endpoint.assign, 'undefined');
      assert.equal(typeof endpoint.revoke, 'undefined');
      assert.equal(typeof endpoint.execute, 'undefined');
      assert.equal(typeof endpoint.instruct, 'undefined');
    });

    it('has no methods that modify audit log', async () => {
      const { endpoint } = await createTestHelpEndpoint();
      assert.equal(typeof endpoint.append, 'undefined');
      assert.equal(typeof endpoint.write, 'undefined');
    });

    it('has no methods that modify capital or wallet beyond payment', async () => {
      const { endpoint } = await createTestHelpEndpoint();
      // The only wallet interaction is sendEcash (for payment) and receiveEcash (for refund)
      // Verify there are no deposit, credit, or transfer methods
      assert.equal(typeof endpoint.deposit, 'undefined');
      assert.equal(typeof endpoint.credit, 'undefined');
      assert.equal(typeof endpoint.transfer, 'undefined');
    });
  });

  describe('ask — isolation', () => {
    it('help endpoint failure does not affect wallet operations', async () => {
      const walletOps = createMockWalletOps({ balance: 100 });
      const { endpoint } = await createTestHelpEndpoint({ walletOps });

      // Force a help endpoint error
      try {
        await endpoint.ask('iso-01', 'FORCE_ERROR');
      } catch { /* expected */ }

      // Wallet should still work
      const balance = await walletOps.getBalance('iso-01');
      assert.equal(balance, 100); // Refund should have restored balance
    });

    it('help endpoint failure does not affect assignment registry', async () => {
      const assignments = createMockAssignments();
      assignments._addAssignment('iso-02', { chan_id: '999', channel_point: 'xyz:0' });

      const { endpoint } = await createTestHelpEndpoint({ assignments });

      try {
        await endpoint.ask('iso-02', 'FORCE_ERROR');
      } catch { /* expected */ }

      // Assignments should still be intact
      const channels = assignments.getByAgent('iso-02');
      assert.equal(channels.length, 1);
      assert.equal(channels[0].chan_id, '999');
    });
  });

  describe('ask — graceful degradation', () => {
    it('works without capitalLedger', async () => {
      const { endpoint, registry } = await createTestHelpEndpoint({
        capitalLedger: null,
      });
      registry._addAgent({ id: 'grace-01', name: 'GraceAgent', tier: 'observatory', registered_at: Date.now() });

      const result = await endpoint.ask('grace-01', 'What is my balance?');
      assert.ok(result.answer);
    });

    it('works without performanceTracker', async () => {
      const { endpoint, registry } = await createTestHelpEndpoint({
        performanceTracker: null,
      });
      registry._addAgent({ id: 'grace-02', name: 'GraceAgent2', tier: 'observatory', registered_at: Date.now() });

      const result = await endpoint.ask('grace-02', 'Tell me about my channels');
      assert.ok(result.answer);
    });

    it('works without marketTransparency', async () => {
      const { endpoint, registry } = await createTestHelpEndpoint({
        marketTransparency: null,
      });
      registry._addAgent({ id: 'grace-03', name: 'GraceAgent3', tier: 'observatory', registered_at: Date.now() });

      const result = await endpoint.ask('grace-03', 'What fees are competitive?');
      assert.ok(result.answer);
    });

    it('returns 503 with fallback when LLM is down', async () => {
      const { endpoint, registry } = await createTestHelpEndpoint();
      registry._addAgent({ id: 'grace-04', name: 'GraceAgent4', tier: 'observatory', registered_at: Date.now() });

      await assert.rejects(
        () => endpoint.ask('grace-04', 'FORCE_ERROR trigger'),
        (err) => {
          assert.equal(err.status, 503);
          assert.ok(err.message.includes('playbook'));
          assert.ok(err.message.includes('knowledge'));
          return true;
        },
      );
    });
  });

  describe('_extractLearnTakeaway', () => {
    it('returns last paragraph when short', async () => {
      const { endpoint } = await createTestHelpEndpoint();
      const answer = 'First paragraph.\n\nSecond paragraph with takeaway.';
      assert.equal(endpoint._extractLearnTakeaway(answer), 'Second paragraph with takeaway.');
    });

    it('returns last sentence when last paragraph is long', async () => {
      const { endpoint } = await createTestHelpEndpoint();
      const longParagraph = 'A'.repeat(301);
      const answer = `First.\n\n${longParagraph}`;
      // Should fall back to last sentence
      const result = endpoint._extractLearnTakeaway(answer);
      assert.ok(result.length > 0);
    });

    it('returns empty string for empty input', async () => {
      const { endpoint } = await createTestHelpEndpoint();
      assert.equal(endpoint._extractLearnTakeaway(''), '');
      assert.equal(endpoint._extractLearnTakeaway(null), '');
    });
  });

  describe('badge support', () => {
    it('registry supports setting badge on agent profile', async () => {
      // Test the registry badge method directly
      const { AgentRegistry } = await import('../identity/registry.js');
      const dataLayer = {
        _store: new Map(),
        async readJSON(path) {
          const data = this._store.get(path);
          if (!data) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
          return JSON.parse(JSON.stringify(data));
        },
        async writeJSON(path, data) {
          this._store.set(path, JSON.parse(JSON.stringify(data)));
        },
        async exists(path) {
          return this._store.has(path);
        },
        async listDir() { return []; },
        async appendLog() {},
        async readLog() { return []; },
      };

      const registry = new AgentRegistry(dataLayer);

      // Create a profile manually
      const profile = {
        id: 'badge-test',
        api_key: 'lb-agent-test123',
        name: 'Badge Tester',
        tier: 'observatory',
        registered_at: Date.now(),
      };
      dataLayer._store.set('data/external-agents/badge-test/profile.json', profile);
      registry._keyIndex.set(profile.api_key, profile);
      registry._idIndex.set(profile.id, profile);

      // Set badge
      const updated = await registry.setBadge('badge-test', 'staff');
      assert.equal(updated.badge, 'staff');

      // Verify in-memory
      const fromMemory = registry.getById('badge-test');
      assert.equal(fromMemory.badge, 'staff');

      // Verify on disk
      const fromDisk = await dataLayer.readJSON('data/external-agents/badge-test/profile.json');
      assert.equal(fromDisk.badge, 'staff');

      // Remove badge
      const cleared = await registry.setBadge('badge-test', null);
      assert.equal(cleared.badge, undefined);
    });

    it('badge is included in updateProfile allowed fields', async () => {
      const { AgentRegistry } = await import('../identity/registry.js');
      const dataLayer = {
        _store: new Map(),
        async readJSON(path) {
          const data = this._store.get(path);
          if (!data) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
          return JSON.parse(JSON.stringify(data));
        },
        async writeJSON(path, data) {
          this._store.set(path, JSON.parse(JSON.stringify(data)));
        },
        async exists() { return false; },
        async listDir() { return []; },
      };

      const registry = new AgentRegistry(dataLayer);

      const profile = {
        id: 'badge-update',
        api_key: 'lb-agent-badge-update',
        name: 'Badge Updater',
        tier: 'observatory',
        registered_at: Date.now(),
      };
      dataLayer._store.set('data/external-agents/badge-update/profile.json', profile);
      registry._keyIndex.set(profile.api_key, profile);
      registry._idIndex.set(profile.id, profile);

      // Update via updateProfile
      const updated = await registry.updateProfile('badge-update', { badge: 'staff' });
      assert.equal(updated.badge, 'staff');
    });
  });
});
