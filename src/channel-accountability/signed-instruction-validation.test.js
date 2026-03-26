/**
 * Signed Instruction Validation — Unit tests for shared steps 1–7.
 */

import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { validateSignedInstruction, SHARED_VALIDATION_HINTS } from './signed-instruction-validation.js';
import { sha256 } from './crypto-utils.js';
import { generateTestKeypair, signInstruction } from './test-crypto-helpers.js';

/** Minimal dedup cache mock */
function mockDedup() {
  const seen = new Set();
  return {
    has: (h) => seen.has(h),
    mark: (h) => seen.add(h),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('validateSignedInstruction', () => {
  const AGENT_ID = 'test-agent-1';
  const ACTION = 'channel_open';
  let keypair;

  const ACTION_HINTS = {
    missing_payload: 'Send instruction + signature',
    wrong_action: 'Only channel_open accepted',
  };

  before(() => {
    keypair = generateTestKeypair();
  });

  function makeInstruction(overrides = {}) {
    return {
      action: ACTION,
      agent_id: AGENT_ID,
      timestamp: Math.floor(Date.now() / 1000),
      params: { peer_pubkey: '03' + 'aa'.repeat(32) },
      ...overrides,
    };
  }

  function makeSignedPayload(instrOverrides = {}) {
    const instruction = makeInstruction(instrOverrides);
    const signature = signInstruction(instruction, keypair.privateKey);
    return { instruction, signature };
  }

  function agentRegistry(agents = {}) {
    return { getById: (id) => agents[id] || null };
  }

  const defaultRegistry = () => agentRegistry({
    [AGENT_ID]: { id: AGENT_ID, pubkey: keypair.pubHex },
  });

  it('passes all 7 steps with valid input', async () => {
    const result = await validateSignedInstruction({
      agentId: AGENT_ID,
      payload: makeSignedPayload(),
      expectedAction: ACTION,
      agentRegistry: defaultRegistry(),
      dedup: mockDedup(),
      actionHints: ACTION_HINTS,
    });

    assert.equal(result.success, true);
    assert.deepEqual(result.checks_passed, [
      'payload_present', 'pubkey_registered', 'action_valid',
      'agent_id_matches', 'timestamp_fresh', 'not_duplicate', 'signature_valid',
    ]);
    assert.ok(result.instrHash);
    assert.ok(result.params);
  });

  it('step 1: rejects missing instruction', async () => {
    const result = await validateSignedInstruction({
      agentId: AGENT_ID,
      payload: {},
      expectedAction: ACTION,
      agentRegistry: defaultRegistry(),
      dedup: mockDedup(),
      actionHints: ACTION_HINTS,
    });
    assert.equal(result.success, false);
    assert.equal(result.failed_at, 'payload_present');
    assert.equal(result.status, 400);
  });

  it('step 1: rejects missing signature', async () => {
    const result = await validateSignedInstruction({
      agentId: AGENT_ID,
      payload: { instruction: makeInstruction() },
      expectedAction: ACTION,
      agentRegistry: defaultRegistry(),
      dedup: mockDedup(),
      actionHints: ACTION_HINTS,
    });
    assert.equal(result.success, false);
    assert.equal(result.failed_at, 'payload_present');
  });

  it('step 2: rejects agent without pubkey', async () => {
    const result = await validateSignedInstruction({
      agentId: AGENT_ID,
      payload: makeSignedPayload(),
      expectedAction: ACTION,
      agentRegistry: agentRegistry({ [AGENT_ID]: { id: AGENT_ID } }),
      dedup: mockDedup(),
      actionHints: ACTION_HINTS,
    });
    assert.equal(result.success, false);
    assert.equal(result.failed_at, 'pubkey_registered');
  });

  it('step 2: rejects unknown agent', async () => {
    const result = await validateSignedInstruction({
      agentId: AGENT_ID,
      payload: makeSignedPayload(),
      expectedAction: ACTION,
      agentRegistry: agentRegistry({}),
      dedup: mockDedup(),
      actionHints: ACTION_HINTS,
    });
    assert.equal(result.success, false);
    assert.equal(result.failed_at, 'pubkey_registered');
  });

  it('step 3: rejects wrong action', async () => {
    const result = await validateSignedInstruction({
      agentId: AGENT_ID,
      payload: makeSignedPayload({ action: 'channel_close' }),
      expectedAction: ACTION,
      agentRegistry: defaultRegistry(),
      dedup: mockDedup(),
      actionHints: ACTION_HINTS,
    });
    assert.equal(result.success, false);
    assert.equal(result.failed_at, 'action_valid');
    assert.ok(result.error.includes('channel_close'));
  });

  it('step 4: rejects agent_id mismatch', async () => {
    const result = await validateSignedInstruction({
      agentId: AGENT_ID,
      payload: makeSignedPayload({ agent_id: 'wrong-agent' }),
      expectedAction: ACTION,
      agentRegistry: defaultRegistry(),
      dedup: mockDedup(),
      actionHints: ACTION_HINTS,
    });
    assert.equal(result.success, false);
    assert.equal(result.failed_at, 'agent_id_matches');
  });

  it('step 5: rejects non-numeric timestamp', async () => {
    const result = await validateSignedInstruction({
      agentId: AGENT_ID,
      payload: makeSignedPayload({ timestamp: 'not-a-number' }),
      expectedAction: ACTION,
      agentRegistry: defaultRegistry(),
      dedup: mockDedup(),
      actionHints: ACTION_HINTS,
    });
    assert.equal(result.success, false);
    assert.equal(result.failed_at, 'timestamp_fresh');
  });

  it('step 5: rejects stale timestamp (>300s drift)', async () => {
    const result = await validateSignedInstruction({
      agentId: AGENT_ID,
      payload: makeSignedPayload({ timestamp: Math.floor(Date.now() / 1000) - 600 }),
      expectedAction: ACTION,
      agentRegistry: defaultRegistry(),
      dedup: mockDedup(),
      actionHints: ACTION_HINTS,
    });
    assert.equal(result.success, false);
    assert.equal(result.failed_at, 'timestamp_fresh');
    assert.equal(result.status, 400);
  });

  it('step 6: rejects duplicate instruction', async () => {
    const dedup = mockDedup();
    const payload = makeSignedPayload();

    // First call succeeds
    const first = await validateSignedInstruction({
      agentId: AGENT_ID, payload, expectedAction: ACTION,
      agentRegistry: defaultRegistry(), dedup, actionHints: ACTION_HINTS,
    });
    assert.equal(first.success, true);

    // Mark it as seen (callers do this)
    dedup.mark(first.instrHash);

    // Second call with same payload fails
    const second = await validateSignedInstruction({
      agentId: AGENT_ID, payload, expectedAction: ACTION,
      agentRegistry: defaultRegistry(), dedup, actionHints: ACTION_HINTS,
    });
    assert.equal(second.success, false);
    assert.equal(second.failed_at, 'not_duplicate');
    assert.equal(second.status, 409);
  });

  it('step 7: rejects invalid signature', async () => {
    const instruction = makeInstruction();
    const result = await validateSignedInstruction({
      agentId: AGENT_ID,
      payload: { instruction, signature: 'deadbeef'.repeat(16) },
      expectedAction: ACTION,
      agentRegistry: defaultRegistry(),
      dedup: mockDedup(),
      actionHints: ACTION_HINTS,
    });
    assert.equal(result.success, false);
    assert.equal(result.failed_at, 'signature_valid');
    assert.equal(result.status, 401);
  });

  it('does NOT call dedup.mark()', async () => {
    const dedup = mockDedup();
    const result = await validateSignedInstruction({
      agentId: AGENT_ID,
      payload: makeSignedPayload(),
      expectedAction: ACTION,
      agentRegistry: defaultRegistry(),
      dedup,
      actionHints: ACTION_HINTS,
    });
    assert.equal(result.success, true);

    // The shared function must NOT mark — callers do it at their own time
    assert.equal(dedup.has(result.instrHash), false);
  });

  it('returns profile on success', async () => {
    const result = await validateSignedInstruction({
      agentId: AGENT_ID,
      payload: makeSignedPayload(),
      expectedAction: ACTION,
      agentRegistry: defaultRegistry(),
      dedup: mockDedup(),
      actionHints: ACTION_HINTS,
    });
    assert.equal(result.success, true);
    assert.equal(result.profile.id, AGENT_ID);
    assert.equal(result.profile.pubkey, keypair.pubHex);
  });

  it('exports SHARED_VALIDATION_HINTS', () => {
    assert.ok(SHARED_VALIDATION_HINTS.no_pubkey);
    assert.ok(SHARED_VALIDATION_HINTS.agent_id_mismatch);
    assert.ok(typeof SHARED_VALIDATION_HINTS.stale_timestamp === 'function');
    assert.ok(SHARED_VALIDATION_HINTS.duplicate);
    assert.ok(SHARED_VALIDATION_HINTS.invalid_signature);
  });
});
