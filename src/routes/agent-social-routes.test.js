import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import express from 'express';
import { agentSocialRoutes } from './agent-social-routes.js';

const API_KEY = `lb-agent-${'a'.repeat(64)}`;
const AGENT_ID = 'a1b2c3d4';

async function createHarness() {
  const calls = {
    messages: [],
    alliances: [],
    breaks: [],
  };

  const daemon = {
    agentRegistry: {
      getByApiKey(apiKey) {
        return apiKey === API_KEY ? { id: AGENT_ID, referral_code: 'ref-aabbccdd' } : null;
      },
      async getReputation(agentId) {
        return { agent_id: agentId };
      },
      async getTopEvangelists() {
        return [];
      },
    },
    messaging: {
      async send(fromId, toId, content, type) {
        calls.messages.push({ fromId, toId, content, type });
        return { message_id: 'msg-1', from: fromId, to: toId, content, type };
      },
      async getInbox() {
        return [];
      },
    },
    allianceManager: {
      async propose(fromId, toId, terms) {
        calls.alliances.push({ fromId, toId, terms });
        return { id: 'alliance-1', proposer: fromId, partner: toId, terms };
      },
      async list() {
        return [];
      },
      async accept(id, agentId) {
        return { id, agentId, status: 'active' };
      },
      async breakAlliance(id, agentId, reason) {
        calls.breaks.push({ id, agentId, reason });
        return { id, agentId, reason, status: 'broken' };
      },
    },
    externalLeaderboard: {
      async getData() {
        return { entries: [], updatedAt: null };
      },
    },
    tournamentManager: null,
  };

  const app = express();
  app.use(express.json());
  app.use(agentSocialRoutes(daemon));

  const server = app.listen(0);
  await once(server, 'listening');
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;

  async function request(method, path, body, { auth = true } = {}) {
    const headers = {};
    if (auth) headers.authorization = `Bearer ${API_KEY}`;
    if (body !== undefined) headers['content-type'] = 'application/json';

    const response = await fetch(`${baseUrl}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return {
      status: response.status,
      json: await response.json(),
    };
  }

  async function close() {
    await new Promise((resolve, reject) => {
      server.close(err => (err ? reject(err) : resolve()));
    });
  }

  return { calls, request, close };
}

test('message route normalizes content and enforces explicit message types', async () => {
  const harness = await createHarness();
  try {
    const response = await harness.request('POST', '/api/v1/messages', {
      to: 'b1c2d3e4',
      content: 'Hello\u0007\r\nworld\tfriend',
      type: 'intel',
    });

    assert.equal(response.status, 201);
    assert.equal(harness.calls.messages.length, 1);
    assert.deepEqual(harness.calls.messages[0], {
      fromId: AGENT_ID,
      toId: 'b1c2d3e4',
      content: 'Hello\nworld friend',
      type: 'intel',
    });
  } finally {
    await harness.close();
  }
});

test('message route rejects invalid message types', async () => {
  const harness = await createHarness();
  try {
    const response = await harness.request('POST', '/api/v1/messages/send', {
      to: 'b1c2d3e4',
      content: 'hello',
      type: 'intro',
    });

    assert.equal(response.status, 400);
    assert.match(response.json.message, /Invalid message type/);
    assert.equal(harness.calls.messages.length, 0);
  } finally {
    await harness.close();
  }
});

test('alliance proposal route whitelists term fields and normalizes free text', async () => {
  const harness = await createHarness();
  try {
    const okResponse = await harness.request('POST', '/api/v1/alliances', {
      to: 'b1c2d3e4',
      terms: {
        description: 'Share\u0007\r\nintel',
        conditions: 'Weekly\tupdate',
        duration_hours: 24,
      },
    });

    assert.equal(okResponse.status, 201);
    assert.equal(harness.calls.alliances.length, 1);
    assert.deepEqual(harness.calls.alliances[0].terms, {
      description: 'Share\nintel',
      conditions: 'Weekly update',
      duration_hours: 24,
    });

    const badResponse = await harness.request('POST', '/api/v1/alliances/propose', {
      to: 'b1c2d3e4',
      terms: {
        description: 'ok',
        secret_prompt: 'nope',
      },
    });

    assert.equal(badResponse.status, 400);
    assert.match(badResponse.json.message, /unknown fields: secret_prompt/);
  } finally {
    await harness.close();
  }
});

test('alliance break route normalizes reason before passing downstream', async () => {
  const harness = await createHarness();
  try {
    const response = await harness.request('POST', '/api/v1/alliances/alliance-1/break', {
      reason: 'Done\tfor now\u0007\r\nSee you later',
    });

    assert.equal(response.status, 200);
    assert.equal(harness.calls.breaks.length, 1);
    assert.equal(harness.calls.breaks[0].reason, 'Done for now\nSee you later');
  } finally {
    await harness.close();
  }
});
