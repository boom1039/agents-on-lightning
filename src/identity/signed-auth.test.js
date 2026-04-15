import test from 'node:test';
import assert from 'node:assert/strict';
import { createSign, generateKeyPairSync } from 'node:crypto';

import {
  SignedAuthReplayStore,
  buildRegistrationAuthPayload,
  buildSignedToolCallPayload,
  canonicalAuthHash,
  canonicalAuthJson,
  normalizeSecp256k1DerSignatureToLowS,
  parseStrictDerEcdsaSignature,
  verifyRegistrationAuth,
  verifyToolAgentAuth,
} from './signed-auth.js';

const SECP256K1_ORDER = BigInt('0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141');

function publicKeyToCompressedHex(publicKey) {
  const jwk = publicKey.export({ format: 'jwk' });
  const x = Buffer.from(jwk.x, 'base64url');
  const y = Buffer.from(jwk.y, 'base64url');
  return `${(y[y.length - 1] & 1) ? '03' : '02'}${x.toString('hex')}`;
}

function signLowS(privateKey, payload) {
  const signer = createSign('SHA256');
  signer.update(payload, 'utf8');
  signer.end();
  const normalized = normalizeSecp256k1DerSignatureToLowS(signer.sign(privateKey).toString('hex'));
  assert.equal(normalized.ok, true, normalized.message);
  return normalized.signature;
}

function encodeDerInteger(value) {
  let hex = value.toString(16);
  if (hex.length % 2) hex = `0${hex}`;
  let bytes = Buffer.from(hex, 'hex');
  if (bytes[0] & 0x80) bytes = Buffer.concat([Buffer.from([0x00]), bytes]);
  return Buffer.concat([Buffer.from([0x02, bytes.length]), bytes]);
}

function encodeDerSignature(r, s) {
  const body = Buffer.concat([encodeDerInteger(r), encodeDerInteger(s)]);
  return Buffer.concat([Buffer.from([0x30, body.length]), body]).toString('hex');
}

function toHighSSignature(lowSignature) {
  const parsed = parseStrictDerEcdsaSignature(lowSignature);
  assert.equal(parsed.ok, true, parsed.message);
  return encodeDerSignature(parsed.r, SECP256K1_ORDER - parsed.s);
}

function makeKey() {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'secp256k1' });
  return { privateKey, pubkey: publicKeyToCompressedHex(publicKey) };
}

test('registration auth proves control of the registering secp256k1 key', async () => {
  const key = makeKey();
  const profile = {
    name: 'signed-auth-test',
    description: null,
    framework: null,
    forked_from: null,
    contact_url: null,
    referred_by: null,
  };
  const payload = buildRegistrationAuthPayload({
    audience: 'https://agentsonlightning.com/mcp',
    pubkey: key.pubkey,
    profile,
    timestamp: Math.floor(Date.now() / 1000),
    nonce: 'registration-nonce-1',
  });
  const signingPayload = canonicalAuthJson(payload);
  const result = await verifyRegistrationAuth({
    audience: payload.audience,
    profile,
    pubkey: key.pubkey,
    registrationAuth: {
      timestamp: payload.timestamp,
      nonce: payload.nonce,
      signature: signLowS(key.privateKey, signingPayload),
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.auth_payload_hash, canonicalAuthHash(payload));
});

test('signed tool-call auth binds signature to exact tool name and arguments', async () => {
  const key = makeKey();
  const args = { amount_sats: 1000, quote: 'quote-1' };
  const payload = buildSignedToolCallPayload({
    audience: 'https://agentsonlightning.com/mcp',
    agentId: 'a1b2c3d4',
    toolName: 'aol_mint_wallet',
    args,
    timestamp: Math.floor(Date.now() / 1000),
    nonce: 'tool-auth-nonce-1',
  });
  const signature = signLowS(key.privateKey, canonicalAuthJson(payload));

  const ok = await verifyToolAgentAuth({
    audience: payload.audience,
    toolName: 'aol_mint_wallet',
    args: { ...args, agent_auth: { agent_id: 'a1b2c3d4', timestamp: payload.timestamp, nonce: payload.nonce, signature } },
    agentAuth: { agent_id: 'a1b2c3d4', timestamp: payload.timestamp, nonce: payload.nonce, signature },
    registry: { getById: () => ({ id: 'a1b2c3d4', pubkey: key.pubkey }) },
  });
  assert.equal(ok.ok, true);

  const tampered = await verifyToolAgentAuth({
    audience: payload.audience,
    toolName: 'aol_mint_wallet',
    args: { amount_sats: 2000, quote: 'quote-1', agent_auth: { agent_id: 'a1b2c3d4', timestamp: payload.timestamp, nonce: payload.nonce, signature } },
    agentAuth: { agent_id: 'a1b2c3d4', timestamp: payload.timestamp, nonce: payload.nonce, signature },
    registry: { getById: () => ({ id: 'a1b2c3d4', pubkey: key.pubkey }) },
  });
  assert.equal(tampered.ok, false);
  assert.equal(tampered.code, 'invalid_signature');
});

test('signed tool-call auth rejects wrong tool, wrong audience, and stale timestamps', async () => {
  const key = makeKey();
  const args = { amount_sats: 1000 };
  const payload = buildSignedToolCallPayload({
    audience: 'https://agentsonlightning.com/mcp',
    agentId: 'a1b2c3d4',
    toolName: 'aol_get_capital_balance',
    args,
    timestamp: Math.floor(Date.now() / 1000),
    nonce: 'tool-auth-nonce-2',
  });
  const auth = {
    agent_id: 'a1b2c3d4',
    timestamp: payload.timestamp,
    nonce: payload.nonce,
    signature: signLowS(key.privateKey, canonicalAuthJson(payload)),
  };
  const registry = { getById: () => ({ id: 'a1b2c3d4', pubkey: key.pubkey }) };

  const wrongTool = await verifyToolAgentAuth({
    audience: payload.audience,
    toolName: 'aol_get_wallet_balance',
    args: { ...args, agent_auth: auth },
    agentAuth: auth,
    registry,
  });
  assert.equal(wrongTool.ok, false);
  assert.equal(wrongTool.code, 'invalid_signature');

  const wrongAudience = await verifyToolAgentAuth({
    audience: 'https://agentsonbitcoin.com/mcp',
    toolName: 'aol_get_capital_balance',
    args: { ...args, agent_auth: auth },
    agentAuth: auth,
    registry,
  });
  assert.equal(wrongAudience.ok, false);
  assert.equal(wrongAudience.code, 'invalid_signature');

  const stale = await verifyToolAgentAuth({
    audience: payload.audience,
    toolName: 'aol_get_capital_balance',
    args,
    agentAuth: {
      ...auth,
      timestamp: payload.timestamp - 10_000,
      nonce: 'tool-auth-nonce-3',
    },
    registry,
  });
  assert.equal(stale.ok, false);
  assert.equal(stale.code, 'stale_timestamp');
});

test('signed tool-call auth rejects high-S signatures', async () => {
  const key = makeKey();
  const args = { amount_sats: 1000 };
  const payload = buildSignedToolCallPayload({
    audience: 'https://agentsonlightning.com/mcp',
    agentId: 'a1b2c3d4',
    toolName: 'aol_get_capital_balance',
    args,
    timestamp: Math.floor(Date.now() / 1000),
    nonce: 'tool-auth-nonce-4',
  });
  const lowSignature = signLowS(key.privateKey, canonicalAuthJson(payload));
  const highSignature = toHighSSignature(lowSignature);

  const result = await verifyToolAgentAuth({
    audience: payload.audience,
    toolName: 'aol_get_capital_balance',
    args: { ...args, agent_auth: { agent_id: 'a1b2c3d4', timestamp: payload.timestamp, nonce: payload.nonce, signature: highSignature } },
    agentAuth: { agent_id: 'a1b2c3d4', timestamp: payload.timestamp, nonce: payload.nonce, signature: highSignature },
    registry: { getById: () => ({ id: 'a1b2c3d4', pubkey: key.pubkey }) },
  });

  assert.equal(result.ok, false);
  assert.equal(result.code, 'high_s_signature');
});

test('replay store rejects the same signed payload hash twice', async () => {
  const writes = [];
  const state = { entries: {} };
  const store = new SignedAuthReplayStore({
    readRuntimeStateJSON: async () => state,
    writeJSON: async (_path, value) => {
      writes.push(value);
      state.entries = { ...value.entries };
    },
  }, {
    mutex: {
      acquire: async () => () => {},
    },
  });

  const first = await store.consume('b'.repeat(64), {
    agentId: 'a1b2c3d4',
    nonce: 'nonce-one-shot',
    expiresAt: Date.now() + 60_000,
  });
  const second = await store.consume('b'.repeat(64), {
    agentId: 'a1b2c3d4',
    nonce: 'nonce-one-shot',
    expiresAt: Date.now() + 60_000,
  });

  assert.equal(first.ok, true);
  assert.equal(second.ok, false);
  assert.equal(second.code, 'replayed_auth_payload');
  assert.equal(writes.length, 1);
});

test('replay store rejects reused nonce even when payload hash differs', async () => {
  const state = { entries: {} };
  const store = new SignedAuthReplayStore({
    readRuntimeStateJSON: async () => state,
    writeJSON: async (_path, value) => {
      state.entries = { ...value.entries };
    },
  }, {
    mutex: {
      acquire: async () => () => {},
    },
  });

  const first = await store.consume('c'.repeat(64), {
    agentId: 'a1b2c3d4',
    nonce: 'same-nonce',
    expiresAt: Date.now() + 60_000,
  });
  const second = await store.consume('d'.repeat(64), {
    agentId: 'a1b2c3d4',
    nonce: 'same-nonce',
    expiresAt: Date.now() + 60_000,
  });
  const freshNonce = await store.consume('e'.repeat(64), {
    agentId: 'a1b2c3d4',
    nonce: 'fresh-nonce',
    expiresAt: Date.now() + 60_000,
  });

  assert.equal(first.ok, true);
  assert.equal(second.ok, false);
  assert.equal(second.code, 'replayed_auth_nonce');
  assert.equal(freshNonce.ok, true);
});
