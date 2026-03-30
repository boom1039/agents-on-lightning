import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DataLayer } from '../data-layer.js';
import { AgentRegistry } from './registry.js';

async function makeRegistry() {
  const baseDir = await mkdtemp(join(tmpdir(), 'aol-registry-'));
  const dataLayer = new DataLayer(baseDir);
  const registry = new AgentRegistry(dataLayer);
  return { baseDir, dataLayer, registry };
}

test('register stores only a hashed API key and still authenticates by raw token', async () => {
  const { baseDir, registry } = await makeRegistry();
  try {
    const result = await registry.register({ name: 'secure-agent' });
    const profilePath = join(baseDir, 'data', 'external-agents', result.agent_id, 'profile.json');
    const saved = JSON.parse(await readFile(profilePath, 'utf8'));

    assert.equal(typeof result.api_key, 'string');
    assert.equal(typeof saved.api_key_hash, 'string');
    assert.equal('api_key' in saved, false);
    assert.equal(registry.getByApiKey(result.api_key)?.id, result.agent_id);
  } finally {
    await rm(baseDir, { recursive: true, force: true });
  }
});

test('getPublicProfile hides private fields and updateProfile rejects forbidden fields', async () => {
  const { baseDir, registry } = await makeRegistry();
  try {
    const result = await registry.register({
      name: 'public-agent',
      description: 'desc',
      framework: 'fw',
      contact_url: 'https://example.com/contact',
    });

    const updated = await registry.updateProfile(result.agent_id, {
      public_key: `02${'a'.repeat(64)}`,
    });
    assert.equal(updated.pubkey, `02${'a'.repeat(64)}`);

    const publicProfile = await registry.getPublicProfile(result.agent_id);
    assert.equal(publicProfile.name, 'public-agent');
    assert.equal('referral_code' in publicProfile, false);
    assert.equal('api_key_hash' in publicProfile, false);
    assert.equal('pubkey' in publicProfile, false);

    await assert.rejects(
      () => registry.updateProfile(result.agent_id, { badge: 'staff' }),
      /Unknown or forbidden profile field: badge/
    );
    await assert.rejects(
      () => registry.updateProfile(result.agent_id, { unexpected_field: 'nope' }),
      /Unknown or forbidden profile field: unexpected_field/
    );
  } finally {
    await rm(baseDir, { recursive: true, force: true });
  }
});

test('profile updates store sanitized text with raw visibility kept off API responses', async () => {
  const { baseDir, registry, dataLayer } = await makeRegistry();
  try {
    const result = await registry.register({
      name: 'sanitize-agent',
      description: 'Hello\tworld',
      framework: 'node\r\noperator',
    });

    const updated = await registry.updateProfile(result.agent_id, {
      description: 'Line 1\u0007\r\nLine 2',
      framework: 'operator\tstack',
    });

    assert.equal(updated.description, 'Line 1\nLine 2');
    assert.equal(updated.description_raw, 'Line 1\u0007\r\nLine 2');
    assert.equal(updated.framework, 'operator stack');
    assert.equal(updated.framework_raw, 'operator\tstack');

    const stored = await dataLayer.readJSON(`data/external-agents/${result.agent_id}/profile.json`);
    assert.equal(stored.description, 'Line 1\nLine 2');
    assert.equal(stored.description_raw, 'Line 1\u0007\r\nLine 2');

    const fullProfile = await registry.getFullProfile(result.agent_id);
    assert.equal(fullProfile.description, 'Line 1\nLine 2');
    assert.equal('description_raw' in fullProfile, false);
    assert.equal('framework_raw' in fullProfile, false);
  } finally {
    await rm(baseDir, { recursive: true, force: true });
  }
});

test('logMessage sanitizes stored content and preserves raw text for admin visibility', async () => {
  const { baseDir, registry } = await makeRegistry();
  try {
    const result = await registry.register({ name: 'message-agent' });
    await registry.logMessage(result.agent_id, {
      direction: 'received',
      content: 'Hello\u0007\r\nworld\tfriend',
      type: 'message',
    });

    const messages = await registry.getMessages(result.agent_id);
    assert.equal(messages.length, 1);
    assert.equal(messages[0].content, 'Hello\nworld friend');
    assert.equal(messages[0].content_raw, 'Hello\u0007\r\nworld\tfriend');
  } finally {
    await rm(baseDir, { recursive: true, force: true });
  }
});

test('logAction sanitizes free text and preserves raw description', async () => {
  const { baseDir, registry } = await makeRegistry();
  try {
    const result = await registry.register({ name: 'action-agent' });
    await registry.logAction(result.agent_id, {
      action_id: 'act-1',
      description: 'Raise\tfees\u0007\r\ncarefully',
      status: 'pending',
    });

    const actions = await registry.getActions(result.agent_id);
    assert.equal(actions.length, 1);
    assert.equal(actions[0].description, 'Raise fees\ncarefully');
    assert.equal(actions[0].description_raw, 'Raise\tfees\u0007\r\ncarefully');
  } finally {
    await rm(baseDir, { recursive: true, force: true });
  }
});
