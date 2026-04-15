#!/usr/bin/env node

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { loadSavedAgent, signInstruction, buildSavedAgentAuth } from './saved-agent.mjs';

const BASE_URL = (process.env.AOL_REPEAT_BASE_URL || process.env.AOL_CANARY_BASE_URL || 'http://127.0.0.1:3302').replace(/\/+$/, '');
const PEER_PUBKEY = `${process.env.AOL_REPEAT_PEER_PUBKEY || ''}`.trim();
const AMOUNT_SATS = Number.parseInt(process.env.AOL_REPEAT_AMOUNT_SATS || '100000', 10);
const OPEN_FOR_REAL = process.env.AOL_REPEAT_DO_OPEN !== '0';

function printUsageAndExit() {
  console.error('Set AOL_REPEAT_PEER_PUBKEY to the peer you want to test.');
  console.error('The saved canary agent must include agent_id and private_key_path metadata.');
  console.error('Optional: AOL_REPEAT_BASE_URL, AOL_REPEAT_AMOUNT_SATS, AOL_REPEAT_DO_OPEN=0');
  process.exitCode = 1;
}

function statusOf(result) {
  return result?.structuredContent?.status ?? null;
}

function bodyOf(result) {
  return result?.structuredContent?.body ?? null;
}

function summarize(label, result) {
  const body = bodyOf(result) || {};
  return {
    step: label,
    status: statusOf(result),
    ok: !result?.isError && (statusOf(result) == null || statusOf(result) < 400),
    message: body.message || body.error || body.learn || null,
    failed_at: body.failed_at || null,
    retry_after_ms: body.retry_after_ms || null,
  };
}

async function main() {
  if (!PEER_PUBKEY) {
    printUsageAndExit();
    return;
  }

  const savedAgent = await loadSavedAgent();
  const client = new Client({ name: 'aol-repeat-open-canary', version: '1.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL('/mcp', BASE_URL));
  let authNonce = 0;

  try {
    await client.connect(transport);
    const listedTools = await client.listTools();
    const toolsRequiringAgentAuth = new Set(
      (listedTools.tools || [])
        .filter((tool) => JSON.stringify(tool.inputSchema || {}).includes('agent_auth'))
        .map((tool) => tool.name),
    );

    async function callTool(name, args = {}) {
      const cleanArgs = { ...(args || {}) };
      if (toolsRequiringAgentAuth.has(name) && !cleanArgs.agent_auth) {
        cleanArgs.agent_auth = await buildSavedAgentAuth(savedAgent, {
          baseUrl: BASE_URL,
          toolName: name,
          args: cleanArgs,
          nonce: `repeat-open-${++authNonce}`,
        });
      }
      return client.callTool({ name, arguments: cleanArgs });
    }

    const balanceResult = await callTool('aol_get_capital_balance');
    const buildResult = await callTool('aol_build_open_channel_instruction', {
      local_funding_amount_sats: AMOUNT_SATS,
      peer_pubkey: PEER_PUBKEY,
    });
    const instruction = buildResult?.structuredContent?.instruction || null;
    const signature = instruction ? await signInstruction(savedAgent, instruction) : null;
    const previewResult = instruction && signature
      ? await callTool('aol_preview_open_channel', { instruction, signature })
      : null;
    const previewBody = bodyOf(previewResult) || {};
    const openResult = OPEN_FOR_REAL && previewResult && !previewResult.isError && (previewBody.valid === true || statusOf(previewResult) === 200)
      ? await callTool('aol_open_channel', { instruction, signature })
      : null;

    console.log(JSON.stringify({
      base_url: BASE_URL,
      peer_pubkey: PEER_PUBKEY,
      amount_sats: AMOUNT_SATS,
      opened_for_real: OPEN_FOR_REAL,
      agent: {
        id: savedAgent.agent_id,
        name: savedAgent.name || null,
        metadata_path: savedAgent.metadata_path,
      },
      steps: [
        summarize('capital_balance', balanceResult),
        summarize('build_open_instruction', buildResult),
        previewResult ? summarize('market_preview', previewResult) : { step: 'market_preview', skipped: true },
        openResult ? summarize('market_open', openResult) : { step: 'market_open', skipped: true },
      ],
      capital_balance: bodyOf(balanceResult),
      preview: bodyOf(previewResult),
      open: bodyOf(openResult),
    }, null, 2));
  } finally {
    await transport.close().catch(() => {});
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
