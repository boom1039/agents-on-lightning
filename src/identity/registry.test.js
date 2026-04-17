import test from 'node:test';
import assert from 'node:assert/strict';
import { createSign, generateKeyPairSync } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { DataLayer } from '../data-layer.js';
import { AgentRegistry, normalizeRegistrationProfileForSigning } from './registry.js';
import {
  SignedAuthReplayStore,
  buildRegistrationAuthPayload,
  canonicalAuthJson,
  normalizeSecp256k1DerSignatureToLowS,
} from './signed-auth.js';

const LEGACY_SECRET_FIELD = ['api', 'key'].join('_');
const LEGACY_SECRET_HASH_FIELD = `${LEGACY_SECRET_FIELD}_hash`;

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

function makeRegistrationAuth({ privateKey, pubkey, profile, timestamp, nonce }) {
  const payload = buildRegistrationAuthPayload({
    audience: 'https://agentsonlightning.com/mcp',
    pubkey,
    profile,
    timestamp,
    nonce,
  });
  return {
    timestamp,
    nonce,
    signature: signLowS(privateKey, canonicalAuthJson(payload)),
  };
}

test('AgentRegistry registration requires secp256k1 proof and stores no reusable shared secret', async () => {
  const tempDir = await mkdtemp(join(tmpdir(), 'aol-registry-auth-'));
  try {
    const dataLayer = new DataLayer(tempDir);
    const registry = new AgentRegistry(dataLayer);
    const replayStore = new SignedAuthReplayStore(dataLayer);
    const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'secp256k1' });
    const pubkey = publicKeyToCompressedHex(publicKey);
    const profile = normalizeRegistrationProfileForSigning({
      name: 'signed registry test',
      description: null,
      framework: null,
      contact_url: null,
      referred_by: null,
    });
    const registration_auth = makeRegistrationAuth({
      privateKey,
      pubkey,
      profile,
      timestamp: Math.floor(Date.now() / 1000),
      nonce: 'registry-nonce-1',
    });

    const registered = await registry.register({
      ...profile,
      pubkey,
      audience: 'https://agentsonlightning.com/mcp',
      registration_auth,
      replayStore,
    });

    assert.match(registered.agent_id, /^[0-9a-f]{8}$/);
    assert.equal(registered[LEGACY_SECRET_FIELD], undefined);
    const fullProfile = await registry.getFullProfile(registered.agent_id);
    assert.equal(fullProfile.pubkey, pubkey);
    assert.equal(fullProfile[LEGACY_SECRET_FIELD], undefined);
    assert.equal(fullProfile[LEGACY_SECRET_HASH_FIELD], undefined);
    assert.equal(registry.getByPubkey(pubkey).id, registered.agent_id);

    await assert.rejects(
      registry.register({
        ...profile,
        name: 'duplicate key',
        pubkey,
        audience: 'https://agentsonlightning.com/mcp',
        registration_auth,
        replayStore,
      }),
      /pubkey is already registered/,
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});
