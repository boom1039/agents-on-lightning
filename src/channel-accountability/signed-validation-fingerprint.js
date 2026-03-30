import { verifySecp256k1Signature } from '../identity/auth.js';
import { canonicalJSON, sha256 } from './crypto-utils.js';

const HEX_RE = /^[0-9a-f]+$/i;
export const SIGNED_VALIDATION_FAILURES_PATH = 'data/channel-accountability/signed-validation-failures.jsonl';

function summarizeKeys(value, limit = 8) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
  return Object.keys(value).sort().slice(0, limit);
}

function classifyPubkeyShape(pubkey) {
  if (typeof pubkey !== 'string' || pubkey.length === 0) return 'missing';
  if (!HEX_RE.test(pubkey)) return 'non_hex';
  if (pubkey.length !== 66) return 'wrong_length';
  if (!/^(02|03)/i.test(pubkey)) return 'wrong_prefix';
  return 'compressed_hex';
}

function classifySignatureShape(signature) {
  if (typeof signature !== 'string' || signature.length === 0) return 'missing';
  if (!HEX_RE.test(signature)) return 'non_hex';
  if (signature.length % 2 !== 0) return 'odd_hex_length';
  if (signature.length < 16) return 'too_short';
  if (!signature.toLowerCase().startsWith('30')) return 'not_der_like';
  return 'der_hex';
}

export function buildSignedValidationFingerprint({
  payload,
  profile,
  failedAt,
  expectedAction,
  agentId,
  classification = 'unknown',
}) {
  const topLevelKeys = summarizeKeys(payload);
  const instruction = payload?.instruction;
  const signature = payload?.signature;

  return {
    failed_at: failedAt,
    reason: classification,
    top_level_keys: topLevelKeys,
    instruction_keys: summarizeKeys(instruction, 12),
    instruction_action: typeof instruction?.action === 'string' ? instruction.action : null,
    expected_action: expectedAction,
    agent_id_matches: instruction?.agent_id === agentId,
    timestamp_type: typeof instruction?.timestamp,
    signature_shape: classifySignatureShape(signature),
    signature_hex_len: typeof signature === 'string' ? signature.length : 0,
    pubkey_shape: classifyPubkeyShape(profile?.pubkey),
  };
}

export function attachSignedValidationFingerprint(result, fingerprint) {
  Object.defineProperty(result, 'failure_fingerprint', {
    value: fingerprint,
    enumerable: false,
    configurable: true,
    writable: false,
  });
  return result;
}

export async function appendSignedValidationFailure({
  dataLayer,
  routeFamily,
  operation = null,
  agentId,
  expectedAction = null,
  fingerprint,
}) {
  if (!dataLayer || typeof dataLayer.appendLog !== 'function' || !fingerprint) return;
  await dataLayer.appendLog(SIGNED_VALIDATION_FAILURES_PATH, {
    route_family: routeFamily,
    operation,
    agent_id: agentId,
    expected_action: expectedAction,
    ...fingerprint,
  });
}

export async function classifyInvalidSignature({ payload, profile }) {
  const signatureShape = classifySignatureShape(payload?.signature);
  if (signatureShape === 'non_hex' || signatureShape === 'odd_hex_length') {
    return {
      code: 'signature_bad_hex',
      hint: 'signature must be hex. Send signer.sign(privateKey).toString("hex").',
    };
  }
  if (signatureShape === 'too_short' || signatureShape === 'not_der_like') {
    return {
      code: 'signature_not_der',
      hint: 'signature must be DER-encoded secp256k1 ECDSA hex. In Node, use signer.sign(privateKey).toString("hex").',
    };
  }

  const pubkeyShape = classifyPubkeyShape(profile?.pubkey);
  if (pubkeyShape !== 'compressed_hex') {
    return {
      code: 'pubkey_invalid',
      hint: 'Your registered pubkey must be compressed secp256k1 hex: 66 hex chars starting with 02 or 03.',
    };
  }

  const instruction = payload?.instruction;
  if (!instruction || typeof instruction !== 'object' || Array.isArray(instruction)) {
    return {
      code: 'signature_unknown',
      hint: null,
    };
  }

  const signature = payload.signature;
  const wrapperMessages = [
    canonicalJSON({ instruction }),
    canonicalJSON({ instruction, signature: '' }),
  ];
  for (const wrapperMessage of wrapperMessages) {
    if (await verifySecp256k1Signature(profile.pubkey, wrapperMessage, signature)) {
      return {
        code: 'signed_wrapper_not_instruction',
        hint: 'You signed the outer wrapper. Sign only the inner instruction object, not { instruction, signature }.',
      };
    }
  }

  const jsonMessage = JSON.stringify(instruction);
  const canonicalMessage = canonicalJSON(instruction);
  if (
    jsonMessage !== canonicalMessage &&
    await verifySecp256k1Signature(profile.pubkey, jsonMessage, signature)
  ) {
    return {
      code: 'signed_noncanonical_json',
      hint: 'You likely signed JSON.stringify(instruction). Sign canonicalJSON(instruction) instead: sort keys and remove whitespace.',
    };
  }

  const digestHexMessage = sha256(canonicalMessage);
  if (await verifySecp256k1Signature(profile.pubkey, digestHexMessage, signature)) {
    return {
      code: 'signed_digest_hex_string',
      hint: 'Do not sign the hex digest string. Pass canonicalJSON(instruction) into createSign("SHA256").',
    };
  }

  return {
    code: 'signature_unknown',
    hint: null,
  };
}
