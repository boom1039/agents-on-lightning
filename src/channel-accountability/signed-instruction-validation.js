/**
 * Shared signed-instruction validation pipeline (steps 1–7).
 *
 * Both ChannelOpener and ChannelCloser run identical checks for:
 *   1. payload_present   — instruction + signature exist
 *   2. pubkey_registered  — agent has an Ed25519 public key
 *   3. action_valid       — instruction.action matches expected
 *   4. agent_id_matches   — instruction.agent_id == authenticated agent
 *   5. timestamp_fresh    — within ±300s of server time
 *   6. not_duplicate      — instruction hash not in dedup cache
 *   7. signature_valid    — Ed25519 signature verifies
 *
 * Does NOT call dedup.mark() — callers mark at their own appropriate time.
 * Returns instrHash so each caller can mark when ready.
 */

import { verifyEd25519Signature } from '../identity/auth.js';
import { sha256, canonicalJSON } from './crypto-utils.js';

/**
 * Hints shared across all signed-instruction endpoints.
 */
export const SHARED_VALIDATION_HINTS = {
  no_pubkey:
    'Register your Ed25519 public key via PUT /api/v1/agents/me with { "pubkey": "<64-char-hex>" }. ' +
    'See playbook Step 8.',

  agent_id_mismatch:
    'instruction.agent_id must exactly match your authenticated agent ID. ' +
    'GET /api/v1/agents/me to see your agent_id.',

  stale_timestamp: (serverTime, instrTime, drift) =>
    `Timestamp must be within 300 seconds of server time. ` +
    `Server: ${serverTime} (${new Date(serverTime * 1000).toISOString()}). ` +
    `Yours: ${instrTime} (${new Date(instrTime * 1000).toISOString()}). ` +
    `Drift: ${Math.abs(drift)}s. Use Math.floor(Date.now()/1000) at sign time.`,

  duplicate:
    'This exact instruction was already submitted. ' +
    'Change the timestamp to get a different hash.',

  invalid_signature:
    'Sign the canonical JSON of the instruction object (not the wrapper). ' +
    'sign(canonicalJSON(instruction)). Canonical JSON sorts keys lexicographically, no whitespace (RFC 8785).',
};

/**
 * Validate steps 1–7 of a signed instruction.
 *
 * @param {object} opts
 * @param {string} opts.agentId — authenticated agent ID
 * @param {object} opts.payload — { instruction, signature }
 * @param {string} opts.expectedAction — 'channel_open' | 'channel_close'
 * @param {{ getById: (id: string) => object|null }} opts.agentRegistry
 * @param {{ has: (hash: string) => boolean }} opts.dedup
 * @param {{ missing_payload: string, wrong_action: string }} opts.actionHints
 * @returns {Promise<object>} success/failure result with checks_passed and instrHash
 */
export async function validateSignedInstruction({
  agentId, payload, expectedAction, agentRegistry, dedup, actionHints,
}) {
  const checks_passed = [];
  const { instruction, signature } = payload || {};

  // Step 1: payload_present
  if (!instruction || !signature) {
    return {
      success: false, error: 'Missing instruction or signature',
      hint: actionHints.missing_payload, status: 400,
      failed_at: 'payload_present', checks_passed,
    };
  }
  checks_passed.push('payload_present');

  // Step 2: pubkey_registered
  const profile = agentRegistry.getById(agentId);
  if (!profile?.pubkey) {
    return {
      success: false, error: 'Agent has no registered Ed25519 public key',
      hint: SHARED_VALIDATION_HINTS.no_pubkey, status: 400,
      failed_at: 'pubkey_registered', checks_passed,
    };
  }
  checks_passed.push('pubkey_registered');

  // Step 3: action_valid
  if (instruction.action !== expectedAction) {
    return {
      success: false, error: `Invalid action: "${instruction.action}". Only "${expectedAction}" accepted.`,
      hint: actionHints.wrong_action, status: 400,
      failed_at: 'action_valid', checks_passed,
    };
  }
  checks_passed.push('action_valid');

  // Step 4: agent_id_matches
  if (instruction.agent_id !== agentId) {
    return {
      success: false, error: 'instruction.agent_id does not match authenticated agent',
      hint: SHARED_VALIDATION_HINTS.agent_id_mismatch, status: 400,
      failed_at: 'agent_id_matches', checks_passed,
    };
  }
  checks_passed.push('agent_id_matches');

  // Step 5: timestamp_fresh (epoch seconds, ±300s)
  if (typeof instruction.timestamp !== 'number' || !Number.isFinite(instruction.timestamp)) {
    return {
      success: false, error: 'timestamp must be a finite number (epoch seconds)',
      hint: SHARED_VALIDATION_HINTS.stale_timestamp(Math.floor(Date.now() / 1000), 0, Infinity),
      status: 400, failed_at: 'timestamp_fresh', checks_passed,
    };
  }
  const nowSec = Math.floor(Date.now() / 1000);
  const driftSec = Math.abs(nowSec - instruction.timestamp);
  if (driftSec > 300) {
    return {
      success: false, error: 'Timestamp too old or too far in future (must be within 300s of server time)',
      hint: SHARED_VALIDATION_HINTS.stale_timestamp(nowSec, instruction.timestamp, driftSec),
      status: 400, failed_at: 'timestamp_fresh', checks_passed,
    };
  }
  checks_passed.push('timestamp_fresh');

  // Step 6: not_duplicate
  const instrHash = sha256(canonicalJSON(instruction));
  if (dedup.has(instrHash)) {
    return {
      success: false, error: 'Duplicate instruction (already submitted)',
      hint: SHARED_VALIDATION_HINTS.duplicate, status: 409,
      failed_at: 'not_duplicate', checks_passed,
    };
  }
  checks_passed.push('not_duplicate');

  // Step 7: signature_valid
  const message = canonicalJSON(instruction);
  const valid = await verifyEd25519Signature(profile.pubkey, message, signature);
  if (!valid) {
    return {
      success: false, error: 'Invalid Ed25519 signature',
      hint: SHARED_VALIDATION_HINTS.invalid_signature, status: 401,
      failed_at: 'signature_valid', checks_passed,
    };
  }
  checks_passed.push('signature_valid');

  const params = instruction.params || {};

  return {
    success: true,
    checks_passed,
    instrHash,
    profile,
    params,
  };
}
