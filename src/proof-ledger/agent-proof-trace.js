import { createHash } from 'node:crypto';

function sha256Hex(value) {
  return createHash('sha256').update(String(value), 'utf8').digest('hex');
}

function array(value) {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value.filter((item) => item !== undefined && item !== null) : [value];
}

function unique(values) {
  return [...new Set(values.filter((value) => value !== undefined && value !== null && value !== ''))];
}

function sortedProofs(proofs) {
  return [...proofs].sort((a, b) => Number(a.global_sequence || 0) - Number(b.global_sequence || 0));
}

export function summarizeProofForAgent(proof, proofLedger = null) {
  if (!proof) return null;
  const verification = proofLedger?.verifyProof
    ? proofLedger.verifyProof(proof)
    : null;
  return {
    proof_id: proof.proof_id,
    proof_hash: proof.proof_hash,
    global_sequence: proof.global_sequence,
    agent_proof_sequence: proof.agent_proof_sequence,
    proof_record_type: proof.proof_record_type,
    money_event_type: proof.money_event_type,
    money_event_status: proof.money_event_status,
    event_source: proof.event_source,
    authorization_method: proof.authorization_method,
    primary_amount_sats: proof.primary_amount_sats,
    fee_sats: proof.fee_sats,
    wallet_ecash_delta_sats: proof.wallet_ecash_delta_sats,
    wallet_hub_delta_sats: proof.wallet_hub_delta_sats,
    capital_available_delta_sats: proof.capital_available_delta_sats,
    capital_locked_delta_sats: proof.capital_locked_delta_sats,
    capital_pending_deposit_delta_sats: proof.capital_pending_deposit_delta_sats,
    capital_pending_close_delta_sats: proof.capital_pending_close_delta_sats,
    capital_service_spent_delta_sats: proof.capital_service_spent_delta_sats,
    routing_pnl_delta_sats: proof.routing_pnl_delta_sats,
    public_safe_refs: proof.public_safe_refs || {},
    created_at_ms: proof.created_at_ms,
    signature_valid: verification ? verification.valid === true : undefined,
  };
}

export function proofTraceContext(scope = 'money_flow') {
  return {
    source_of_truth: 'proof_ledger',
    scope,
    promise: 'Every balance-changing money event is represented by signed, hash-linked Proof Ledger rows.',
    how_to_verify: 'Call aol_list_my_proofs, aol_get_proof, or aol_get_my_balance_proof to fetch full canonical proof rows and verify signatures, hashes, and agent-chain continuity.',
    boundary: 'Proof traces explain acknowledged money state. MCP telemetry explains behavior and tool usage.',
  };
}

function buildMatchers(match = {}) {
  const directRefKeys = [
    'agent_id',
    'amount_sats',
    'chan_id',
    'channel_id',
    'channel_point',
    'instruction_hash',
    'peer_pubkey',
    'provider',
    'service',
    'service_id',
    'status',
    'swap_id',
    'txid',
  ];
  const directRefs = new Map();
  for (const key of directRefKeys) {
    const values = unique(array(match[key]));
    if (values.length > 0) directRefs.set(key, new Set(values.map(String)));
  }

  const referenceHashes = unique([
    ...array(match.reference_hash),
    ...array(match.referenceHashes),
    ...array(match.reference_values).map(sha256Hex),
    ...array(match.referenceValues).map(sha256Hex),
  ]);
  const flowHashes = unique([
    ...array(match.flow_hash),
    ...array(match.flowHashes),
    ...array(match.flow_id).map(sha256Hex),
    ...array(match.flowIds).map(sha256Hex),
  ]);

  return {
    directRefs,
    referenceHashes: new Set(referenceHashes.map(String)),
    flowHashes: new Set(flowHashes.map(String)),
  };
}

function proofMatches(proof, {
  eventSources,
  eventTypes,
  proofRecordTypes,
  matchers,
  requireMatch,
}) {
  if (eventSources.length > 0 && !eventSources.includes(proof.event_source)) return false;
  if (eventTypes.length > 0 && !eventTypes.includes(proof.money_event_type)) return false;
  if (proofRecordTypes.length > 0 && !proofRecordTypes.includes(proof.proof_record_type)) return false;

  const refs = proof.public_safe_refs || {};
  const hasMatchers = matchers.directRefs.size > 0
    || matchers.referenceHashes.size > 0
    || matchers.flowHashes.size > 0;
  if (!hasMatchers) return !requireMatch;

  for (const [key, values] of matchers.directRefs.entries()) {
    if (refs[key] !== undefined && values.has(String(refs[key]))) return true;
  }
  if (refs.reference_hash && matchers.referenceHashes.has(String(refs.reference_hash))) return true;
  if (refs.flow_hash && matchers.flowHashes.has(String(refs.flow_hash))) return true;
  return false;
}

export function buildAgentProofTrace(proofLedger, agentId, {
  scope = 'money_flow',
  eventSources = [],
  eventTypes = [],
  proofRecordTypes = [],
  match = {},
  requireMatch = false,
  limit = 1000,
} = {}) {
  if (!proofLedger?.listProofs || !agentId) {
    return {
      source_of_truth: 'proof_ledger',
      available: false,
      scope,
      count: 0,
      proofs: [],
    };
  }

  const normalizedEventSources = unique(array(eventSources));
  const normalizedEventTypes = unique(array(eventTypes));
  const normalizedProofRecordTypes = unique(array(proofRecordTypes));
  const matchers = buildMatchers(match);
  const proofs = proofLedger
    .listProofs({ agentId, limit, offset: 0 })
    .filter((proof) => proofMatches(proof, {
      eventSources: normalizedEventSources,
      eventTypes: normalizedEventTypes,
      proofRecordTypes: normalizedProofRecordTypes,
      matchers,
      requireMatch,
    }));

  const ordered = sortedProofs(proofs).map((proof) => summarizeProofForAgent(proof, proofLedger));
  return {
    source_of_truth: 'proof_ledger',
    available: true,
    scope,
    count: ordered.length,
    proofs: ordered,
  };
}

export function withAgentProofTrace(body, proofLedger, agentId, options = {}) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return body;
  return {
    ...body,
    proof_context: proofTraceContext(options.scope),
    proof_chain: buildAgentProofTrace(proofLedger, agentId, options),
  };
}
