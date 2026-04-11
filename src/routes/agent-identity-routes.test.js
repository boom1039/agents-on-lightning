import test from 'node:test';
import assert from 'node:assert/strict';

import { validateNodeCredentialsShape } from './agent-identity-routes.js';

test('node credential shape rejects tiny placeholder credentials before network verification', () => {
  assert.match(validateNodeCredentialsShape('00', '00'), /macaroon/);
  assert.match(validateNodeCredentialsShape('ab'.repeat(16), '00'), /tls_cert/);
  assert.equal(validateNodeCredentialsShape('ab'.repeat(16), 'cd'.repeat(32)), null);
});
