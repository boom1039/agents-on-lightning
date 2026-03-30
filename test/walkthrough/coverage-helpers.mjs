import assert from 'node:assert/strict';
import { generateTestKeypair, signInstruction as signSecp256k1 } from '../../src/channel-accountability/test-crypto-helpers.js';

export const DEFAULT_NODE_PUBKEY = '039f11768dc2c6adbbed823cc062592737e1f8702719e02909da67a58ade718274';
export const DEFAULT_MARKET_PEER = '03864ef025fde8fb587d989186ce6a4a186895ee44a926bfc370e2c366597a3f8f';
export const DEFAULT_OPEN_AMOUNT_SATS = 100_000;
export const DEFAULT_FUNDING_TIMEOUT_SECS = 0;

export class SkipPhaseError extends Error {
  constructor(message) {
    super(message);
    this.name = 'SkipPhaseError';
  }
}

function truncate(value, max = 140) {
  if (value == null) return '';
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return text.length > max ? `${text.slice(0, max)}...` : text;
}

function describeResponse(resp) {
  if (!resp) return '';
  if (resp.json?.error) return ` — ${truncate(resp.json.error)}`;
  if (resp.json?.message) return ` — ${truncate(resp.json.message)}`;
  if (resp.text) return ` — ${truncate(resp.text)}`;
  return '';
}

export function assertStatus(resp, expected, label) {
  if (Array.isArray(expected)) {
    assert.ok(
      expected.includes(resp.status),
      `${label}: expected ${expected.join('/')} got ${resp.status}${describeResponse(resp)}`,
    );
    return;
  }
  assert.equal(resp.status, expected, `${label}: expected ${expected} got ${resp.status}${describeResponse(resp)}`);
}

export function assertSafe(resp, label) {
  assert.ok(resp.status > 0 && resp.status < 500, `${label}: unexpected ${resp.status}${describeResponse(resp)}`);
}

export function assertJsonFields(resp, fields, label) {
  assert.ok(resp.json && typeof resp.json === 'object', `${label}: expected JSON body`);
  for (const field of fields) {
    assert.ok(resp.json[field] !== undefined, `${label}: missing "${field}"`);
  }
}

export function assertHelpful(resp, status, label, extraFields = []) {
  assertStatus(resp, status, label);
  assertJsonFields(resp, ['error', 'hint', ...extraFields], label);
}

export function assertChecksPassed(resp, requiredChecks, label) {
  const checks = resp.json?.checks_passed;
  assert.ok(Array.isArray(checks), `${label}: missing checks_passed array`);
  for (const check of requiredChecks) {
    assert.ok(checks.includes(check), `${label}: expected checks_passed to include "${check}", got ${JSON.stringify(checks)}`);
  }
}

export function assertSignedBoundary(resp, label) {
  assertSafe(resp, label);
  assertChecksPassed(
    resp,
    ['pubkey_registered', 'action_valid', 'agent_id_matches', 'timestamp_fresh', 'not_duplicate', 'signature_valid'],
    label,
  );
}

export function assertValidPreview(resp, label) {
  assertStatus(resp, 200, label);
  assert.equal(resp.json?.valid, true, `${label}: expected valid=true`);
}

export function assertSuccessfulOpen(resp, label) {
  assertStatus(resp, 200, label);
  assert.equal(resp.json?.success, true, `${label}: expected success=true`);
}

function normalizeAssignedChannel(channel) {
  if (!channel) return null;
  return {
    chan_id: channel.chan_id || channel.channel_id || null,
    channel_point: channel.channel_point || null,
    remote_pubkey: channel.remote_pubkey || null,
    raw: channel,
  };
}

function uniqueName(prefix) {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

export function createCoverageContext({
  baseUrl,
  log = console.log,
  openPeerPubkey = DEFAULT_MARKET_PEER,
  openAmountSats = DEFAULT_OPEN_AMOUNT_SATS,
  fundingTimeoutSecs = DEFAULT_FUNDING_TIMEOUT_SECS,
}) {
  const options = {
    baseUrl,
    openPeerPubkey: openPeerPubkey || DEFAULT_MARKET_PEER,
    openAmountSats,
    fundingTimeoutSecs,
  };

  const state = {
    agents: [],
    keypair: null,
    assignedChannel: null,
  };

  let phaseLog = null;

  async function request(method, path, { body, headers = {}, authAgent = null, quiet = false } = {}) {
    const url = path.startsWith('http') ? path : `${baseUrl}${path}`;
    const requestHeaders = { ...headers };
    if (authAgent != null) {
      const agent = await ensureAgent(authAgent);
      requestHeaders.Authorization = `Bearer ${agent.api_key}`;
    }
    let bodyText;
    if (body !== undefined) {
      requestHeaders['Content-Type'] = 'application/json';
      bodyText = JSON.stringify(body);
    }

    const started = Date.now();
    let res;
    let text = '';
    let json = null;
    try {
      res = await fetch(url, {
        method,
        headers: requestHeaders,
        body: bodyText,
      });
      text = await res.text();
      try { json = JSON.parse(text); } catch {}
    } catch (error) {
      const failure = {
        method,
        path,
        status: 0,
        ms: Date.now() - started,
        text: error.message,
        json: null,
        headers: new Headers(),
        requestBody: body ?? null,
      };
      phaseLog?.push(failure);
      if (!quiet) log(`  ${method} ${path} -> ERR ${failure.ms}ms ${truncate(error.message)}`);
      return failure;
    }

    const response = {
      method,
      path,
      status: res.status,
      ms: Date.now() - started,
      text,
      json,
      headers: res.headers,
      requestBody: body ?? null,
    };
    phaseLog?.push(response);
    if (!quiet) {
      const bytes = Buffer.byteLength(text || '', 'utf8');
      const err = res.status >= 400 ? truncate(json?.error || json?.message || text, 90) : '';
      log(`  ${method} ${path} -> ${res.status} ${response.ms}ms ${bytes}B${err ? ` ${err}` : ''}`);
    }
    return response;
  }

  async function resetRateLimits() {
    await request('POST', '/api/v1/test/reset-rate-limits', { quiet: true });
  }

  async function registerAgent(index = 0, prefix = 'coverage-agent') {
    await resetRateLimits();
    let resp = await request('POST', '/api/v1/agents/register', {
      body: { name: uniqueName(prefix) },
      quiet: true,
    });
    if (resp.status === 429) {
      await resetRateLimits();
      resp = await request('POST', '/api/v1/agents/register', {
        body: { name: uniqueName(prefix) },
        quiet: true,
      });
    }
    assertStatus(resp, 201, `register agent ${index}`);
    state.agents[index] = resp.json;
    return resp.json;
  }

  async function ensureAgent(index = 0) {
    if (!state.agents[index]) {
      await registerAgent(index, index === 0 ? 'coverage-agent' : `coverage-agent-${index}`);
    }
    return state.agents[index];
  }

  async function ensureSecondAgent() {
    return ensureAgent(1);
  }

  async function ensureRegisteredPubkey() {
    const agent = await ensureAgent(0);
    if (state.keypair) return state.keypair;
    state.keypair = generateTestKeypair();
    const resp = await request('PUT', '/api/v1/agents/me', {
      authAgent: 0,
      body: { pubkey: state.keypair.pubHex },
      quiet: true,
    });
    assertStatus(resp, 200, 'register secp256k1 pubkey');
    return { agent, keypair: state.keypair };
  }

  function signInstructionPayload(action, { params = {}, agentIndex = 0, topLevel = {} } = {}) {
    assert.ok(state.keypair, 'signInstructionPayload requires ensureRegisteredPubkey() first');
    const agent = state.agents[agentIndex];
    assert.ok(agent, `signInstructionPayload requires agent ${agentIndex}`);
    const instruction = {
      action,
      agent_id: agent.agent_id,
      timestamp: Math.floor(Date.now() / 1000),
      ...topLevel,
      params,
    };
    return {
      instruction,
      signature: signSecp256k1(instruction, state.keypair.privateKey),
    };
  }

  async function ensureAssignedChannel() {
    await ensureRegisteredPubkey();
    if (state.assignedChannel) return state.assignedChannel;

    let mine = await request('GET', '/api/v1/channels/mine', {
      authAgent: 0,
      quiet: true,
    });
    assertStatus(mine, 200, 'channels/mine bootstrap');
    const existing = normalizeAssignedChannel(mine.json?.channels?.[0]);
    if (existing?.chan_id) {
      state.assignedChannel = existing;
      return existing;
    }
    throw new SkipPhaseError(
      'No assigned channel is available for this agent. The direct harness no longer assigns or mutates live channels.',
    );
  }

  async function waitForManualFunding() {
    throw new SkipPhaseError(
      'Direct manual-funding waits have been removed from the harness. Use the outside-agent lane for real funded channel opens.',
    );
  }

  async function ensureSetup(name) {
    if (name === 'auth') return ensureAgent(0);
    if (name === 'second_agent') return ensureSecondAgent();
    if (name === 'registered_pubkey') return ensureRegisteredPubkey();
    if (name === 'assigned_channel') return ensureAssignedChannel();
    throw new Error(`Unknown coverage setup: ${name}`);
  }

  return {
    options,
    state,
    log,
    setPhaseLog(nextLog) {
      phaseLog = nextLog;
    },
    request,
    resetRateLimits,
    ensureAgent,
    ensureSecondAgent,
    ensureRegisteredPubkey,
    ensureAssignedChannel,
    ensureSetup,
    signInstructionPayload,
    waitForManualFunding,
  };
}
