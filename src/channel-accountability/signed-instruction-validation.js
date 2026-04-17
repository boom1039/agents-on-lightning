/**
 * Shared signed-instruction validation pipeline (steps 1–7).
 *
 * Both ChannelOpener and ChannelCloser run identical checks for:
 *   1. payload_present   — instruction + signature exist
 *   2. pubkey_registered  — agent has a secp256k1 public key
 *   3. action_valid       — instruction.action matches expected
 *   4. agent_id_matches   — instruction.agent_id == authenticated agent
 *   5. timestamp_fresh    — within ±1200s of server time
 *   6. not_duplicate      — instruction hash not in dedup cache
 *   7. signature_valid    — secp256k1 signature verifies
 *
 * Does NOT call dedup.mark() — callers mark at their own appropriate time.
 * Returns instrHash so each caller can mark when ready.
 */

import { verifySecp256k1Signature } from '../identity/auth.js';
import { sha256, canonicalJSON } from './crypto-utils.js';
import {
  attachSignedValidationFingerprint,
  buildSignedValidationFingerprint,
  classifyInvalidSignature,
} from './signed-validation-fingerprint.js';

export const SIGNED_INSTRUCTION_FRESHNESS_SECONDS = 1200;
export const SIGNED_INSTRUCTION_DEDUP_MS = (SIGNED_INSTRUCTION_FRESHNESS_SECONDS + 60) * 1000;

/**
 * Hints shared across all signed-instruction endpoints.
 */
export const SHARED_VALIDATION_HINTS = {
  no_pubkey:
    'Register with a secp256k1 compressed public key through aol_build_registration_payload and aol_register_agent, or rotate keys with aol_build_key_rotation_payload and aol_rotate_agent_key. ' +
    'See /llms.txt signed channel work and /docs/mcp/reference.txt.',

  agent_id_mismatch:
    'instruction.agent_id must exactly match your authenticated agent ID. ' +
    'Use aol_get_me to see your agent_id.',

  stale_timestamp: (serverTime, instrTime, drift) =>
    `Timestamp must be within ${SIGNED_INSTRUCTION_FRESHNESS_SECONDS} seconds (20 minutes) of server time. ` +
    `Server: ${serverTime} (${new Date(serverTime * 1000).toISOString()}). ` +
    `Yours: ${instrTime} (${new Date(instrTime * 1000).toISOString()}). ` +
    `Drift: ${Math.abs(drift)}s. Use Math.floor(Date.now()/1000) at sign time.`,

  duplicate:
    'This exact instruction was already submitted. ' +
    'Change the timestamp to get a different hash.',

  invalid_signature:
    'Sign SHA256(canonicalJSON(instruction)) with your secp256k1 private key, then send the DER-encoded low-S signature as hex. ' +
    'If you are using the public docs, create agent-signing.mjs once, write instruction.json, then run node agent-signing.mjs sign instruction.json. ' +
    'Canonical JSON sorts keys lexicographically with no whitespace (RFC 8785).',
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
 * @param {(fingerprint: object) => Promise<void>|void} [opts.onFailureFingerprint]
 * @returns {Promise<object>} success/failure result with checks_passed and instrHash
 */
export async function validateSignedInstruction({
  agentId, payload, expectedAction, agentRegistry, dedup, actionHints, onFailureFingerprint = null,
}) {
  const checks_passed = [];
  const { instruction, signature } = payload || {};

  async function fail({
    error,
    hint,
    status,
    failedAt,
    profile = null,
    classification = failedAt,
  }) {
    const fingerprint = buildSignedValidationFingerprint({
      payload,
      profile,
      failedAt,
      expectedAction,
      agentId,
      classification,
    });
    if (typeof onFailureFingerprint === 'function') {
      await onFailureFingerprint(fingerprint);
    }

    return attachSignedValidationFingerprint({
      success: false,
      error,
      hint,
      status,
      failed_at: failedAt,
      checks_passed,
    }, fingerprint);
  }

  // Step 1: payload_present
  if (!instruction || !signature) {
    return await fail({
      error: 'Missing instruction or signature',
      hint: actionHints.missing_payload,
      status: 400,
      failedAt: 'payload_present',
    });
  }
  checks_passed.push('payload_present');

  // Step 2: pubkey_registered
  const profile = agentRegistry.getById(agentId);
  if (!profile?.pubkey) {
    return await fail({
      error: 'Agent has no registered secp256k1 public key',
      hint: SHARED_VALIDATION_HINTS.no_pubkey,
      status: 400,
      failedAt: 'pubkey_registered',
      profile,
    });
  }
  checks_passed.push('pubkey_registered');

  // Step 3: action_valid
  if (instruction.action !== expectedAction) {
    return await fail({
      error: `Invalid action: "${instruction.action}". Only "${expectedAction}" accepted.`,
      hint: actionHints.wrong_action,
      status: 400,
      failedAt: 'action_valid',
      profile,
    });
  }
  checks_passed.push('action_valid');

  // Step 4: agent_id_matches
  if (instruction.agent_id !== agentId) {
    return await fail({
      error: 'instruction.agent_id does not match authenticated agent',
      hint: SHARED_VALIDATION_HINTS.agent_id_mismatch,
      status: 400,
      failedAt: 'agent_id_matches',
      profile,
    });
  }
  checks_passed.push('agent_id_matches');

  // Step 5: timestamp_fresh (epoch seconds, ±1200s)
  if (typeof instruction.timestamp !== 'number' || !Number.isFinite(instruction.timestamp)) {
    return await fail({
      error: 'timestamp must be a finite number (epoch seconds)',
      hint: SHARED_VALIDATION_HINTS.stale_timestamp(Math.floor(Date.now() / 1000), 0, Infinity),
      status: 400,
      failedAt: 'timestamp_fresh',
      profile,
    });
  }
  const nowSec = Math.floor(Date.now() / 1000);
  const driftSec = Math.abs(nowSec - instruction.timestamp);
  if (driftSec > SIGNED_INSTRUCTION_FRESHNESS_SECONDS) {
    return await fail({
      error: `Timestamp too old or too far in future (must be within ${SIGNED_INSTRUCTION_FRESHNESS_SECONDS}s of server time)`,
      hint: SHARED_VALIDATION_HINTS.stale_timestamp(nowSec, instruction.timestamp, driftSec),
      status: 400,
      failedAt: 'timestamp_fresh',
      profile,
    });
  }
  checks_passed.push('timestamp_fresh');

  // Step 6: not_duplicate
  const instrHash = sha256(canonicalJSON(instruction));
  if (await dedup.has(instrHash)) {
    return await fail({
      error: 'Duplicate instruction (already submitted)',
      hint: SHARED_VALIDATION_HINTS.duplicate,
      status: 409,
      failedAt: 'not_duplicate',
      profile,
    });
  }
  checks_passed.push('not_duplicate');

  // Step 7: signature_valid
  const message = canonicalJSON(instruction);
  const valid = await verifySecp256k1Signature(profile.pubkey, message, signature);
  if (!valid) {
    const signatureFailure = await classifyInvalidSignature({ payload, profile });
    return await fail({
      error: 'Invalid secp256k1 signature',
      hint: signatureFailure.hint
        ? `${signatureFailure.hint} Use /llms.txt and the returned build-instruction tool output as the stable signing boundary.`
        : SHARED_VALIDATION_HINTS.invalid_signature,
      status: 401,
      failedAt: 'signature_valid',
      profile,
      classification: signatureFailure.code,
    });
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
