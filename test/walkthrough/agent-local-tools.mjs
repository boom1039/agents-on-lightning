import { generateTestKeypair, signInstruction } from '../../src/channel-accountability/test-crypto-helpers.js';

const DEFAULT_KEY_NAME = 'agent-signing-key';

function nowUnixSeconds() {
  return Math.floor(Date.now() / 1000);
}

function parsePath(url, baseUrl) {
  try {
    return new URL(url, baseUrl || 'http://localhost').pathname;
  } catch {
    return String(url || '').split('?')[0];
  }
}

function parseBearer(headers) {
  if (!headers || typeof headers !== 'object') return null;
  for (const [key, value] of Object.entries(headers)) {
    if (String(key).toLowerCase() === 'authorization') {
      const match = String(value || '').match(/^Bearer\s+(.+)$/i);
      return match ? match[1].trim() : null;
    }
  }
  return null;
}

function parseBody(body) {
  if (body == null) return null;
  if (typeof body === 'string') {
    try {
      return JSON.parse(body);
    } catch {
      return null;
    }
  }
  if (typeof body === 'object') return body;
  return null;
}

function normalizeAssignedChannel(channel) {
  if (!channel || typeof channel !== 'object') return null;
  return {
    chan_id: channel.chan_id || channel.channel_id || null,
    channel_point: channel.channel_point || null,
    remote_pubkey: channel.remote_pubkey || null,
  };
}

export const AGENT_LOCAL_TOOLS = [
  {
    name: 'get_unix_time',
    description: 'Get the current Unix time in whole seconds for signed HTTP payloads.',
    parameters: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: 'generate_secp256k1_keypair',
    description: 'Create or reuse a local secp256k1 signing keypair. Use the returned compressed pubkey in PUT /api/v1/agents/me.',
    parameters: {
      type: 'object',
      properties: {
        key_name: { type: 'string', description: 'Optional stable local name for this keypair.' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'build_signed_instruction',
    description: 'Build and sign a request body shaped like { instruction, signature } using a local secp256k1 keypair and the current Unix time.',
    parameters: {
      type: 'object',
      properties: {
        key_name: { type: 'string', description: 'Local keypair name returned by generate_secp256k1_keypair.' },
        instruction: { type: 'object', description: 'Optional full instruction object to sign as-is.' },
        action: { type: 'string', description: 'Instruction action, for example channel_open, channel_close, rebalance, or set_fee_policy.' },
        agent_id: { type: 'string', description: 'Authenticated agent_id to place inside instruction.agent_id.' },
        channel_id: { type: 'string', description: 'Optional top-level instruction.channel_id. For channel preview/instruct, use the real chan_id from GET /api/v1/channels/mine.' },
        channel_point: { type: 'string', description: 'Optional top-level instruction.channel_point when a signed route needs it.' },
        base_fee_msat: { type: 'number', description: 'Optional helper shorthand for instruction.params.base_fee_msat.' },
        fee_rate_ppm: { type: 'number', description: 'Optional helper shorthand for instruction.params.fee_rate_ppm.' },
        params: { type: 'object', description: 'Instruction params object.' },
        top_level: { type: 'object', description: 'Optional extra top-level instruction fields like channel_id or channel_point.' },
      },
      required: ['action', 'agent_id'],
      additionalProperties: false,
    },
  },
];

export function createAgentLocalToolContext({
  baseUrl,
  requestHttp,
}) {
  const keypairs = new Map();
  const agentsById = new Map();
  let latestAgentId = null;
  let assignedChannel = null;
  let lastKeyName = DEFAULT_KEY_NAME;

  function ensureKeypair(rawName) {
    const keyName = String(rawName || lastKeyName || DEFAULT_KEY_NAME).trim() || DEFAULT_KEY_NAME;
    if (!keypairs.has(keyName)) {
      keypairs.set(keyName, generateTestKeypair());
    }
    lastKeyName = keyName;
    return { keyName, keypair: keypairs.get(keyName) };
  }

  async function executeTool(name, input = {}) {
    if (name === 'get_unix_time') {
      return { ok: true, unix_seconds: nowUnixSeconds() };
    }

    if (name === 'generate_secp256k1_keypair') {
      const { keyName, keypair } = ensureKeypair(input.key_name);
      return {
        ok: true,
        key_name: keyName,
        pubkey: keypair.pubHex,
      };
    }

    if (name === 'build_signed_instruction') {
      const { keyName, keypair } = ensureKeypair(input.key_name);
      const providedInstruction = input.instruction && typeof input.instruction === 'object'
        ? { ...input.instruction }
        : null;
      const instruction = providedInstruction || {
        action: input.action,
        agent_id: input.agent_id,
        ...(input.top_level && typeof input.top_level === 'object' ? input.top_level : {}),
        params: input.params && typeof input.params === 'object' ? input.params : {},
      };
      if (!instruction.action && input.action) instruction.action = input.action;
      if (!instruction.agent_id && input.agent_id) instruction.agent_id = input.agent_id;
      if (!instruction.channel_id && input.channel_id) instruction.channel_id = input.channel_id;
      if (!instruction.channel_point && input.channel_point) instruction.channel_point = input.channel_point;
      if ((instruction.params == null || typeof instruction.params !== 'object') && input.params && typeof input.params === 'object') {
        instruction.params = input.params;
      }
      if (instruction.params == null || typeof instruction.params !== 'object') {
        instruction.params = {};
      }
      if (input.base_fee_msat !== undefined && instruction.params.base_fee_msat === undefined) {
        instruction.params.base_fee_msat = input.base_fee_msat;
      }
      if (input.fee_rate_ppm !== undefined && instruction.params.fee_rate_ppm === undefined) {
        instruction.params.fee_rate_ppm = input.fee_rate_ppm;
      }
      if (input.top_level && typeof input.top_level === 'object') {
        Object.assign(instruction, input.top_level);
      }
      if (!Number.isFinite(instruction.timestamp)) {
        instruction.timestamp = nowUnixSeconds();
      }
      return {
        ok: true,
        key_name: keyName,
        pubkey: keypair.pubHex,
        instruction,
        signature: signInstruction(instruction, keypair.privateKey),
      };
    }

    return { ok: false, error: `Unknown local tool: ${name}` };
  }

  function observeHttp(request, response) {
    const path = parsePath(request.url, baseUrl);
    const body = parseBody(request.body);
    if (request.method === 'POST' && path === '/api/v1/agents/register' && response.status === 201) {
      const agentId = response.parsed?.agent_id;
      const apiKey = response.parsed?.api_key;
      if (agentId && apiKey) {
        const existing = agentsById.get(agentId) || {};
        agentsById.set(agentId, {
          ...existing,
          agent_id: agentId,
          api_key: apiKey,
        });
        latestAgentId = agentId;
      }
      return;
    }

    if (request.method === 'PUT' && path === '/api/v1/agents/me' && response.status === 200) {
      const apiKey = parseBearer(request.headers);
      const pubkey = body?.pubkey || response.parsed?.pubkey || null;
      if (!apiKey || !pubkey) return;
      for (const agent of agentsById.values()) {
        if (agent.api_key !== apiKey) continue;
        agent.pubkey = pubkey;
        latestAgentId = agent.agent_id;
        break;
      }
      return;
    }

    if (request.method === 'GET' && path === '/api/v1/channels/mine' && response.status === 200) {
      assignedChannel = normalizeAssignedChannel(response.parsed?.channels?.[0]) || assignedChannel;
    }
  }

  return {
    tools: AGENT_LOCAL_TOOLS,
    executeTool,
    observeHttp,
    getState() {
      return {
        latestAgentId,
        assignedChannel,
        agents: [...agentsById.values()].map(agent => ({
          agent_id: agent.agent_id,
          has_api_key: Boolean(agent.api_key),
          has_pubkey: Boolean(agent.pubkey),
        })),
      };
    },
  };
}
