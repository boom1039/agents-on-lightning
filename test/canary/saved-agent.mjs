import { readFile, readdir } from 'node:fs/promises';
import { createPrivateKey, createSign } from 'node:crypto';
import { resolve } from 'node:path';
import { canonicalJSON } from '../../src/channel-accountability/crypto-utils.js';
import {
  buildToolAuthPayload,
  canonicalAuthJson,
  normalizeSecp256k1DerSignatureToLowS,
} from '../../src/identity/signed-auth.js';

const DEFAULT_ROOT = resolve(process.cwd(), '.local', 'test-agents');

function toAbsolute(path) {
  return resolve(process.cwd(), path);
}

async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'));
}

export async function loadSavedAgent({
  agentId = `${process.env.AOL_CANARY_AGENT_ID || process.env.AOL_REPEAT_AGENT_ID || ''}`.trim(),
  metadataPath = `${process.env.AOL_CANARY_AGENT_METADATA_PATH || process.env.AOL_REPEAT_AGENT_METADATA_PATH || ''}`.trim(),
  rootDir = DEFAULT_ROOT,
} = {}) {
  if (metadataPath) {
    const absoluteMetadataPath = toAbsolute(metadataPath);
    const metadata = await readJson(absoluteMetadataPath);
    return {
      ...metadata,
      metadata_path: absoluteMetadataPath,
      private_key_path: metadata.private_key_path ? toAbsolute(metadata.private_key_path) : null,
    };
  }

  const entries = await readdir(rootDir, { withFileTypes: true }).catch(() => []);
  const candidates = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const absoluteMetadataPath = resolve(rootDir, entry.name, 'agent-metadata.json');
    try {
      const metadata = await readJson(absoluteMetadataPath);
      candidates.push({
        ...metadata,
        metadata_path: absoluteMetadataPath,
        private_key_path: metadata.private_key_path ? toAbsolute(metadata.private_key_path) : null,
      });
    } catch {}
  }

  if (candidates.length === 0) {
    throw new Error('No saved test agent metadata found under .local/test-agents.');
  }

  const sorted = candidates.sort((a, b) => {
    const aTs = Date.parse(a.created_at || 0) || 0;
    const bTs = Date.parse(b.created_at || 0) || 0;
    return bTs - aTs;
  });

  if (agentId) {
    const match = sorted.find((candidate) => candidate.agent_id === agentId);
    if (!match) throw new Error(`Saved test agent ${agentId} was not found under .local/test-agents.`);
    return match;
  }

  return sorted[0];
}

export async function signInstruction(savedAgent, instruction) {
  if (!savedAgent?.private_key_path) {
    throw new Error('Saved test agent is missing private_key_path.');
  }
  const privateKeyPem = await readFile(savedAgent.private_key_path, 'utf8');
  const signer = createSign('SHA256');
  signer.update(canonicalJSON(instruction), 'utf8');
  signer.end();
  const normalized = normalizeSecp256k1DerSignatureToLowS(signer.sign(createPrivateKey(privateKeyPem)).toString('hex'));
  if (!normalized.ok) throw new Error(normalized.message || 'Could not normalize channel instruction signature.');
  return normalized.signature;
}

export async function buildSavedAgentAuth(savedAgent, { baseUrl, toolName, args, nonce }) {
  if (!savedAgent?.agent_id) throw new Error('Saved test agent is missing agent_id.');
  if (!savedAgent?.private_key_path) throw new Error('Saved test agent is missing private_key_path.');
  const privateKeyPem = await readFile(savedAgent.private_key_path, 'utf8');
  const payload = buildToolAuthPayload({
    audience: `${String(baseUrl).replace(/\/+$/, '')}/mcp`,
    agentId: savedAgent.agent_id,
    toolName,
    args,
    timestamp: Math.floor(Date.now() / 1000),
    nonce,
  });
  const signer = createSign('SHA256');
  signer.update(canonicalAuthJson(payload), 'utf8');
  signer.end();
  const normalized = normalizeSecp256k1DerSignatureToLowS(signer.sign(createPrivateKey(privateKeyPem)).toString('hex'));
  if (!normalized.ok) throw new Error(normalized.message || 'Could not normalize agent_auth signature.');
  return {
    agent_id: savedAgent.agent_id,
    timestamp: payload.timestamp,
    nonce: payload.nonce,
    signature: normalized.signature,
  };
}
