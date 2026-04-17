import { createHash, createPublicKey, createVerify, ECDH } from 'node:crypto';
import { validateAgentId, validateSecp256k1Pubkey } from './validators.js';
import { acquire as acquireMutex } from './mutex.js';

export const AOL_TOOL_AUTH_SCHEME = 'agent_signed_mcp_tool_call';
export const AOL_REGISTRATION_AUTH_SCHEME = 'aol_agent_registration';
export const AOL_KEY_ROTATION_AUTH_SCHEME = 'aol_agent_key_rotation';
export const AOL_AUTH_VERSION = 1;
export const DEFAULT_AUTH_FRESHNESS_SECONDS = 1200;
export const INTERNAL_VERIFIED_AGENT_ID_HEADER = 'x-aol-verified-agent-id';
export const INTERNAL_AUTH_PAYLOAD_HASH_HEADER = 'x-aol-auth-payload-hash';
export const INTERNAL_AUTH_AUDIENCE_HEADER = 'x-aol-auth-audience';

const SECP256K1_ORDER = BigInt('0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141');
const SECP256K1_HALF_ORDER = SECP256K1_ORDER / 2n;
const AUTH_NONCE_RE = /^[A-Za-z0-9._:-]{12,160}$/;

export function sha256Hex(data) {
  return createHash('sha256').update(data).digest('hex');
}

function isPlainObject(value) {
  if (value === null || typeof value !== 'object') return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

export function assertStrictCanonicalValue(value, path = '$') {
  if (value === null) return;
  if (typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError(`Canonical auth JSON rejects non-finite number at ${path}`);
    if (!Number.isSafeInteger(value)) throw new TypeError(`Canonical auth JSON rejects unsafe or fractional number at ${path}`);
    return;
  }
  if (typeof value === 'undefined') throw new TypeError(`Canonical auth JSON rejects undefined at ${path}`);
  if (typeof value === 'bigint') throw new TypeError(`Canonical auth JSON rejects BigInt at ${path}`);
  if (typeof value === 'function' || typeof value === 'symbol') {
    throw new TypeError(`Canonical auth JSON rejects ${typeof value} at ${path}`);
  }
  if (value instanceof Date) throw new TypeError(`Canonical auth JSON rejects Date at ${path}`);
  if (Buffer.isBuffer(value) || ArrayBuffer.isView(value) || value instanceof ArrayBuffer) {
    throw new TypeError(`Canonical auth JSON rejects binary value at ${path}`);
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertStrictCanonicalValue(item, `${path}[${index}]`));
    return;
  }
  if (!isPlainObject(value)) throw new TypeError(`Canonical auth JSON rejects non-plain object at ${path}`);
  for (const [key, nested] of Object.entries(value)) {
    if (typeof key !== 'string' || key.length === 0) throw new TypeError(`Canonical auth JSON rejects invalid key at ${path}`);
    assertStrictCanonicalValue(nested, `${path}.${key}`);
  }
}

export function canonicalAuthJson(value) {
  assertStrictCanonicalValue(value);
  if (value === null) return 'null';
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number' || typeof value === 'boolean') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => canonicalAuthJson(item)).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalAuthJson(value[key])}`).join(',')}}`;
}

export function canonicalAuthHash(value) {
  return sha256Hex(canonicalAuthJson(value));
}

export function stripAgentAuth(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return {};
  const out = {};
  for (const [key, value] of Object.entries(input)) {
    if (key === 'agent_auth') continue;
    if (value === undefined) continue;
    out[key] = value;
  }
  return out;
}

export function buildSignedToolCallPayload({
  audience,
  agentId,
  toolName,
  args = {},
  timestamp,
  nonce,
}) {
  const effectiveArgs = stripAgentAuth(args);
  const argsHash = `sha256:${canonicalAuthHash(effectiveArgs)}`;
  return {
    scheme: AOL_TOOL_AUTH_SCHEME,
    version: AOL_AUTH_VERSION,
    audience,
    agent_id: agentId,
    tool_name: toolName,
    args_hash: argsHash,
    timestamp,
    nonce,
  };
}

export function buildRegistrationAuthPayload({
  audience,
  pubkey,
  profile,
  timestamp,
  nonce,
}) {
  return {
    scheme: AOL_REGISTRATION_AUTH_SCHEME,
    version: AOL_AUTH_VERSION,
    audience,
    pubkey,
    profile,
    timestamp,
    nonce,
  };
}

export function buildKeyRotationPayload({
  audience,
  agentId,
  oldPubkey,
  newPubkey,
  timestamp,
  nonce,
}) {
  return {
    scheme: AOL_KEY_ROTATION_AUTH_SCHEME,
    version: AOL_AUTH_VERSION,
    audience,
    agent_id: agentId,
    old_pubkey: oldPubkey,
    new_pubkey: newPubkey,
    timestamp,
    nonce,
  };
}

function parseAuthTimestamp(value) {
  if (!Number.isSafeInteger(value)) return null;
  return value;
}

export function validateAuthFreshness(timestamp, nowSec = Math.floor(Date.now() / 1000), maxSkewSec = DEFAULT_AUTH_FRESHNESS_SECONDS) {
  const parsed = parseAuthTimestamp(timestamp);
  if (parsed == null) {
    return { ok: false, code: 'invalid_timestamp', message: 'timestamp must be an integer unix timestamp in seconds.' };
  }
  const drift = Math.abs(nowSec - parsed);
  if (drift > maxSkewSec) {
    return {
      ok: false,
      code: 'stale_timestamp',
      message: `timestamp must be within ${maxSkewSec} seconds of server time.`,
      server_time: nowSec,
      supplied_timestamp: parsed,
      drift_seconds: drift,
    };
  }
  return { ok: true, server_time: nowSec, supplied_timestamp: parsed, drift_seconds: drift };
}

export function validateNonce(nonce) {
  if (typeof nonce !== 'string' || !AUTH_NONCE_RE.test(nonce)) {
    return {
      ok: false,
      code: 'invalid_nonce',
      message: 'nonce must be a unique 12-160 character value using letters, numbers, dot, underscore, colon, or hyphen.',
    };
  }
  return { ok: true };
}

function secp256k1CompressedHexToPublicKey(publicKeyHex) {
  const pkCheck = validateSecp256k1Pubkey(publicKeyHex);
  if (!pkCheck.valid) throw new Error(pkCheck.reason);
  const uncompressed = ECDH.convertKey(
    String(publicKeyHex || ''),
    'secp256k1',
    'hex',
    'hex',
    'uncompressed',
  );
  const bytes = Buffer.from(uncompressed, 'hex');
  const x = bytes.subarray(1, 33).toString('base64url');
  const y = bytes.subarray(33, 65).toString('base64url');
  return createPublicKey({
    key: { kty: 'EC', crv: 'secp256k1', x, y },
    format: 'jwk',
  });
}

function readDerLength(bytes, offset) {
  if (offset >= bytes.length) return null;
  const first = bytes[offset];
  if (first < 0x80) return { length: first, next: offset + 1 };
  const lenBytes = first & 0x7f;
  if (lenBytes === 0 || lenBytes > 2 || offset + lenBytes >= bytes.length) return null;
  let length = 0;
  for (let i = 0; i < lenBytes; i++) length = (length << 8) | bytes[offset + 1 + i];
  if (length < 128) return null;
  return { length, next: offset + 1 + lenBytes };
}

function bytesToBigInt(bytes) {
  let out = 0n;
  for (const byte of bytes) out = (out << 8n) + BigInt(byte);
  return out;
}

function encodeDerInteger(value) {
  let hex = value.toString(16);
  if (hex.length % 2) hex = `0${hex}`;
  let bytes = Buffer.from(hex, 'hex');
  while (bytes.length > 1 && bytes[0] === 0x00 && !(bytes[1] & 0x80)) {
    bytes = bytes.subarray(1);
  }
  if (bytes[0] & 0x80) bytes = Buffer.concat([Buffer.from([0x00]), bytes]);
  return Buffer.concat([Buffer.from([0x02, bytes.length]), bytes]);
}

function encodeDerSignature(r, s) {
  const rBytes = encodeDerInteger(r);
  const sBytes = encodeDerInteger(s);
  const body = Buffer.concat([rBytes, sBytes]);
  return Buffer.concat([Buffer.from([0x30, body.length]), body]).toString('hex');
}

function parseStrictDerEcdsaSignatureInternal(signatureHex, { enforceLowS = true } = {}) {
  if (typeof signatureHex !== 'string' || !/^[0-9a-f]+$/i.test(signatureHex) || signatureHex.length % 2 !== 0) {
    return { ok: false, code: 'invalid_der_signature', message: 'signature must be DER-encoded hex.' };
  }
  const bytes = Buffer.from(signatureHex, 'hex');
  if (bytes.length < 8 || bytes[0] !== 0x30) {
    return { ok: false, code: 'invalid_der_signature', message: 'signature must be a DER SEQUENCE.' };
  }
  const seqLen = readDerLength(bytes, 1);
  if (!seqLen || seqLen.next + seqLen.length !== bytes.length) {
    return { ok: false, code: 'invalid_der_signature', message: 'signature DER sequence length is invalid.' };
  }
  let offset = seqLen.next;
  const integers = [];
  for (let i = 0; i < 2; i++) {
    if (bytes[offset] !== 0x02) {
      return { ok: false, code: 'invalid_der_signature', message: 'signature DER integers are invalid.' };
    }
    const intLen = readDerLength(bytes, offset + 1);
    if (!intLen || intLen.length === 0 || intLen.next + intLen.length > bytes.length) {
      return { ok: false, code: 'invalid_der_signature', message: 'signature DER integer length is invalid.' };
    }
    const raw = bytes.subarray(intLen.next, intLen.next + intLen.length);
    if (raw[0] & 0x80) {
      return { ok: false, code: 'invalid_der_signature', message: 'signature DER integer must be positive.' };
    }
    if (raw.length > 1 && raw[0] === 0x00 && !(raw[1] & 0x80)) {
      return { ok: false, code: 'invalid_der_signature', message: 'signature DER integer is not minimally encoded.' };
    }
    const value = bytesToBigInt(raw);
    if (value <= 0n || value >= SECP256K1_ORDER) {
      return { ok: false, code: 'invalid_der_signature', message: 'signature scalar is outside secp256k1 range.' };
    }
    integers.push(value);
    offset = intLen.next + intLen.length;
  }
  if (offset !== bytes.length) {
    return { ok: false, code: 'invalid_der_signature', message: 'signature contains trailing bytes.' };
  }
  const [r, s] = integers;
  if (enforceLowS && s > SECP256K1_HALF_ORDER) {
    return { ok: false, code: 'high_s_signature', message: 'signature must use low-S secp256k1 ECDSA form.' };
  }
  return { ok: true, r, s };
}

export function parseStrictDerEcdsaSignature(signatureHex) {
  return parseStrictDerEcdsaSignatureInternal(signatureHex, { enforceLowS: true });
}

export function normalizeSecp256k1DerSignatureToLowS(signatureHex) {
  const parsed = parseStrictDerEcdsaSignatureInternal(signatureHex, { enforceLowS: false });
  if (!parsed.ok) return parsed;
  const s = parsed.s > SECP256K1_HALF_ORDER ? SECP256K1_ORDER - parsed.s : parsed.s;
  return {
    ok: true,
    signature: encodeDerSignature(parsed.r, s),
    was_high_s: parsed.s > SECP256K1_HALF_ORDER,
  };
}

export async function verifySecp256k1DerSignature(publicKeyHex, message, signatureHex) {
  const derCheck = parseStrictDerEcdsaSignature(signatureHex);
  if (!derCheck.ok) return { ok: false, ...derCheck };
  try {
    const pubkey = secp256k1CompressedHexToPublicKey(publicKeyHex);
    const verifier = createVerify('SHA256');
    verifier.update(String(message), 'utf8');
    verifier.end();
    const valid = verifier.verify(pubkey, Buffer.from(String(signatureHex || ''), 'hex'));
    if (!valid) return { ok: false, code: 'invalid_signature', message: 'signature does not verify for the registered secp256k1 public key.' };
    return { ok: true };
  } catch (err) {
    return { ok: false, code: 'signature_verification_failed', message: err?.message || 'signature verification failed.' };
  }
}

export async function verifyRegistrationAuth({ audience, profile, pubkey, registrationAuth }) {
  const pkCheck = validateSecp256k1Pubkey(pubkey);
  if (!pkCheck.valid) return { ok: false, code: 'invalid_pubkey', message: pkCheck.reason };
  if (!registrationAuth || typeof registrationAuth !== 'object' || Array.isArray(registrationAuth)) {
    return { ok: false, code: 'missing_registration_auth', message: 'registration_auth is required.' };
  }
  const nonceCheck = validateNonce(registrationAuth.nonce);
  if (!nonceCheck.ok) return nonceCheck;
  const freshness = validateAuthFreshness(registrationAuth.timestamp);
  if (!freshness.ok) return freshness;
  const payload = buildRegistrationAuthPayload({
    audience,
    pubkey,
    profile,
    timestamp: registrationAuth.timestamp,
    nonce: registrationAuth.nonce,
  });
  const signingPayload = canonicalAuthJson(payload);
  const signatureCheck = await verifySecp256k1DerSignature(pubkey, signingPayload, registrationAuth.signature);
  if (!signatureCheck.ok) return signatureCheck;
  return {
    ok: true,
    payload,
    signing_payload: signingPayload,
    auth_payload_hash: canonicalAuthHash(payload),
  };
}

export async function verifyToolAgentAuth({
  audience,
  toolName,
  args,
  agentAuth,
  registry,
  replayStore,
}) {
  if (!agentAuth || typeof agentAuth !== 'object' || Array.isArray(agentAuth)) {
    return { ok: false, code: 'AUTH_REQUIRED', message: 'agent_auth is required for this private MCP tool.' };
  }
  const agentIdCheck = validateAgentId(agentAuth.agent_id);
  if (!agentIdCheck.valid) return { ok: false, code: 'invalid_agent_id', message: agentIdCheck.reason };
  const nonceCheck = validateNonce(agentAuth.nonce);
  if (!nonceCheck.ok) return nonceCheck;
  const freshness = validateAuthFreshness(agentAuth.timestamp);
  if (!freshness.ok) return freshness;
  const profile = registry?.getById?.(agentAuth.agent_id);
  if (!profile) return { ok: false, code: 'unknown_agent', message: 'No registered agent matches agent_auth.agent_id.' };
  if (!profile.pubkey) return { ok: false, code: 'missing_pubkey', message: 'Agent profile has no registered secp256k1 public key.' };
  const payload = buildSignedToolCallPayload({
    audience,
    agentId: agentAuth.agent_id,
    toolName,
    args,
    timestamp: agentAuth.timestamp,
    nonce: agentAuth.nonce,
  });
  const signingPayload = canonicalAuthJson(payload);
  const authPayloadHash = canonicalAuthHash(payload);
  const signatureCheck = await verifySecp256k1DerSignature(profile.pubkey, signingPayload, agentAuth.signature);
  if (!signatureCheck.ok) return signatureCheck;
  if (replayStore) {
    const replay = await replayStore.consume(authPayloadHash, {
      agentId: agentAuth.agent_id,
      nonce: agentAuth.nonce,
      expiresAt: (agentAuth.timestamp + DEFAULT_AUTH_FRESHNESS_SECONDS) * 1000,
    });
    if (!replay.ok) return replay;
  }
  return {
    ok: true,
    agent_id: agentAuth.agent_id,
    profile,
    payload,
    signing_payload: signingPayload,
    auth_payload_hash: authPayloadHash,
  };
}

export class SignedAuthReplayStore {
  constructor(dataLayer, {
    path = 'data/identity/signed-auth-replay.json',
    mutex = { acquire: acquireMutex },
  } = {}) {
    this._dataLayer = dataLayer;
    this._path = path;
    this._mutex = mutex;
  }

  async consume(authPayloadHash, { agentId, nonce, expiresAt }) {
    if (!this._dataLayer || typeof this._dataLayer.readRuntimeStateJSON !== 'function' || typeof this._dataLayer.writeJSON !== 'function') {
      return { ok: false, code: 'replay_store_unavailable', message: 'Signed-auth replay store is unavailable.' };
    }
    if (typeof authPayloadHash !== 'string' || !/^[0-9a-f]{64}$/i.test(authPayloadHash)) {
      return { ok: false, code: 'invalid_auth_payload_hash', message: 'auth payload hash is invalid.' };
    }
    const unlock = await this._mutex.acquire(`signed-auth-replay:${this._path}`);
    try {
      const now = Date.now();
      const state = await this._dataLayer.readRuntimeStateJSON(this._path, {
        defaultValue: { entries: {} },
      });
      const entries = state.entries && typeof state.entries === 'object' && !Array.isArray(state.entries)
        ? state.entries
        : {};
      for (const [hash, entry] of Object.entries(entries)) {
        const expiry = typeof entry?.expires_at === 'number' ? entry.expires_at : 0;
        if (expiry <= now) delete entries[hash];
      }
      if (entries[authPayloadHash]) {
        return { ok: false, code: 'replayed_auth_payload', message: 'This signed agent_auth payload was already used.' };
      }
      for (const entry of Object.values(entries)) {
        if (entry?.agent_id === agentId && nonce && entry?.nonce === nonce) {
          return { ok: false, code: 'replayed_auth_nonce', message: 'This agent_auth nonce was already used.' };
        }
      }
      entries[authPayloadHash] = {
        agent_id: agentId,
        nonce: typeof nonce === 'string' ? nonce : null,
        expires_at: Number.isFinite(expiresAt) ? expiresAt : now + DEFAULT_AUTH_FRESHNESS_SECONDS * 1000,
        consumed_at: now,
      };
      await this._dataLayer.writeJSON(this._path, { entries });
      return { ok: true };
    } finally {
      unlock();
    }
  }
}
