/**
 * Shared Ed25519 test helpers — used across unit and E2E tests.
 */

import { generateKeyPairSync, sign } from 'node:crypto';
import { canonicalJSON } from './crypto-utils.js';

export function generateTestKeypair() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const pubHex = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('hex');
  return { publicKey, privateKey, pubHex };
}

export function signInstruction(instruction, privateKey) {
  const message = canonicalJSON(instruction);
  return sign(null, Buffer.from(message), privateKey).toString('hex');
}
