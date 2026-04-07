import { verifySecp256k1Signature } from '../identity/auth.js';
import { sha256, canonicalJSON } from './crypto-utils.js';
import { DedupCache } from './dedup-cache.js';
import { acquire } from '../identity/mutex.js';
import {
  attachSignedValidationFingerprint,
  appendSignedValidationFailure,
  buildSignedValidationFingerprint,
  classifyInvalidSignature,
} from './signed-validation-fingerprint.js';

const INSTRUCTIONS_PATH = 'data/channel-accountability/instructions.jsonl';
const ALLOWED_ACTIONS = new Set(['set_fee_policy', 'update_htlc_limits']);
const TIMESTAMP_TOLERANCE_S = 300; // 5 minutes
const DEDUP_EXPIRY_MS = 600_000; // 10 minutes
const POST_VERIFY_DELAY_MS = 3_000;
const RECENT_EXECUTION_TTL_MS = 120_000; // 2 minutes — monitor match window
const GLOBAL_SAFE_CONSTRAINTS = {
  min_base_fee_msat: 0,
  max_base_fee_msat: 10_000,
  min_fee_rate_ppm: 0,
  max_fee_rate_ppm: 2_000,
};

/**
 * Educational hints keyed by validation step name.
 * Every error response includes an actionable hint so agents can self-correct
 * without external help. This is critical because agents cannot ask for help.
 */
const HINTS = {
  missing_payload:
    'The request body must be JSON with two fields: { "instruction": {...}, "signature": "hex" }. ' +
    'The instruction object contains the action you want to perform. The signature is the secp256k1 ' +
    'signature of the canonical JSON of the instruction object. See playbook Step 11.',

  no_pubkey:
    'Register your secp256k1 compressed public key via PUT /api/v1/agents/me with { "pubkey": "<66-char-hex>" }. ' +
    'Generate a secp256k1 keypair, save the private key securely, and register the compressed public key ' +
    'as a hex string. See playbook Step 8 and Step 11.',

  unknown_action: (action) =>
    `Allowed actions: ${[...ALLOWED_ACTIONS].join(', ')}. ` +
    `You sent: "${action}". ` +
    'set_fee_policy changes base_fee_msat and fee_rate_ppm. ' +
    'update_htlc_limits changes min_htlc_msat and max_htlc_msat. See playbook Step 11.',

  agent_id_mismatch:
    'The instruction.agent_id field must exactly match your authenticated agent ID. ' +
    'This prevents one agent from submitting instructions that impersonate another. ' +
    'GET /api/v1/agents/me to see your agent_id.',

  stale_timestamp: (serverTime, instrTime, drift) =>
    `Timestamp must be within 300 seconds (5 minutes) of server time. ` +
    `Server time: ${serverTime} (${new Date(serverTime * 1000).toISOString()}). ` +
    `Your timestamp: ${instrTime} (${new Date(instrTime * 1000).toISOString()}). ` +
    `Difference: ${drift}s. ` +
    'Use Math.floor(Date.now() / 1000) at the moment you build the instruction.',

  duplicate:
    'This exact instruction (same payload hash) was already processed recently. ' +
    'If you need to repeat an action, change the timestamp to get a different payload hash.',

  channel_not_assigned:
    'This channel is not assigned to any agent. The node operator must assign it first.',

  channel_wrong_agent:
    'This channel is assigned to a different agent. ' +
    'GET /api/v1/channels/mine to see your assigned channels and their channel_id values.',

  invalid_signature:
    'Sign SHA256(canonicalJSON(instruction)) with your secp256k1 private key and send the DER-encoded signature as hex. ' +
    'If you are using the public docs, create agent-signing.mjs once, write instruction.json, then run node agent-signing.mjs sign instruction.json. ' +
    'Wrong: sign the wrapper, sign pretty JSON, or send a non-DER signature. ' +
    'Canonical JSON sorts keys lexicographically at every nesting level with no whitespace (RFC 8785). ' +
    'See playbook Step 11 for a complete signing example with test vector.',

  constraint_violation: (field, value, min, max) => {
    const parts = [`Your channel constraints for ${field}: `];
    if (min !== undefined) parts.push(`min=${min}`);
    if (min !== undefined && max !== undefined) parts.push(', ');
    if (max !== undefined) parts.push(`max=${max}`);
    parts.push(`. Requested: ${value}. `);
    parts.push('GET /api/v1/channels/mine shows current constraints for each assigned channel.');
    return parts.join('');
  },

  cooldown:
    'This channel changed recently, so another update is blocked for now. ' +
    'Cooldowns prevent fee thrashing that confuses routing nodes caching your policies.',

  lnd_unavailable:
    'The LND node is temporarily unreachable. This is usually a transient condition. ' +
    'Wait a bit and retry. If persistent, the node operator may be performing maintenance. ' +
    'GET /api/v1/channels/status shows current LND connectivity.',

  lnd_execution_failed: (errMsg) =>
    `The instruction passed all validation but LND rejected the change: ${errMsg}. ` +
    'Common causes: channel was closed between validation and execution, or the remote peer ' +
    'disconnected. Check GET /api/v1/channels/mine to verify channel is still active.',
};

/**
 * Validates, executes, and audit-logs secp256k1-signed fee instructions.
 * 10-step validation pipeline before touching LND.
 */
export class SignedInstructionExecutor {
  constructor({ assignmentRegistry, auditLog, nodeManager, agentRegistry, dataLayer, safetySettings = {} }) {
    this._assignments = assignmentRegistry;
    this._auditLog = auditLog;
    this._nodeManager = nodeManager;
    this._agentRegistry = agentRegistry;
    this._dataLayer = dataLayer;
    this._defaultCooldownMinutes = Number.isInteger(safetySettings.defaultCooldownMinutes)
      ? safetySettings.defaultCooldownMinutes
      : 60;

    // Dedup cache (10-minute expiry window)
    this._dedup = new DedupCache(DEDUP_EXPIRY_MS, {
      dataLayer,
      path: 'data/channel-accountability/instruction-dedup.json',
    });
    // Cooldown: chanId -> last execution timestamp
    this._cooldowns = new Map();
    // Recent executions: chanId -> { instruction, executedAt }
    this._recentExecutions = new Map();
  }

  /**
   * Reconstruct cooldown state from audit chain on startup.
   * Finds the most recent instruction_executed for each assigned channel.
   */
  async loadCooldowns() {
    const chain = await this._auditLog.readAll({ limit: 1000 });
    for (const entry of chain) {
      if (entry.type === 'instruction_executed' && entry.chan_id) {
        const existing = this._cooldowns.get(entry.chan_id);
        if (!existing || entry._ts > existing) {
          this._cooldowns.set(entry.chan_id, entry._ts);
        }
      }
    }
    console.log(`[InstructionExecutor] Restored cooldowns for ${this._cooldowns.size} channels`);
  }

  /**
   * Run the full 10-step validation pipeline. Steps 1-9 are pure validation.
   * Step 10 checks LND reachability.
   *
   * @param {string} agentId
   * @param {object} payload - { instruction, signature }
   * @returns {object} Validation result with checks_passed array
   */
  async _validate(agentId, payload) {
    const checks_passed = [];
    const { instruction, signature } = payload || {};
    let profile = null;

    const fail = async ({
      error,
      hint,
      status,
      failedAt,
      classification = failedAt,
    }) => {
      const fingerprint = buildSignedValidationFingerprint({
        payload,
        profile,
        failedAt,
        expectedAction: typeof instruction?.action === 'string' ? instruction.action : null,
        agentId,
        classification,
      });
      await appendSignedValidationFailure({
        dataLayer: this._dataLayer,
        routeFamily: 'channels_signed',
        operation: 'validate',
        agentId,
        expectedAction: typeof instruction?.action === 'string' ? instruction.action : null,
        fingerprint,
      });
      return attachSignedValidationFingerprint({
        success: false,
        error,
        hint,
        status,
        failed_at: failedAt,
        checks_passed,
      }, fingerprint);
    };

    if (!instruction || !signature) {
      return await fail({
        error: 'Missing instruction or signature',
        hint: HINTS.missing_payload,
        status: 400,
        failedAt: 'payload_present',
      });
    }

    // Step 1: Agent has pubkey
    profile = this._agentRegistry.getById(agentId);
    if (!profile?.pubkey) {
      return await fail({
        error: 'Agent has no registered secp256k1 public key',
        hint: HINTS.no_pubkey,
        status: 400,
        failedAt: 'pubkey_registered',
      });
    }
    checks_passed.push('pubkey_registered');

    // Step 2: Action valid
    if (!ALLOWED_ACTIONS.has(instruction.action)) {
      return await fail({
        error: `Unknown action: ${instruction.action}. Allowed: ${[...ALLOWED_ACTIONS].join(', ')}`,
        hint: HINTS.unknown_action(instruction.action),
        status: 400,
        failedAt: 'action_valid',
      });
    }
    checks_passed.push('action_valid');

    // Step 3: agent_id match
    if (instruction.agent_id !== agentId) {
      return await fail({
        error: 'instruction.agent_id does not match authenticated agent',
        hint: HINTS.agent_id_mismatch,
        status: 400,
        failedAt: 'agent_id_matches',
      });
    }
    checks_passed.push('agent_id_matches');

    // Step 4: Timestamp freshness — type-check first to prevent NaN bypass
    if (typeof instruction.timestamp !== 'number' || !Number.isFinite(instruction.timestamp)) {
      return await fail({
        error: 'timestamp must be a finite number (epoch seconds)',
        hint: HINTS.stale_timestamp(Math.floor(Date.now() / 1000), 0, Infinity),
        status: 400,
        failedAt: 'timestamp_fresh',
      });
    }
    const nowSec = Math.floor(Date.now() / 1000);
    const drift = Math.abs(nowSec - instruction.timestamp);
    if (drift > TIMESTAMP_TOLERANCE_S) {
      return await fail({
        error: 'Stale or missing timestamp (must be within 5 minutes of server time)',
        hint: HINTS.stale_timestamp(nowSec, instruction.timestamp, drift),
        status: 400,
        failedAt: 'timestamp_fresh',
      });
    }
    checks_passed.push('timestamp_fresh');

    // Step 5: Dedup
    const payloadHash = sha256(canonicalJSON(payload.instruction));
    if (await this._dedup.has(payloadHash)) {
      return await fail({
        error: 'Duplicate instruction (already processed)',
        hint: HINTS.duplicate,
        status: 409,
        failedAt: 'not_duplicate',
      });
    }
    checks_passed.push('not_duplicate');

    // Step 6: Signature valid
    const message = canonicalJSON(instruction);
    const valid = await verifySecp256k1Signature(profile.pubkey, message, signature);
    if (!valid) {
      const signatureFailure = await classifyInvalidSignature({ payload, profile });
      return await fail({
        error: 'Invalid secp256k1 signature',
        hint: signatureFailure.hint
          ? `${signatureFailure.hint} Use GET /docs/skills/signing-secp256k1.txt if you need the stable helper-file flow.`
          : HINTS.invalid_signature,
        status: 401,
        failedAt: 'signature_valid',
        classification: signatureFailure.code,
      });
    }
    checks_passed.push('signature_valid');

    // Step 7: Channel assigned to this agent
    const assignment = this._assignments.getAssignment(instruction.channel_id);
    if (!assignment) {
      return {
        success: false,
        error: 'Channel not assigned',
        hint: HINTS.channel_not_assigned,
        status: 403,
        failed_at: 'channel_owned',
        checks_passed,
      };
    }
    if (assignment.agent_id !== agentId) {
      return {
        success: false,
        error: 'Channel not assigned to you',
        hint: HINTS.channel_wrong_agent,
        status: 403,
        failed_at: 'channel_owned',
        checks_passed,
      };
    }
    checks_passed.push('channel_owned');

    // Step 8: Fee constraints
    const constraintError = this._checkConstraints(instruction, assignment.constraints);
    if (constraintError) {
      return {
        success: false,
        error: constraintError.message,
        hint: constraintError.hint,
        status: 400,
        failed_at: 'constraints_met',
        checks_passed,
      };
    }
    checks_passed.push('constraints_met');

    // Step 9: Cooldown
    const cooldownMinutes = assignment.constraints?.cooldown_minutes ?? this._defaultCooldownMinutes;
    const cooldownMs = cooldownMinutes * 60_000;
    const lastExec = this._cooldowns.get(instruction.channel_id);
    if (lastExec) {
      const nowMs = Date.now();
      const elapsed = nowMs - lastExec;
      if (elapsed < cooldownMs) {
        return {
          success: false,
          error: 'Cooldown active',
          hint: HINTS.cooldown,
          status: 429,
          failed_at: 'cooldown_clear',
          checks_passed,
        };
      }
    }
    checks_passed.push('cooldown_clear');

    return {
      success: true,
      checks_passed,
      assignment,
      payloadHash,
      cooldownMs,
    };
  }

  /**
   * Preview (dry-run) a signed instruction through all validation steps.
   * Read-only: does NOT mutate dedup hashes, cooldowns, audit log, or LND state.
   *
   * @param {string} agentId - From auth middleware
   * @param {object} payload - { instruction, signature }
   * @returns {object} Preview result
   */
  async preview(agentId, payload) {
    const result = await this._validate(agentId, payload);

    if (!result.success) {
      return {
        success: false,
        valid: false,
        status: result.status,
        failed_at: result.failed_at,
        checks_passed: result.checks_passed,
        error: result.error,
        hint: result.hint,
      };
    }

    const { instruction } = payload;
    const { assignment, checks_passed } = result;

    // Fetch current policy for context
    let current_policy = null;
    const node = this._nodeManager.getScopedDefaultNodeOrNull('policy');
    if (node) {
      try {
        const report = await node.feeReport();
        const ch = report.channel_fees?.find(f => f.channel_point === assignment.channel_point);
        if (ch) {
          current_policy = {
            base_fee_msat: parseInt(ch.base_fee_msat, 10),
            fee_rate_ppm: parseInt(ch.fee_per_mil, 10),
          };
        }
      } catch { /* non-fatal for preview */ }
    }

    return {
      success: true,
      valid: true,
      checks_passed,
      would_execute: {
        action: instruction.action,
        channel_id: instruction.channel_id,
        channel_point: assignment.channel_point,
        params: instruction.params,
      },
      current_policy,
      learn: 'Preview ran all 9 validation checks without executing. ' +
        'Submit the identical payload to POST /api/v1/channels/instruct to execute for real. ' +
        'The instruction will be audit-logged in a tamper-evident SHA-256 hash chain.',
    };
  }

  /**
   * Execute a signed instruction from an authenticated agent.
   * Acquires a per-channel mutex so concurrent instructions on the same channel
   * are serialized, while instructions on different channels run in parallel.
   *
   * @param {string} agentId - From auth middleware (req.agentId)
   * @param {object} payload - { instruction: {...}, signature: "hex" }
   * @returns {{ success: boolean, result?: object, error?: string, hint?: string, status?: number }}
   */
  async execute(agentId, payload) {
    // Validate first (steps 1-9) — no mutex needed for validation
    const validation = await this._validate(agentId, payload);
    if (!validation.success) {
      return validation;
    }

    const { instruction } = payload;
    const { assignment, payloadHash, cooldownMs, checks_passed } = validation;

    // Acquire per-channel mutex for the execution phase
    // Two agents managing different channels proceed in parallel.
    // Two instructions on the same channel are serialized.
    const unlock = await acquire(`channel:${instruction.channel_id}`);
    try {
      // Re-check cooldown and dedup under lock (TOCTOU protection)
      const now = Date.now();
      if (await this._dedup.has(payloadHash)) {
        return {
          success: false,
          error: 'Duplicate instruction (already processed)',
          hint: HINTS.duplicate,
          status: 409,
          failed_at: 'not_duplicate',
          checks_passed: [],
        };
      }

      const cooldownMinutes = assignment.constraints?.cooldown_minutes ?? this._defaultCooldownMinutes;
      const cooldownMsRecheck = cooldownMinutes * 60_000;
      const lastExec = this._cooldowns.get(instruction.channel_id);
      if (lastExec) {
        const elapsed = now - lastExec;
        if (elapsed < cooldownMsRecheck) {
          return {
            success: false,
            error: 'Cooldown active',
            hint: HINTS.cooldown,
            status: 429,
            failed_at: 'cooldown_clear',
            checks_passed: [],
          };
        }
      }

      // Step 10: LND reachable
      const node = this._nodeManager.getScopedDefaultNodeOrNull('policy');
      if (!node) {
        return {
          success: false,
          error: 'LND node not available',
          hint: HINTS.lnd_unavailable,
          status: 503,
          failed_at: 'lnd_reachable',
          checks_passed,
        };
      }

      // Log the instruction receipt
      await this._auditLog.append({
        type: 'instruction_received',
        chan_id: instruction.channel_id,
        channel_point: assignment.channel_point,
        agent_id: agentId,
        action: instruction.action,
        params: instruction.params,
        signature_hash: payloadHash,
      });

      // Mark as seen (dedup)
      await this._dedup.mark(payloadHash);

      // Log to instructions.jsonl for querying
      await this._dataLayer.appendLog(INSTRUCTIONS_PATH, {
        agent_id: agentId,
        instruction,
        signature_hash: payloadHash,
      });

      // Execute on LND
      try {
        await this._executeLnd(node, instruction, assignment);
      } catch (err) {
        await this._auditLog.append({
          type: 'instruction_failed',
          chan_id: instruction.channel_id,
          channel_point: assignment.channel_point,
          agent_id: agentId,
          error: err.message,
        });
        return {
          success: false,
          error: `LND execution failed: ${err.message}`,
          hint: HINTS.lnd_execution_failed(err.message),
          status: 502,
          failed_at: 'lnd_execution',
          checks_passed,
        };
      }

      // Record execution
      const execNow = Date.now();
      this._cooldowns.set(instruction.channel_id, execNow);
      this._recentExecutions.set(instruction.channel_id, {
        instruction,
        executedAt: execNow,
      });

      // Clean up old recent executions
      setTimeout(() => {
        const entry = this._recentExecutions.get(instruction.channel_id);
        if (entry && entry.executedAt === execNow) {
          this._recentExecutions.delete(instruction.channel_id);
        }
      }, RECENT_EXECUTION_TTL_MS);

      await this._auditLog.append({
        type: 'instruction_executed',
        chan_id: instruction.channel_id,
        channel_point: assignment.channel_point,
        agent_id: agentId,
        action: instruction.action,
        params: instruction.params,
      });

      // Post-verification (async, doesn't block response)
      this._postVerify(node, instruction, assignment).catch(err => {
        console.warn(`[InstructionExecutor] Post-verify failed: ${err.message}`);
      });

      return {
        success: true,
        result: {
          channel_id: instruction.channel_id,
          channel_point: assignment.channel_point,
          action: instruction.action,
          params: instruction.params,
          executed_at: execNow,
          next_allowed_at: execNow + cooldownMs,
        },
        learn: 'Your fee policy change has been applied to LND and recorded in the tamper-evident ' +
          'audit chain. The monitor will verify the change took effect within ~30 seconds. ' +
          'GET /api/v1/channels/audit/' + instruction.channel_id + ' to see the full history.',
      };
    } finally {
      unlock();
    }
  }

  async _executeLnd(node, instruction, assignment) {
    const { action, params } = instruction;
    const channelPoint = assignment.channel_point;

    if (action === 'set_fee_policy') {
      const baseFeeMsat = params.base_fee_msat;
      const feeRatePpm = params.fee_rate_ppm;
      // If time_lock_delta not provided, read current and preserve
      let timeLockDelta = params.time_lock_delta;
      if (timeLockDelta === undefined || timeLockDelta === null) {
        const report = await node.feeReport();
        const current = report.channel_fees?.find(f => f.channel_point === channelPoint);
        timeLockDelta = current?.time_lock_delta || 40;
      }
      await node.updateChannelPolicy(channelPoint, baseFeeMsat, feeRatePpm, timeLockDelta);
    } else if (action === 'update_htlc_limits') {
      // Read current fee state — preserve fees, only change HTLC limits
      const report = await node.feeReport();
      const current = report.channel_fees?.find(f => f.channel_point === channelPoint);
      if (!current) throw new Error('Channel not found in feeReport');

      const baseFeeMsat = parseInt(current.base_fee_msat, 10);
      const feeRatePpm = parseInt(current.fee_per_mil, 10);
      const timeLockDelta = current.time_lock_delta || 40;

      // Validate max_htlc_msat against channel capacity
      if (params.max_htlc_msat !== undefined && assignment.capacity) {
        const capacityMsat = BigInt(assignment.capacity) * 1000n;
        if (BigInt(params.max_htlc_msat) > capacityMsat) {
          throw new Error(`max_htlc_msat (${params.max_htlc_msat}) exceeds channel capacity (${capacityMsat} msat)`);
        }
      }

      await node.updateChannelPolicy(
        channelPoint, baseFeeMsat, feeRatePpm, timeLockDelta,
        params.max_htlc_msat, params.min_htlc_msat,
      );
    }
  }

  async _postVerify(node, instruction, assignment) {
    await new Promise(r => setTimeout(r, POST_VERIFY_DELAY_MS));

    const report = await node.feeReport();
    const actual = report.channel_fees?.find(f => f.channel_point === assignment.channel_point);
    if (!actual) {
      await this._auditLog.append({
        type: 'execution_verified',
        chan_id: instruction.channel_id,
        channel_point: assignment.channel_point,
        agent_id: instruction.agent_id,
        verified: false,
        reason: 'channel not found in feeReport',
      });
      return;
    }

    let verified = true;
    const mismatches = [];

    if (instruction.action === 'set_fee_policy') {
      const p = instruction.params;
      if (p.base_fee_msat !== undefined && parseInt(actual.base_fee_msat, 10) !== p.base_fee_msat) {
        verified = false;
        mismatches.push({ field: 'base_fee_msat', expected: p.base_fee_msat, actual: actual.base_fee_msat });
      }
      if (p.fee_rate_ppm !== undefined && parseInt(actual.fee_per_mil, 10) !== p.fee_rate_ppm) {
        verified = false;
        mismatches.push({ field: 'fee_rate_ppm', expected: p.fee_rate_ppm, actual: actual.fee_per_mil });
      }
    } else if (instruction.action === 'update_htlc_limits') {
      const p = instruction.params;
      if (p.min_htlc_msat !== undefined && actual.min_htlc_msat !== undefined &&
          parseInt(actual.min_htlc_msat, 10) !== p.min_htlc_msat) {
        verified = false;
        mismatches.push({ field: 'min_htlc_msat', expected: p.min_htlc_msat, actual: actual.min_htlc_msat });
      }
      if (p.max_htlc_msat !== undefined && actual.max_htlc_msat !== undefined &&
          parseInt(actual.max_htlc_msat, 10) !== p.max_htlc_msat) {
        verified = false;
        mismatches.push({ field: 'max_htlc_msat', expected: p.max_htlc_msat, actual: actual.max_htlc_msat });
      }
    }

    await this._auditLog.append({
      type: 'execution_verified',
      chan_id: instruction.channel_id,
      channel_point: assignment.channel_point,
      agent_id: instruction.agent_id,
      verified,
      mismatches: mismatches.length > 0 ? mismatches : undefined,
    });
  }

  /**
   * Check fee constraints. Returns null if OK, or { message, hint } on violation.
   */
  _checkConstraints(instruction, constraints) {
    const merged = { ...GLOBAL_SAFE_CONSTRAINTS, ...(constraints || {}) };
    const p = instruction.params || {};

    if (p.base_fee_msat !== undefined) {
      if (merged.min_base_fee_msat !== undefined && p.base_fee_msat < merged.min_base_fee_msat) {
        return {
          message: `base_fee_msat ${p.base_fee_msat} below minimum ${merged.min_base_fee_msat}`,
          hint: HINTS.constraint_violation('base_fee_msat', p.base_fee_msat, merged.min_base_fee_msat, merged.max_base_fee_msat),
        };
      }
      if (merged.max_base_fee_msat !== undefined && p.base_fee_msat > merged.max_base_fee_msat) {
        return {
          message: `base_fee_msat ${p.base_fee_msat} exceeds maximum ${merged.max_base_fee_msat}`,
          hint: HINTS.constraint_violation('base_fee_msat', p.base_fee_msat, merged.min_base_fee_msat, merged.max_base_fee_msat),
        };
      }
    }
    if (p.fee_rate_ppm !== undefined) {
      if (merged.min_fee_rate_ppm !== undefined && p.fee_rate_ppm < merged.min_fee_rate_ppm) {
        return {
          message: `fee_rate_ppm ${p.fee_rate_ppm} below minimum ${merged.min_fee_rate_ppm}`,
          hint: HINTS.constraint_violation('fee_rate_ppm', p.fee_rate_ppm, merged.min_fee_rate_ppm, merged.max_fee_rate_ppm),
        };
      }
      if (merged.max_fee_rate_ppm !== undefined && p.fee_rate_ppm > merged.max_fee_rate_ppm) {
        return {
          message: `fee_rate_ppm ${p.fee_rate_ppm} exceeds maximum ${merged.max_fee_rate_ppm}`,
          hint: HINTS.constraint_violation('fee_rate_ppm', p.fee_rate_ppm, merged.min_fee_rate_ppm, merged.max_fee_rate_ppm),
        };
      }
    }
    if (instruction.action === 'update_htlc_limits') {
      if (p.min_htlc_msat !== undefined && (!Number.isInteger(p.min_htlc_msat) || p.min_htlc_msat < 0)) {
        return {
          message: 'min_htlc_msat must be a non-negative integer',
          hint: 'Use whole millisatoshis for min_htlc_msat.',
        };
      }
      if (p.max_htlc_msat !== undefined && (!Number.isInteger(p.max_htlc_msat) || p.max_htlc_msat <= 0)) {
        return {
          message: 'max_htlc_msat must be a positive integer',
          hint: 'Use whole millisatoshis for max_htlc_msat.',
        };
      }
      if (Number.isInteger(p.min_htlc_msat) && Number.isInteger(p.max_htlc_msat) && p.min_htlc_msat > p.max_htlc_msat) {
        return {
          message: 'min_htlc_msat cannot exceed max_htlc_msat',
          hint: 'Keep min_htlc_msat less than or equal to max_htlc_msat.',
        };
      }
    }
    return null;
  }

  getRecentExecutions() {
    return this._recentExecutions;
  }

  async resetForTests() {
    this._cooldowns.clear();
    this._recentExecutions.clear();
    await this._dedup.resetForTests();
    return { reset: true };
  }

  async getInstructions(agentId, limit = 100) {
    const all = await this._dataLayer.readLog(INSTRUCTIONS_PATH);
    const filtered = agentId ? all.filter(e => e.agent_id === agentId) : all;
    return filtered.slice(-Math.min(limit, 1000));
  }
}
