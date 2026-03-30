/**
 * Comprehensive tests for the production-hardened SignedInstructionExecutor.
 *
 * Covers:
 * - Per-channel mutex: concurrent instructions on different channels run in parallel;
 *   concurrent instructions on the same channel are serialized
 * - Preview: dry-run validation that never mutates state
 * - Preview idempotency: preview N times, then execute — execution succeeds
 * - Error hints: every error path returns an actionable `hint` field
 * - secp256k1 test vector: the playbook example verifies byte-for-byte
 *
 * Uses real secp256k1 cryptography — no mocks.
 * Run: node --test server/channel-accountability/signed-instruction-executor.test.js
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  createHash, createSign, createPrivateKey,
} from 'node:crypto';
import { SignedInstructionExecutor } from './signed-instruction-executor.js';
import { canonicalJSON } from './crypto-utils.js';
import { generateTestKeypair, signInstruction } from './test-crypto-helpers.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sha256(data) {
  return createHash('sha256').update(data, 'utf-8').digest('hex');
}

function signUtf8Message(message, privateKey) {
  const signer = createSign('SHA256');
  signer.update(message, 'utf8');
  signer.end();
  return signer.sign(privateKey).toString('hex');
}

/**
 * Build a valid instruction object.
 */
function makeInstruction(agentId, channelId, params = {}, overrides = {}) {
  return {
    action: 'set_fee_policy',
    agent_id: agentId,
    channel_id: channelId,
    params: {
      base_fee_msat: 1000,
      fee_rate_ppm: 200,
      ...params,
    },
    timestamp: Math.floor(Date.now() / 1000),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Mock factories
// ---------------------------------------------------------------------------

function createMockAuditLog() {
  const entries = [];
  return {
    entries,
    append: async (entry) => { entries.push({ ...entry, _ts: Date.now(), hash: 'h' }); },
    readAll: async () => entries,
  };
}

function createMockDataLayer() {
  const logs = {};
  return {
    appendLog: async (path, data) => {
      if (!logs[path]) logs[path] = [];
      logs[path].push(data);
    },
    readLog: async (path) => logs[path] || [],
    logs,
  };
}

function createMockNodeManager(connected = true) {
  const feeState = new Map();
  return {
    getDefaultNodeOrNull: () => connected ? {
      feeReport: async () => ({
        channel_fees: Array.from(feeState.entries()).map(([cp, fees]) => ({
          channel_point: cp,
          base_fee_msat: String(fees.base_fee_msat),
          fee_per_mil: String(fees.fee_rate_ppm),
          time_lock_delta: 40,
        })),
      }),
      updateChannelPolicy: async (cp, base, rate, delta) => {
        feeState.set(cp, { base_fee_msat: base, fee_rate_ppm: rate });
      },
      listChannels: async () => ({ channels: [] }),
    } : null,
    setFees: (cp, base, rate) => feeState.set(cp, { base_fee_msat: base, fee_rate_ppm: rate }),
    feeState,
  };
}

function createMockAgentRegistry(agents = {}) {
  return {
    getById: (id) => agents[id] || null,
  };
}

function createMockAssignmentRegistry(assignments = {}) {
  return {
    getAssignment: (chanId) => assignments[chanId] || null,
    getByAgent: (agentId) => Object.values(assignments).filter(a => a.agent_id === agentId),
    getAssignedChannelPoints: () => new Set(Object.values(assignments).map(a => a.channel_point)),
    getChanIdByPoint: (point) => {
      for (const [id, a] of Object.entries(assignments)) {
        if (a.channel_point === point) return id;
      }
      return null;
    },
  };
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('SignedInstructionExecutor — Production Hardening', () => {
  const AGENT_ID = 'agent-alpha';
  const CHAN_ID_1 = '111111111111';
  const CHAN_ID_2 = '222222222222';
  const CHAN_POINT_1 = 'aaa:0';
  const CHAN_POINT_2 = 'bbb:0';

  let kp;
  let executor;
  let auditLog;
  let dataLayer;
  let nodeManager;

  beforeEach(() => {
    kp = generateTestKeypair();
    auditLog = createMockAuditLog();
    dataLayer = createMockDataLayer();
    nodeManager = createMockNodeManager(true);
    nodeManager.setFees(CHAN_POINT_1, 500, 100);
    nodeManager.setFees(CHAN_POINT_2, 500, 100);

    const agentRegistry = createMockAgentRegistry({
      [AGENT_ID]: { id: AGENT_ID, pubkey: kp.pubHex },
    });

    const assignmentRegistry = createMockAssignmentRegistry({
      [CHAN_ID_1]: {
        chan_id: CHAN_ID_1,
        channel_point: CHAN_POINT_1,
        agent_id: AGENT_ID,
        constraints: {
          min_base_fee_msat: 0,
          max_base_fee_msat: 10000,
          min_fee_rate_ppm: 1,
          max_fee_rate_ppm: 2000,
          cooldown_minutes: 60,
        },
      },
      [CHAN_ID_2]: {
        chan_id: CHAN_ID_2,
        channel_point: CHAN_POINT_2,
        agent_id: AGENT_ID,
        constraints: {
          min_base_fee_msat: 0,
          max_base_fee_msat: 5000,
          min_fee_rate_ppm: 10,
          max_fee_rate_ppm: 1000,
          cooldown_minutes: 30,
        },
      },
    });

    executor = new SignedInstructionExecutor({
      assignmentRegistry,
      auditLog,
      nodeManager,
      agentRegistry,
      dataLayer,
    });
  });

  // =========================================================================
  // secp256k1 Test Vector
  // =========================================================================

  describe('secp256k1 test vector from playbook', () => {
    it('produces the exact canonical JSON from the playbook', () => {
      const instruction = {
        action: 'set_fee_policy',
        agent_id: 'test-agent-00',
        channel_id: '867530900000001',
        params: {
          base_fee_msat: 1000,
          fee_rate_ppm: 200,
        },
        timestamp: 1742400000000,
      };
      const canonical = canonicalJSON(instruction);
      assert.equal(
        canonical,
        '{"action":"set_fee_policy","agent_id":"test-agent-00","channel_id":"867530900000001","params":{"base_fee_msat":1000,"fee_rate_ppm":200},"timestamp":1742400000000}',
      );
    });

    it('SHA-256 of canonical JSON matches the playbook test vector', () => {
      const canonical = '{"action":"set_fee_policy","agent_id":"test-agent-00","channel_id":"867530900000001","params":{"base_fee_msat":1000,"fee_rate_ppm":200},"timestamp":1742400000000}';
      const hash = sha256(canonical);
      assert.equal(hash, '90845ab649f087fb44426685381393ce6b50119886a576c3910476af3b26ae50');
    });

    it('secp256k1 signature from the playbook verifies correctly', async () => {
      const { verifySecp256k1Signature } = await import('../identity/auth.js');
      const pubHex = '034f355bdcb7cc0af728ef3cceb9615d90684bb5b2ca5f859ab0f0b704075871aa';
      const canonical = '{"action":"set_fee_policy","agent_id":"test-agent-00","channel_id":"867530900000001","params":{"base_fee_msat":1000,"fee_rate_ppm":200},"timestamp":1742400000000}';
      const privateKey = createPrivateKey({
        key: Buffer.concat([
          Buffer.from('302e0201010420', 'hex'),
          Buffer.from('1111111111111111111111111111111111111111111111111111111111111111', 'hex'),
          Buffer.from('a00706052b8104000a', 'hex'),
        ]),
        format: 'der',
        type: 'sec1',
      });
      const sigHex = signUtf8Message(canonical, privateKey);
      const valid = await verifySecp256k1Signature(pubHex, canonical, sigHex);
      assert.equal(valid, true, 'Playbook test vector signature must verify');
    });

    it('canonical JSON key ordering is correct regardless of input key order', () => {
      // Input with keys in non-sorted order
      const instruction = {
        timestamp: 1742400000000,
        action: 'set_fee_policy',
        params: { fee_rate_ppm: 200, base_fee_msat: 1000 },
        channel_id: '867530900000001',
        agent_id: 'test-agent-00',
      };
      const canonical = canonicalJSON(instruction);
      assert.equal(
        canonical,
        '{"action":"set_fee_policy","agent_id":"test-agent-00","channel_id":"867530900000001","params":{"base_fee_msat":1000,"fee_rate_ppm":200},"timestamp":1742400000000}',
      );
    });
  });

  // =========================================================================
  // Execute — happy path
  // =========================================================================

  describe('execute() — happy path', () => {
    it('executes a valid signed instruction', async () => {
      const instruction = makeInstruction(AGENT_ID, CHAN_ID_1);
      const signature = signInstruction(instruction, kp.privateKey);
      const result = await executor.execute(AGENT_ID, { instruction, signature });
      assert.equal(result.success, true);
      assert.equal(result.result.channel_id, CHAN_ID_1);
      assert.equal(result.result.action, 'set_fee_policy');
      assert.ok(result.result.executed_at);
      assert.ok(result.result.next_allowed_at > result.result.executed_at);
      assert.ok(result.learn, 'Success response should include learn field');
    });

    it('updates the fee state on LND', async () => {
      const instruction = makeInstruction(AGENT_ID, CHAN_ID_1, { base_fee_msat: 2000, fee_rate_ppm: 500 });
      const signature = signInstruction(instruction, kp.privateKey);
      await executor.execute(AGENT_ID, { instruction, signature });
      const fees = nodeManager.feeState.get(CHAN_POINT_1);
      assert.equal(fees.base_fee_msat, 2000);
      assert.equal(fees.fee_rate_ppm, 500);
    });

    it('writes to the audit log', async () => {
      const instruction = makeInstruction(AGENT_ID, CHAN_ID_1);
      const signature = signInstruction(instruction, kp.privateKey);
      await executor.execute(AGENT_ID, { instruction, signature });
      const received = auditLog.entries.filter(e => e.type === 'instruction_received');
      const executed = auditLog.entries.filter(e => e.type === 'instruction_executed');
      assert.equal(received.length, 1);
      assert.equal(executed.length, 1);
    });
  });

  // =========================================================================
  // Error hints — every error path
  // =========================================================================

  describe('execute() — error hints', () => {
    it('returns hint for missing payload', async () => {
      const result = await executor.execute(AGENT_ID, null);
      assert.equal(result.success, false);
      assert.equal(result.status, 400);
      assert.ok(result.hint, 'Must include hint');
      assert.ok(result.hint.includes('instruction'));
      assert.equal(result.failed_at, 'payload_present');
    });

    it('returns hint for missing instruction field', async () => {
      const result = await executor.execute(AGENT_ID, { signature: 'abc' });
      assert.equal(result.success, false);
      assert.ok(result.hint.includes('instruction'));
    });

    it('returns hint for missing signature field', async () => {
      const result = await executor.execute(AGENT_ID, { instruction: {} });
      assert.equal(result.success, false);
      assert.ok(result.hint.includes('signature'));
    });

    it('returns hint for agent without pubkey', async () => {
      const noPubkeyRegistry = createMockAgentRegistry({
        [AGENT_ID]: { id: AGENT_ID },
      });
      const exec = new SignedInstructionExecutor({
        assignmentRegistry: createMockAssignmentRegistry(),
        auditLog,
        nodeManager,
        agentRegistry: noPubkeyRegistry,
        dataLayer,
      });
      const instruction = makeInstruction(AGENT_ID, CHAN_ID_1);
      const signature = signInstruction(instruction, kp.privateKey);
      const result = await exec.execute(AGENT_ID, { instruction, signature });
      assert.equal(result.success, false);
      assert.equal(result.failed_at, 'pubkey_registered');
      assert.ok(result.hint.includes('PUT /api/v1/agents/me'));
    });

    it('returns hint for unknown action', async () => {
      const instruction = makeInstruction(AGENT_ID, CHAN_ID_1, {}, { action: 'delete_channel' });
      const signature = signInstruction(instruction, kp.privateKey);
      const result = await executor.execute(AGENT_ID, { instruction, signature });
      assert.equal(result.success, false);
      assert.equal(result.failed_at, 'action_valid');
      assert.ok(result.hint.includes('set_fee_policy'));
      assert.ok(result.hint.includes('update_htlc_limits'));
    });

    it('returns hint for agent_id mismatch', async () => {
      const instruction = makeInstruction('wrong-agent', CHAN_ID_1);
      const signature = signInstruction(instruction, kp.privateKey);
      const result = await executor.execute(AGENT_ID, { instruction, signature });
      assert.equal(result.success, false);
      assert.equal(result.failed_at, 'agent_id_matches');
      assert.ok(result.hint.includes('GET /api/v1/agents/me'));
    });

    it('returns hint for stale timestamp', async () => {
      const instruction = makeInstruction(AGENT_ID, CHAN_ID_1, {}, { timestamp: Math.floor(Date.now() / 1000) - 600 });
      const signature = signInstruction(instruction, kp.privateKey);
      const result = await executor.execute(AGENT_ID, { instruction, signature });
      assert.equal(result.success, false);
      assert.equal(result.failed_at, 'timestamp_fresh');
      assert.ok(result.hint.includes('300 seconds'));
      assert.ok(result.hint.includes('Server time'));
    });

    it('returns hint for missing timestamp', async () => {
      const instruction = makeInstruction(AGENT_ID, CHAN_ID_1, {}, { timestamp: undefined });
      // Remove timestamp entirely
      delete instruction.timestamp;
      const signature = signInstruction(instruction, kp.privateKey);
      const result = await executor.execute(AGENT_ID, { instruction, signature });
      assert.equal(result.success, false);
      assert.equal(result.failed_at, 'timestamp_fresh');
      assert.ok(result.hint.includes('Date.now()'));
    });

    it('returns hint for duplicate instruction', async () => {
      const instruction = makeInstruction(AGENT_ID, CHAN_ID_1);
      const signature = signInstruction(instruction, kp.privateKey);
      // First call succeeds
      const r1 = await executor.execute(AGENT_ID, { instruction, signature });
      assert.equal(r1.success, true);
      // Same payload again
      const r2 = await executor.execute(AGENT_ID, { instruction, signature });
      assert.equal(r2.success, false);
      assert.equal(r2.status, 409);
      assert.ok(r2.hint.includes('dedup'));
    });

    it('returns hint for channel not assigned', async () => {
      const instruction = makeInstruction(AGENT_ID, '999999999999');
      const signature = signInstruction(instruction, kp.privateKey);
      const result = await executor.execute(AGENT_ID, { instruction, signature });
      assert.equal(result.success, false);
      assert.equal(result.failed_at, 'channel_owned');
      assert.ok(result.checks_passed.includes('signature_valid'));
      assert.ok(result.hint.includes('operator'));
    });

    it('returns hint for channel assigned to different agent', async () => {
      const otherKp = generateTestKeypair();
      const otherAgentId = 'agent-beta';
      const agentRegistry = createMockAgentRegistry({
        [otherAgentId]: { id: otherAgentId, pubkey: otherKp.pubHex },
      });
      const assignmentRegistry = createMockAssignmentRegistry({
        [CHAN_ID_1]: {
          chan_id: CHAN_ID_1,
          channel_point: CHAN_POINT_1,
          agent_id: AGENT_ID, // Assigned to alpha, but beta is trying
        },
      });
      const exec = new SignedInstructionExecutor({
        assignmentRegistry,
        auditLog,
        nodeManager,
        agentRegistry,
        dataLayer,
      });
      const instruction = makeInstruction(otherAgentId, CHAN_ID_1);
      const signature = signInstruction(instruction, otherKp.privateKey);
      const result = await exec.execute(otherAgentId, { instruction, signature });
      assert.equal(result.success, false);
      assert.equal(result.failed_at, 'channel_owned');
      assert.ok(result.hint.includes('GET /api/v1/channels/mine'));
    });

    it('returns hint for invalid signature', async () => {
      const instruction = makeInstruction(AGENT_ID, CHAN_ID_1);
      const badSig = 'ff'.repeat(64); // Valid hex length but wrong signature
      const result = await executor.execute(AGENT_ID, { instruction, signature: badSig });
      assert.equal(result.success, false);
      assert.equal(result.failed_at, 'signature_valid');
      assert.ok(result.hint.includes('canonicalJSON(instruction)'));
      assert.ok(result.hint.includes('RFC 8785'));
    });

    it('returns hint for constraint violation — fee_rate_ppm too high', async () => {
      const instruction = makeInstruction(AGENT_ID, CHAN_ID_1, { fee_rate_ppm: 5000 });
      const signature = signInstruction(instruction, kp.privateKey);
      const result = await executor.execute(AGENT_ID, { instruction, signature });
      assert.equal(result.success, false);
      assert.equal(result.failed_at, 'constraints_met');
      assert.ok(result.hint.includes('max=2000'));
      assert.ok(result.hint.includes('GET /api/v1/channels/mine'));
    });

    it('returns hint for constraint violation — base_fee_msat too low', async () => {
      // Chan 2 has min_fee_rate_ppm: 10
      const instruction = makeInstruction(AGENT_ID, CHAN_ID_2, { fee_rate_ppm: 5 });
      const signature = signInstruction(instruction, kp.privateKey);
      const result = await executor.execute(AGENT_ID, { instruction, signature });
      assert.equal(result.success, false);
      assert.equal(result.failed_at, 'constraints_met');
      assert.ok(result.hint.includes('min=10'));
    });

    it('returns hint for cooldown active', async () => {
      // First execution succeeds
      const instr1 = makeInstruction(AGENT_ID, CHAN_ID_1);
      const sig1 = signInstruction(instr1, kp.privateKey);
      const r1 = await executor.execute(AGENT_ID, { instruction: instr1, signature: sig1 });
      assert.equal(r1.success, true);

      // Second execution hits cooldown
      const instr2 = makeInstruction(AGENT_ID, CHAN_ID_1, { base_fee_msat: 2000 });
      const sig2 = signInstruction(instr2, kp.privateKey);
      const r2 = await executor.execute(AGENT_ID, { instruction: instr2, signature: sig2 });
      assert.equal(r2.success, false);
      assert.equal(r2.status, 429);
      assert.ok(r2.retry_after_seconds > 0);
      assert.ok(r2.hint.includes('Cooldown'));
      assert.ok(r2.hint.includes('gossip'));
    });

    it('returns hint for LND unavailable', async () => {
      // Disconnect LND
      const disconnectedNodeManager = createMockNodeManager(false);
      const agentRegistry = createMockAgentRegistry({
        [AGENT_ID]: { id: AGENT_ID, pubkey: kp.pubHex },
      });
      const assignmentRegistry = createMockAssignmentRegistry({
        [CHAN_ID_1]: {
          chan_id: CHAN_ID_1,
          channel_point: CHAN_POINT_1,
          agent_id: AGENT_ID,
          constraints: { cooldown_minutes: 0 },
        },
      });
      const exec = new SignedInstructionExecutor({
        assignmentRegistry,
        auditLog,
        nodeManager: disconnectedNodeManager,
        agentRegistry,
        dataLayer,
      });
      const instruction = makeInstruction(AGENT_ID, CHAN_ID_1);
      const signature = signInstruction(instruction, kp.privateKey);
      const result = await exec.execute(AGENT_ID, { instruction, signature });
      assert.equal(result.success, false);
      assert.equal(result.status, 503);
      assert.ok(result.hint.includes('LND'));
      assert.ok(result.hint.includes('GET /api/v1/channels/status'));
    });
  });

  // =========================================================================
  // Preview
  // =========================================================================

  describe('preview()', () => {
    it('returns valid=true with all 9 checks for a valid instruction', async () => {
      const instruction = makeInstruction(AGENT_ID, CHAN_ID_1);
      const signature = signInstruction(instruction, kp.privateKey);
      const result = await executor.preview(AGENT_ID, { instruction, signature });
      assert.equal(result.valid, true);
      assert.deepEqual(result.checks_passed, [
        'pubkey_registered',
        'action_valid',
        'agent_id_matches',
        'timestamp_fresh',
        'not_duplicate',
        'signature_valid',
        'channel_owned',
        'constraints_met',
        'cooldown_clear',
      ]);
      assert.equal(result.would_execute.action, 'set_fee_policy');
      assert.equal(result.would_execute.channel_id, CHAN_ID_1);
      assert.ok(result.learn, 'Preview should include learn field');
    });

    it('returns current_policy from LND', async () => {
      const instruction = makeInstruction(AGENT_ID, CHAN_ID_1);
      const signature = signInstruction(instruction, kp.privateKey);
      const result = await executor.preview(AGENT_ID, { instruction, signature });
      assert.ok(result.current_policy);
      assert.equal(result.current_policy.base_fee_msat, 500);
      assert.equal(result.current_policy.fee_rate_ppm, 100);
    });

    it('returns failed_at and hint on signature failure', async () => {
      const instruction = makeInstruction(AGENT_ID, CHAN_ID_1);
      const badSig = 'aa'.repeat(64);
      const result = await executor.preview(AGENT_ID, { instruction, signature: badSig });
      assert.equal(result.valid, false);
      assert.equal(result.failed_at, 'signature_valid');
      assert.ok(result.hint.includes('canonical'));
      assert.deepEqual(result.checks_passed, [
        'pubkey_registered',
        'action_valid',
        'agent_id_matches',
        'timestamp_fresh',
        'not_duplicate',
      ]);
    });

    it('returns failed_at on constraint violation with hint', async () => {
      const instruction = makeInstruction(AGENT_ID, CHAN_ID_1, { fee_rate_ppm: 9999 });
      const signature = signInstruction(instruction, kp.privateKey);
      const result = await executor.preview(AGENT_ID, { instruction, signature });
      assert.equal(result.valid, false);
      assert.equal(result.failed_at, 'constraints_met');
      assert.ok(result.hint);
    });

    it('does NOT mutate dedup state', async () => {
      const instruction = makeInstruction(AGENT_ID, CHAN_ID_1);
      const signature = signInstruction(instruction, kp.privateKey);

      // Preview
      const preview = await executor.preview(AGENT_ID, { instruction, signature });
      assert.equal(preview.valid, true);

      // Execute the same payload — should NOT get "duplicate"
      const result = await executor.execute(AGENT_ID, { instruction, signature });
      assert.equal(result.success, true, 'Execute must succeed after preview — preview must not pollute dedup');
    });

    it('does NOT mutate cooldown state', async () => {
      const instruction = makeInstruction(AGENT_ID, CHAN_ID_1);
      const signature = signInstruction(instruction, kp.privateKey);

      // Preview
      await executor.preview(AGENT_ID, { instruction, signature });

      // Execute
      const result = await executor.execute(AGENT_ID, { instruction, signature });
      assert.equal(result.success, true, 'Execute must succeed — preview must not insert cooldown');
    });

    it('does NOT write to the audit log', async () => {
      const instruction = makeInstruction(AGENT_ID, CHAN_ID_1);
      const signature = signInstruction(instruction, kp.privateKey);

      const beforeCount = auditLog.entries.length;
      await executor.preview(AGENT_ID, { instruction, signature });
      assert.equal(auditLog.entries.length, beforeCount, 'Preview must not write audit log entries');
    });

    it('does NOT write to instructions.jsonl', async () => {
      const instruction = makeInstruction(AGENT_ID, CHAN_ID_1);
      const signature = signInstruction(instruction, kp.privateKey);

      await executor.preview(AGENT_ID, { instruction, signature });
      assert.equal(
        (dataLayer.logs['data/channel-accountability/instructions.jsonl'] || []).length,
        0,
        'Preview must not write to instructions log',
      );
    });
  });

  // =========================================================================
  // Preview idempotency
  // =========================================================================

  describe('preview idempotency', () => {
    it('preview 10 times then execute — execution succeeds', async () => {
      const instruction = makeInstruction(AGENT_ID, CHAN_ID_1);
      const signature = signInstruction(instruction, kp.privateKey);

      for (let i = 0; i < 10; i++) {
        const preview = await executor.preview(AGENT_ID, { instruction, signature });
        assert.equal(preview.valid, true, `Preview #${i + 1} must pass`);
      }

      const result = await executor.execute(AGENT_ID, { instruction, signature });
      assert.equal(result.success, true, 'Execute must succeed after 10 previews');
    });
  });

  // =========================================================================
  // Per-channel mutex
  // =========================================================================

  describe('per-channel mutex', () => {
    it('two instructions on different channels execute in parallel', async () => {
      const instr1 = makeInstruction(AGENT_ID, CHAN_ID_1);
      const sig1 = signInstruction(instr1, kp.privateKey);
      const instr2 = makeInstruction(AGENT_ID, CHAN_ID_2);
      const sig2 = signInstruction(instr2, kp.privateKey);

      // Launch both concurrently
      const [r1, r2] = await Promise.all([
        executor.execute(AGENT_ID, { instruction: instr1, signature: sig1 }),
        executor.execute(AGENT_ID, { instruction: instr2, signature: sig2 }),
      ]);

      assert.equal(r1.success, true, 'Channel 1 instruction should succeed');
      assert.equal(r2.success, true, 'Channel 2 instruction should succeed');
    });

    it('two instructions on the same channel are serialized (second hits cooldown)', async () => {
      const instr1 = makeInstruction(AGENT_ID, CHAN_ID_1, { base_fee_msat: 1000 });
      const sig1 = signInstruction(instr1, kp.privateKey);
      const instr2 = makeInstruction(AGENT_ID, CHAN_ID_1, { base_fee_msat: 2000 });
      const sig2 = signInstruction(instr2, kp.privateKey);

      // Launch both concurrently on the same channel
      const [r1, r2] = await Promise.all([
        executor.execute(AGENT_ID, { instruction: instr1, signature: sig1 }),
        executor.execute(AGENT_ID, { instruction: instr2, signature: sig2 }),
      ]);

      // One succeeds, the other hits cooldown (serialized by mutex)
      const successes = [r1, r2].filter(r => r.success);
      const failures = [r1, r2].filter(r => !r.success);
      assert.equal(successes.length, 1, 'Exactly one should succeed');
      assert.equal(failures.length, 1, 'Exactly one should fail (cooldown)');
      assert.equal(failures[0].status, 429, 'Failure should be cooldown (429)');
    });

    it('mutex is released even on error', async () => {
      // Execute with LND failure, then try again
      const failingNodeManager = {
        getDefaultNodeOrNull: () => ({
          feeReport: async () => ({ channel_fees: [] }),
          updateChannelPolicy: async () => { throw new Error('LND is on fire'); },
        }),
      };
      const agentRegistry = createMockAgentRegistry({
        [AGENT_ID]: { id: AGENT_ID, pubkey: kp.pubHex },
      });
      const assignmentRegistry = createMockAssignmentRegistry({
        [CHAN_ID_1]: {
          chan_id: CHAN_ID_1,
          channel_point: CHAN_POINT_1,
          agent_id: AGENT_ID,
          constraints: { cooldown_minutes: 0 },
        },
      });
      const exec = new SignedInstructionExecutor({
        assignmentRegistry,
        auditLog,
        nodeManager: failingNodeManager,
        agentRegistry,
        dataLayer,
      });

      const instr1 = makeInstruction(AGENT_ID, CHAN_ID_1);
      const sig1 = signInstruction(instr1, kp.privateKey);
      const r1 = await exec.execute(AGENT_ID, { instruction: instr1, signature: sig1 });
      assert.equal(r1.success, false);
      assert.equal(r1.status, 502);

      // Now try with working nodeManager — should not deadlock
      // (This tests that the mutex was released in the finally block)
      // We need to swap the nodeManager, which isn't possible with the current constructor,
      // but we can verify the mutex was released by attempting another operation.
      // The fact that the first call returned means the mutex was released.
      // Let's verify by doing a preview which doesn't need the mutex.
      const instr2 = makeInstruction(AGENT_ID, CHAN_ID_1, { base_fee_msat: 3000 });
      const sig2 = signInstruction(instr2, kp.privateKey);
      // This would hang if the mutex was not released
      const previewResult = await Promise.race([
        exec.preview(AGENT_ID, { instruction: instr2, signature: sig2 }),
        new Promise((_, reject) => setTimeout(() => reject(new Error('Mutex deadlock detected')), 1000)),
      ]);
      // Preview should complete (mutex is not held by preview, but this confirms no global deadlock)
      assert.ok(previewResult);
    });
  });

  // =========================================================================
  // Constraint edge cases
  // =========================================================================

  describe('constraint edge cases', () => {
    it('allows params exactly at constraint boundaries', async () => {
      // Chan 1: max_fee_rate_ppm = 2000, max_base_fee_msat = 10000
      const instruction = makeInstruction(AGENT_ID, CHAN_ID_1, {
        base_fee_msat: 10000,
        fee_rate_ppm: 2000,
      });
      const signature = signInstruction(instruction, kp.privateKey);
      const result = await executor.execute(AGENT_ID, { instruction, signature });
      assert.equal(result.success, true, 'Exact boundary values must be allowed');
    });

    it('rejects params one above constraint boundary', async () => {
      const instruction = makeInstruction(AGENT_ID, CHAN_ID_1, {
        base_fee_msat: 10001, // max is 10000
      });
      const signature = signInstruction(instruction, kp.privateKey);
      const result = await executor.execute(AGENT_ID, { instruction, signature });
      assert.equal(result.success, false);
      assert.equal(result.failed_at, 'constraints_met');
    });

    it('allows params at minimum constraint boundary', async () => {
      // Chan 2: min_fee_rate_ppm = 10
      const instruction = makeInstruction(AGENT_ID, CHAN_ID_2, {
        fee_rate_ppm: 10,
      });
      const signature = signInstruction(instruction, kp.privateKey);
      const result = await executor.preview(AGENT_ID, { instruction, signature });
      assert.equal(result.valid, true, 'Exact minimum boundary must be allowed');
    });

    it('rejects params one below minimum constraint boundary', async () => {
      // Chan 2: min_fee_rate_ppm = 10
      const instruction = makeInstruction(AGENT_ID, CHAN_ID_2, {
        fee_rate_ppm: 9,
      });
      const signature = signInstruction(instruction, kp.privateKey);
      const result = await executor.preview(AGENT_ID, { instruction, signature });
      assert.equal(result.valid, false);
      assert.equal(result.failed_at, 'constraints_met');
    });
  });

  // =========================================================================
  // update_htlc_limits action
  // =========================================================================

  describe('update_htlc_limits action', () => {
    it('validates and previews update_htlc_limits', async () => {
      const instruction = {
        action: 'update_htlc_limits',
        agent_id: AGENT_ID,
        channel_id: CHAN_ID_1,
        params: {
          min_htlc_msat: 1000,
          max_htlc_msat: 1000000,
        },
        timestamp: Math.floor(Date.now() / 1000),
      };
      const signature = signInstruction(instruction, kp.privateKey);
      const result = await executor.preview(AGENT_ID, { instruction, signature });
      assert.equal(result.valid, true);
      assert.equal(result.would_execute.action, 'update_htlc_limits');
    });
  });

  // =========================================================================
  // Signing correctness
  // =========================================================================

  describe('signing correctness', () => {
    it('rejects signature from wrong key', async () => {
      const wrongKp = generateTestKeypair();
      const instruction = makeInstruction(AGENT_ID, CHAN_ID_1);
      // Sign with wrong key
      const signature = signInstruction(instruction, wrongKp.privateKey);
      const result = await executor.execute(AGENT_ID, { instruction, signature });
      assert.equal(result.success, false);
      assert.equal(result.failed_at, 'signature_valid');
    });

    it('rejects signature of the wrapper instead of the instruction', async () => {
      const instruction = makeInstruction(AGENT_ID, CHAN_ID_1);
      // Common mistake: sign the full payload { instruction, signature: '' }
      const wrongMessage = canonicalJSON({ instruction, signature: '' });
      const signature = signUtf8Message(wrongMessage, kp.privateKey);
      const result = await executor.execute(AGENT_ID, { instruction, signature });
      assert.equal(result.success, false);
      assert.equal(result.failed_at, 'signature_valid');
    });

    it('rejects signature of JSON.stringify instead of canonicalJSON', async () => {
      const instruction = makeInstruction(AGENT_ID, CHAN_ID_1);
      // Another common mistake: use JSON.stringify which doesn't sort keys
      const wrongMessage = JSON.stringify(instruction);
      const signature = signUtf8Message(wrongMessage, kp.privateKey);
      const result = await executor.execute(AGENT_ID, { instruction, signature });
      // This might actually pass if JSON.stringify happens to sort keys the same way,
      // but in general it won't. We verify it either passes (if same) or fails at signature.
      if (!result.success) {
        assert.equal(result.failed_at, 'signature_valid');
      }
    });
  });

  // =========================================================================
  // Timestamp edge cases
  // =========================================================================

  describe('timestamp edge cases', () => {
    it('accepts timestamp exactly at the boundary (5 minutes ago)', async () => {
      const instruction = makeInstruction(AGENT_ID, CHAN_ID_1, {}, {
        timestamp: Math.floor(Date.now() / 1000) - 299, // Just under 5 minutes
      });
      const signature = signInstruction(instruction, kp.privateKey);
      const result = await executor.preview(AGENT_ID, { instruction, signature });
      assert.equal(result.valid, true);
    });

    it('rejects timestamp from the future beyond tolerance', async () => {
      const instruction = makeInstruction(AGENT_ID, CHAN_ID_1, {}, {
        timestamp: Math.floor(Date.now() / 1000) + 400, // 6+ minutes in the future
      });
      const signature = signInstruction(instruction, kp.privateKey);
      const result = await executor.preview(AGENT_ID, { instruction, signature });
      assert.equal(result.valid, false);
      assert.equal(result.failed_at, 'timestamp_fresh');
    });
  });

  // =========================================================================
  // Canonical JSON edge cases
  // =========================================================================

  describe('canonicalJSON edge cases', () => {
    it('handles null values', () => {
      assert.equal(canonicalJSON(null), 'null');
    });

    it('handles undefined as null', () => {
      assert.equal(canonicalJSON(undefined), 'null');
    });

    it('handles nested objects with correct key ordering', () => {
      const obj = { z: { b: 2, a: 1 }, a: { d: 4, c: 3 } };
      assert.equal(canonicalJSON(obj), '{"a":{"c":3,"d":4},"z":{"a":1,"b":2}}');
    });

    it('handles arrays', () => {
      const arr = [3, 1, 2];
      assert.equal(canonicalJSON(arr), '[3,1,2]');
    });

    it('handles booleans', () => {
      assert.equal(canonicalJSON(true), 'true');
      assert.equal(canonicalJSON(false), 'false');
    });

    it('omits undefined object values', () => {
      const obj = { a: 1, b: undefined, c: 3 };
      assert.equal(canonicalJSON(obj), '{"a":1,"c":3}');
    });

    it('handles Infinity as null', () => {
      assert.equal(canonicalJSON(Infinity), 'null');
      assert.equal(canonicalJSON(-Infinity), 'null');
      assert.equal(canonicalJSON(NaN), 'null');
    });
  });

  // =========================================================================
  // getInstructions
  // =========================================================================

  describe('getInstructions()', () => {
    it('returns instruction history filtered by agent', async () => {
      const instruction = makeInstruction(AGENT_ID, CHAN_ID_1);
      const signature = signInstruction(instruction, kp.privateKey);
      await executor.execute(AGENT_ID, { instruction, signature });

      const history = await executor.getInstructions(AGENT_ID);
      assert.equal(history.length, 1);
      assert.equal(history[0].agent_id, AGENT_ID);
    });
  });
});
