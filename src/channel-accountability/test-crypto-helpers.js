/**
 * Shared secp256k1 ECDSA test helpers — used across unit and E2E tests.
 */

import { createSign, generateKeyPairSync } from 'node:crypto';
import { canonicalJSON } from './crypto-utils.js';

export function generateTestKeypair() {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'secp256k1' });
  const jwk = publicKey.export({ format: 'jwk' });
  const x = Buffer.from(jwk.x, 'base64url');
  const y = Buffer.from(jwk.y, 'base64url');
  const prefix = (y[y.length - 1] & 1) ? 0x03 : 0x02;
  const pubHex = Buffer.concat([Buffer.from([prefix]), x]).toString('hex');
  return { privateKey, pubHex };
}

export function signInstruction(instruction, privateKey) {
  const message = canonicalJSON(instruction);
  const signer = createSign('SHA256');
  signer.update(message, 'utf8');
  signer.end();
  return signer.sign(privateKey).toString('hex');
}
