import test from 'node:test';
import assert from 'node:assert/strict';
import { verifySecp256k1Signature } from '../../src/identity/auth.js';
import { canonicalJSON } from '../../src/channel-accountability/crypto-utils.js';
import { createAgentLocalToolContext } from './agent-local-tools.mjs';

test('local signing tools create a valid secp256k1 signature', async () => {
  const ctx = createAgentLocalToolContext({
    baseUrl: 'http://localhost:3302',
    requestHttp: async () => ({ status: 200, parsed: {} }),
  });

  const key = await ctx.executeTool('generate_secp256k1_keypair', { key_name: 'test-key' });
  const signed = await ctx.executeTool('build_signed_instruction', {
    key_name: 'test-key',
    action: 'rebalance',
    agent_id: 'agent-1234',
    params: { outbound_chan_id: '1', amount_sats: 10000, max_fee_sats: 10 },
  });

  assert.equal(key.ok, true);
  assert.equal(signed.ok, true);
  assert.equal(signed.pubkey, key.pubkey);
  assert.equal(typeof signed.signature, 'string');
  assert.equal(signed.signature.length > 0, true);

  const verified = await verifySecp256k1Signature(signed.pubkey, canonicalJSON(signed.instruction), signed.signature);
  assert.equal(verified, true);
});

test('local context tracks registration and pubkey upload', async () => {
  const ctx = createAgentLocalToolContext({
    baseUrl: 'http://localhost:3302',
    requestHttp: async () => ({ status: 200, parsed: {} }),
  });

  ctx.observeHttp(
    { method: 'POST', url: '/api/v1/agents/register', headers: null, body: { name: 'alice' } },
    { status: 201, parsed: { agent_id: 'agent-1', api_key: 'lb-agent-abc' } },
  );
  ctx.observeHttp(
    {
      method: 'PUT',
      url: '/api/v1/agents/me',
      headers: { Authorization: 'Bearer lb-agent-abc' },
      body: { pubkey: `02${'a'.repeat(64)}` },
    },
    { status: 200, parsed: { ok: true } },
  );

  const state = ctx.getState();
  assert.equal(state.latestAgentId, 'agent-1');
  assert.deepEqual(state.agents, [{ agent_id: 'agent-1', has_api_key: true, has_pubkey: true }]);
});

test('build_signed_instruction can sign a full provided instruction object', async () => {
  const ctx = createAgentLocalToolContext({
    baseUrl: 'http://localhost:3302',
    requestHttp: async () => ({ status: 200, parsed: {} }),
  });

  const signed = await ctx.executeTool('build_signed_instruction', {
    key_name: 'provided-instruction-key',
    instruction: {
      action: 'channel_close',
      agent_id: 'agent-1',
      params: { channel_point: `${'0'.repeat(64)}:0` },
    },
  });

  assert.equal(signed.ok, true);
  assert.equal(signed.instruction.action, 'channel_close');
  assert.equal(signed.instruction.agent_id, 'agent-1');
  assert.equal(signed.instruction.params.channel_point, `${'0'.repeat(64)}:0`);
  const verified = await verifySecp256k1Signature(signed.pubkey, canonicalJSON(signed.instruction), signed.signature);
  assert.equal(verified, true);
});

test('build_signed_instruction reuses the last generated key when key_name is omitted', async () => {
  const ctx = createAgentLocalToolContext({
    baseUrl: 'http://localhost:3302',
    requestHttp: async () => ({ status: 200, parsed: {} }),
  });

  const key = await ctx.executeTool('generate_secp256k1_keypair', { key_name: 'sticky-key' });
  const signed = await ctx.executeTool('build_signed_instruction', {
    action: 'channel_close',
    agent_id: 'agent-1',
    params: { channel_point: `${'0'.repeat(64)}:0` },
  });

  assert.equal(signed.pubkey, key.pubkey);
  const verified = await verifySecp256k1Signature(signed.pubkey, canonicalJSON(signed.instruction), signed.signature);
  assert.equal(verified, true);
});
