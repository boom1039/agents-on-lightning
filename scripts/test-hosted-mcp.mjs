import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createSign, generateKeyPairSync } from 'node:crypto';
import { canonicalJSON } from '../src/channel-accountability/crypto-utils.js';
import { MCP_TOOL_NAMES, MCP_TOOL_SPECS, PUBLIC_MCP_DOC_PATHS } from '../src/mcp/catalog.js';
import {
  buildSignedToolCallPayload,
  canonicalAuthJson,
  normalizeSecp256k1DerSignatureToLowS,
} from '../src/identity/signed-auth.js';

const baseUrl = process.env.AOL_MCP_BASE_URL || 'http://127.0.0.1:3302';
const requiredPrompts = ['start_here'];

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

async function fetchJson(pathname) {
  const response = await fetch(new URL(pathname, baseUrl));
  const body = await response.json();
  assert(response.ok, `GET ${pathname} failed with ${response.status}`);
  return body;
}

async function fetchStatus(pathname) {
  const response = await fetch(new URL(pathname, baseUrl), {
    headers: { 'user-agent': 'aol-mcp-smoke' },
  });
  await response.arrayBuffer();
  return response.status;
}

function getStructuredBody(result) {
  return result?.structuredContent?.body || null;
}

function getStructuredStatus(result) {
  return result?.structuredContent?.status ?? null;
}

function getSavedValues(result) {
  return result?.structuredContent?.saved_values || {};
}

function expectStatus(result, expectedStatus, label) {
  const actual = getStructuredStatus(result);
  assert(actual === expectedStatus, `${label} returned ${actual}, expected ${expectedStatus}`);
}

function expectOneOfStatuses(result, expectedStatuses, label) {
  const actual = getStructuredStatus(result);
  assert(expectedStatuses.includes(actual), `${label} returned ${actual}, expected one of ${expectedStatuses.join(', ')}`);
}

function expectSavedValue(result, key, label) {
  const savedValues = getSavedValues(result);
  const value = savedValues?.[key];
  assert(typeof value === 'string' && value.length > 0, `${label} did not return saved_values.${key}`);
  return value;
}

function publicKeyToCompressedHex(publicKey) {
  const jwk = publicKey.export({ format: 'jwk' });
  const x = Buffer.from(jwk.x, 'base64url');
  const y = Buffer.from(jwk.y, 'base64url');
  return `${(y[y.length - 1] & 1) ? '03' : '02'}${x.toString('hex')}`;
}

function signLowS(privateKey, payload) {
  const signer = createSign('SHA256');
  signer.update(payload, 'utf8');
  signer.end();
  const normalized = normalizeSecp256k1DerSignatureToLowS(signer.sign(privateKey).toString('hex'));
  assert(normalized.ok, normalized.message || 'Could not normalize secp256k1 signature');
  return normalized.signature;
}

function expectInstructionShape(result, expectedAction, label) {
  const instruction = result?.structuredContent?.instruction;
  const signingPayload = result?.structuredContent?.signing_payload;
  assert(instruction && typeof instruction === 'object', `${label} did not return instruction`);
  assert(instruction.action === expectedAction, `${label} returned wrong action`);
  assert(Number.isInteger(instruction.timestamp), `${label} timestamp is not an integer`);
  assert(instruction.timestamp < 10_000_000_000, `${label} timestamp looks like milliseconds, not seconds`);
  assert(signingPayload === canonicalJSON(instruction), `${label} signing_payload is not canonical JSON`);
}

function expectNodeAnalysisBoundary(result, label) {
  const actual = getStructuredStatus(result);
  const body = getStructuredBody(result) || {};
  const noNode = actual === 200 && body.error === 'No LND node connected';
  const missingNode = actual === 404;
  assert(noNode || missingNode, `${label} returned unexpected status ${actual}`);
}

function expectCapitalDepositBoundary(result, label) {
  const actual = getStructuredStatus(result);
  const body = getStructuredBody(result) || {};
  const missingWalletNode = actual === 503 && body.error === 'service_unavailable';
  assert(missingWalletNode, `${label} returned unexpected status ${actual}`);
}

function getToolNames(listResult) {
  return (listResult?.tools || []).map((tool) => tool.name);
}

function getPromptNames(listResult) {
  return (listResult?.prompts || []).map((prompt) => prompt.name);
}

function getResourceUris(listResult) {
  return (listResult?.resources || []).map((resource) => resource.uri);
}

const manifest = await fetchJson('/.well-known/mcp.json');
assert(manifest.transport?.endpoint === '/mcp', 'Hosted MCP manifest is missing /mcp endpoint');
assert(manifest.transport?.type === 'streamable-http', 'Hosted MCP manifest transport type is wrong');
assert(manifest.server_card === `${baseUrl}/.well-known/mcp/server-card.json`, 'Hosted MCP manifest is missing server_card');
assert(Array.isArray(manifest.tools) && manifest.tools.includes('dynamic'), 'Hosted MCP manifest tools should be dynamic');
assert(Array.isArray(manifest.prompts) && manifest.prompts.includes('dynamic'), 'Hosted MCP manifest prompts should be dynamic');
assert(
  JSON.stringify(manifest.tool_summaries || []) === JSON.stringify(MCP_TOOL_SPECS),
  'Hosted MCP manifest tool summaries do not match catalog.js',
);
const serverCard = await fetchJson('/.well-known/mcp/server-card.json');
assert(serverCard?.$schema == null || /^https:\/\//.test(serverCard.$schema), 'Server card schema must be absent or a valid HTTPS URL');
assert(serverCard?.protocolVersion === '2025-06-18', 'Server card protocolVersion is wrong');
assert(serverCard?.serverInfo?.name === 'agents-on-lightning-mcp', 'Server card serverInfo.name is wrong');
assert(serverCard?.transport?.endpoint === '/mcp', 'Server card transport endpoint is wrong');
assert(Array.isArray(serverCard?.tools) && serverCard.tools.includes('dynamic'), 'Server card tools should be dynamic');
assert(serverCard?.start === '/llms.txt', 'Server card start doc is missing');
const agentCard = await fetchJson('/.well-known/agent-card.json');
assert(agentCard?.name === 'Agents on Lightning', 'Agent card name is wrong');
assert(agentCard?.version === '1.0.0', 'Agent card version is wrong');
assert(agentCard?.documentationUrl === `${baseUrl}/llms.txt`, 'Agent card docs URL is wrong');
assert(agentCard?.supportedInterfaces?.[0]?.url === `${baseUrl}/mcp`, 'Agent card MCP interface is missing');
assert((agentCard?.skills || []).some((skill) => skill.id === 'use-hosted-mcp'), 'Agent card skills are missing');
assert((agentCard?.skills || []).some((skill) => skill.id === 'earn-routing-fees'), 'Agent card is missing routing-fee skill');
assert(agentCard?.capabilities?.zeroCommissions === true, 'Agent card is missing zeroCommissions capability');

const client = new Client({
  name: 'aol-mcp-smoke',
  version: '1.0.0',
});
const transport = new StreamableHTTPClientTransport(new URL('/mcp', baseUrl));

try {
  await client.connect(transport);

  const tools = await client.listTools();
  const prompts = await client.listPrompts();
  const resources = await client.listResources();

  const toolNames = getToolNames(tools);
  const promptNames = getPromptNames(prompts);
  const resourceUris = getResourceUris(resources);

  assert(
    JSON.stringify([...toolNames].sort()) === JSON.stringify([...MCP_TOOL_NAMES].sort()),
    'Hosted MCP tool list does not match catalog.js',
  );
  for (const toolName of MCP_TOOL_NAMES) {
    assert(toolNames.includes(toolName), `Missing MCP tool ${toolName}`);
  }
  const toolsByName = new Map((tools.tools || []).map((tool) => [tool.name, tool]));
  for (const spec of MCP_TOOL_SPECS) {
    assert(toolsByName.get(spec.name)?.description === spec.description, `MCP tool ${spec.name} description does not match catalog.js`);
  }
  const toolsRequiringAgentAuth = new Set(
    (tools.tools || [])
      .filter((tool) => JSON.stringify(tool.inputSchema || {}).includes('agent_auth'))
      .map((tool) => tool.name),
  );
  let signedAgent = null;
  let authNonce = 0;
  const rawCallTool = client.callTool.bind(client);
  client.callTool = async ({ name, arguments: toolArgs = {} }) => {
    const cleanArgs = { ...(toolArgs || {}) };
    if (signedAgent && toolsRequiringAgentAuth.has(name) && !cleanArgs.agent_auth) {
      const payload = buildSignedToolCallPayload({
        audience: `${baseUrl}/mcp`,
        agentId: signedAgent.agentId,
        toolName: name,
        args: cleanArgs,
        timestamp: Math.floor(Date.now() / 1000),
        nonce: `hosted-smoke-${++authNonce}`,
      });
      cleanArgs.agent_auth = {
        agent_id: signedAgent.agentId,
        timestamp: payload.timestamp,
        nonce: payload.nonce,
        signature: signLowS(signedAgent.privateKey, canonicalAuthJson(payload)),
      };
    }
    return rawCallTool({ name, arguments: cleanArgs });
  };
  for (const promptName of requiredPrompts) {
    assert(promptNames.includes(promptName), `Missing MCP prompt ${promptName}`);
  }
  for (const docPath of PUBLIC_MCP_DOC_PATHS) {
    assert(resourceUris.some((uri) => uri.endsWith(docPath)), `Missing MCP resource ${docPath}`);
  }
  assert(resourceUris.includes('mcp://server-card.json'), 'Missing MCP server-card resource');

  if (process.env.AOL_EXPECT_MCP_ONLY === '1') {
    assert(await fetchStatus('/api/v1/') === 404, 'MCP-only mode did not hide /api/v1/');
    assert(await fetchStatus('/docs/agent-route-schema.md') === 404, 'MCP-only mode did not hide non-MCP docs');
    for (const docPath of PUBLIC_MCP_DOC_PATHS) {
      assert(await fetchStatus(docPath) === 200, `MCP-only mode did not keep ${docPath} public`);
    }
  }

  const startPrompt = await client.getPrompt({
    name: 'start_here',
    arguments: {},
  });
  assert(startPrompt?.messages?.length > 0, 'start_here prompt returned no content');

  const rootResult = await client.callTool({
    name: 'aol_get_root',
    arguments: {},
  });
  assert(!rootResult?.isError, 'aol_get_root failed');

  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'secp256k1' });
  const pubkey = publicKeyToCompressedHex(publicKey);
  const registrationName = `mcp-smoke-${Date.now()}`;
  const registrationPayload = await client.callTool({
    name: 'aol_build_registration_payload',
    arguments: {
      name: registrationName,
      pubkey,
      framework: 'MCP smoke',
      description: 'Hosted MCP smoke test agent.',
    },
  });
  assert(!registrationPayload?.isError, 'aol_build_registration_payload failed');
  const registrationBody = registrationPayload?.structuredContent || {};
  const registerArgs = registrationBody?.next_call?.arguments_template || {};
  const registerResult = await client.callTool({
    name: 'aol_register_agent',
    arguments: {
      ...registerArgs,
      registration_auth: {
        ...registerArgs.registration_auth,
        signature: signLowS(privateKey, registrationBody.signing_payload),
      },
    },
  });
  assert(!registerResult?.isError, 'aol_register_agent failed');

  const registerBody = getStructuredBody(registerResult);
  const agentId = registerBody?.agent_id || getSavedValues(registerResult)?.agent_id;
  assert(typeof agentId === 'string' && agentId.length > 3, 'Registration did not return agent_id');
  signedAgent = { agentId, privateKey };

  const meResult = await client.callTool({
    name: 'aol_get_me',
    arguments: {
    },
  });
  assert(!meResult?.isError, 'aol_get_me failed');

  const updateResult = await client.callTool({
    name: 'aol_update_me',
    arguments: {
      description: 'Hosted MCP smoke test agent.',
      framework: 'MCP smoke',
    },
  });
  assert(!updateResult?.isError, 'aol_update_me failed');

  const strategyResult = await client.callTool({
    name: 'aol_get_strategy',
    arguments: {
      strategy: 'geographic-arbitrage',
    },
  });
  assert(!strategyResult?.isError, 'aol_get_strategy failed');
  expectStatus(strategyResult, 200, 'aol_get_strategy');

  const agentProfileResult = await client.callTool({
    name: 'aol_get_agent_profile',
    arguments: {
      id: agentId,
    },
  });
  assert(!agentProfileResult?.isError, 'aol_get_agent_profile failed');
  expectStatus(agentProfileResult, 200, 'aol_get_agent_profile');

  const agentActivityResult = await client.callTool({
    name: 'aol_get_agent_activity',
    arguments: {
      id: agentId,
      limit: 5,
    },
  });
  assert(!agentActivityResult?.isError, 'aol_get_agent_activity failed');
  expectStatus(agentActivityResult, 200, 'aol_get_agent_activity');

  const walletResult = await client.callTool({
    name: 'aol_get_wallet_balance',
    arguments: {
    },
  });
  assert(!walletResult?.isError, 'aol_get_wallet_balance failed');

  const walletMintQuoteHelp = await client.callTool({
    name: 'aol_get_wallet_mint_quote_help',
    arguments: {
    },
  });
  expectStatus(walletMintQuoteHelp, 200, 'aol_get_wallet_mint_quote_help');

  const walletMintQuoteResult = await client.callTool({
    name: 'aol_create_wallet_mint_quote',
    arguments: {
      amount_sats: 1000,
    },
  });
  const walletMintQuoteStatus = getStructuredStatus(walletMintQuoteResult);
  if (walletMintQuoteStatus === 200) {
    assert(!walletMintQuoteResult?.isError, 'aol_create_wallet_mint_quote failed');
    const mintQuoteId = expectSavedValue(walletMintQuoteResult, 'quote_id', 'aol_create_wallet_mint_quote');
    expectSavedValue(walletMintQuoteResult, 'invoice', 'aol_create_wallet_mint_quote');

    const walletCheckMintQuoteResult = await client.callTool({
      name: 'aol_check_wallet_mint_quote',
      arguments: {
        quote: mintQuoteId,
      },
    });
    assert(!walletCheckMintQuoteResult?.isError, 'aol_check_wallet_mint_quote failed');
    expectStatus(walletCheckMintQuoteResult, 200, 'aol_check_wallet_mint_quote');
  } else {
    expectOneOfStatuses(walletMintQuoteResult, [400, 409, 503], 'aol_create_wallet_mint_quote safe blocker');
    const body = getStructuredBody(walletMintQuoteResult) || {};
    const safeBlocker = [
      'wallet_mint_receive_preflight_failed',
      'validation_error',
      'service_unavailable',
    ].includes(body.error);
    assert(safeBlocker, `aol_create_wallet_mint_quote returned unsafe blocker: ${body.error || 'missing error'}`);
  }

  const walletRestore = await client.callTool({
    name: 'aol_restore_wallet',
    arguments: {
    },
  });
  expectStatus(walletRestore, 200, 'aol_restore_wallet');

  const walletReclaim = await client.callTool({
    name: 'aol_reclaim_wallet_pending',
    arguments: {
    },
  });
  expectStatus(walletReclaim, 200, 'aol_reclaim_wallet_pending');

  const capitalResult = await client.callTool({
    name: 'aol_get_capital_balance',
    arguments: {
    },
  });
  assert(!capitalResult?.isError, 'aol_get_capital_balance failed');

  const dashboardResult = await client.callTool({
    name: 'aol_get_me_dashboard',
    arguments: {
    },
  });
  assert(!dashboardResult?.isError, 'aol_get_me_dashboard failed');

  const capitalDepositResult = await client.callTool({
    name: 'aol_create_onchain_capital_deposit',
    arguments: {
    },
  });
  assert(!capitalDepositResult?.isError, 'aol_create_onchain_capital_deposit failed');
  if (baseUrl.startsWith('http://127.0.0.1')) {
    const depositStatus = getStructuredStatus(capitalDepositResult);
    if (depositStatus === 200) {
      expectSavedValue(capitalDepositResult, 'onchain_address', 'aol_create_onchain_capital_deposit');
    } else {
      expectCapitalDepositBoundary(capitalDepositResult, 'aol_create_onchain_capital_deposit');
    }
  } else {
    expectStatus(capitalDepositResult, 200, 'aol_create_onchain_capital_deposit');
    expectSavedValue(capitalDepositResult, 'onchain_address', 'aol_create_onchain_capital_deposit');
  }
  const capitalWithdrawAddress = getSavedValues(capitalDepositResult).onchain_address || 'bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh';

  const capitalWithdrawResult = await client.callTool({
    name: 'aol_withdraw_capital',
    arguments: {
      amount_sats: 1000,
      destination_address: capitalWithdrawAddress,
    },
  });
  expectOneOfStatuses(capitalWithdrawResult, [400, 200, 503], 'aol_withdraw_capital');

  const fakePubkey = `02${'1'.repeat(64)}`;
  const nodeAnalysisResult = await client.callTool({
    name: 'aol_get_node_analysis',
    arguments: {
      pubkey: fakePubkey,
    },
  });
  assert(!nodeAnalysisResult?.isError, 'aol_get_node_analysis failed');
  expectNodeAnalysisBoundary(nodeAnalysisResult, 'aol_get_node_analysis');

  const suggestPeersResult = await client.callTool({
    name: 'aol_suggest_peers',
    arguments: {
      pubkey: fakePubkey,
    },
  });
  assert(!suggestPeersResult?.isError, 'aol_suggest_peers failed');
  expectNodeAnalysisBoundary(suggestPeersResult, 'aol_suggest_peers');

  const peerSafetyResult = await client.callTool({
    name: 'aol_get_peer_safety',
    arguments: {
      pubkey: fakePubkey,
    },
  });
  assert(!peerSafetyResult?.isError, 'aol_get_peer_safety failed');
  expectStatus(peerSafetyResult, 200, 'aol_get_peer_safety');

  const marketConfigResult = await client.callTool({
    name: 'aol_get_market_config',
    arguments: {},
  });
  assert(!marketConfigResult?.isError, 'aol_get_market_config failed');

  const swapCreateResult = await client.callTool({
    name: 'aol_create_swap_to_onchain',
    arguments: {
      amount_sats: 50000,
      onchain_address: capitalWithdrawAddress,
    },
  });
  expectOneOfStatuses(swapCreateResult, [400, 200, 503], 'aol_create_swap_to_onchain');

  const swapStatusResult = await client.callTool({
    name: 'aol_get_swap_status',
    arguments: {
      swap_id: 'swap-missing',
    },
  });
  expectStatus(swapStatusResult, 404, 'aol_get_swap_status');

  const ecashFundResult = await client.callTool({
    name: 'aol_fund_channel_from_ecash',
    arguments: {
      instruction: {
        action: 'channel_open',
        agent_id: 'missing-agent',
        params: {
          local_funding_amount_sats: 100000,
          peer_pubkey: `02${'1'.repeat(64)}`,
        },
        timestamp: Math.floor(Date.now() / 1000),
      },
      signature: '00',
    },
  });
  const ecashFundStatus = getStructuredStatus(ecashFundResult);
  assert([400, 401, 402, 503].includes(ecashFundStatus), `aol_fund_channel_from_ecash returned ${ecashFundStatus}`);

  const ecashFlowStatusResult = await client.callTool({
    name: 'aol_get_ecash_funding_status',
    arguments: {
      flow_id: 'flow-missing',
    },
  });
  expectStatus(ecashFlowStatusResult, 404, 'aol_get_ecash_funding_status');

  const marketPreviewHelp = await client.callTool({
    name: 'aol_get_market_preview_help',
    arguments: {
    },
  });
  expectStatus(marketPreviewHelp, 200, 'aol_get_market_preview_help');

  const marketOpenHelp = await client.callTool({
    name: 'aol_get_market_open_help',
    arguments: {
    },
  });
  expectStatus(marketOpenHelp, 200, 'aol_get_market_open_help');

  const channelsAuditResult = await client.callTool({
    name: 'aol_get_channels_audit',
    arguments: {},
  });
  assert(!channelsAuditResult?.isError, 'aol_get_channels_audit failed');
  const auditEntries = getStructuredBody(channelsAuditResult)?.entries || [];
  const realAuditChannelId = auditEntries.find((entry) => entry?.chan_id)?.chan_id || null;
  if (realAuditChannelId) {
    const channelAuditResult = await client.callTool({
      name: 'aol_get_channel_audit',
      arguments: {
        channel_point: realAuditChannelId,
      },
    });
    assert(!channelAuditResult?.isError, 'aol_get_channel_audit failed');
    expectStatus(channelAuditResult, 200, 'aol_get_channel_audit');

    const channelVerifyResult = await client.callTool({
      name: 'aol_get_channel_verify',
      arguments: {
        channel_point: realAuditChannelId,
      },
    });
    assert(!channelVerifyResult?.isError, 'aol_get_channel_verify failed');
    expectStatus(channelVerifyResult, 200, 'aol_get_channel_verify');
  }

  const marketPerformanceResult = await client.callTool({
    name: 'aol_get_market_performance',
    arguments: {
    },
  });
  assert(!marketPerformanceResult?.isError, 'aol_get_market_performance failed');

  const refreshedAgentProfileResult = await client.callTool({
    name: 'aol_get_agent_profile',
    arguments: {
      id: agentId,
    },
  });
  assert(!refreshedAgentProfileResult?.isError, 'aol_get_agent_profile failed');
  expectStatus(refreshedAgentProfileResult, 200, 'aol_get_agent_profile');

  const openInstruction = await client.callTool({
    name: 'aol_build_open_channel_instruction',
    arguments: {
      local_funding_amount_sats: 100000,
      peer_pubkey: '02'.padEnd(66, '1'),
    },
  });
  assert(!openInstruction?.isError, 'aol_build_open_channel_instruction failed');
  expectInstructionShape(openInstruction, 'channel_open', 'aol_build_open_channel_instruction');

  const closeInstruction = await client.callTool({
    name: 'aol_build_close_channel_instruction',
    arguments: {
      channel_point: 'deadbeef:0',
    },
  });
  assert(!closeInstruction?.isError, 'aol_build_close_channel_instruction failed');
  expectInstructionShape(closeInstruction, 'channel_close', 'aol_build_close_channel_instruction');

  const marketCloseHelp = await client.callTool({
    name: 'aol_get_market_close_help',
    arguments: {
    },
  });
  expectStatus(marketCloseHelp, 200, 'aol_get_market_close_help');

  const policyInstruction = await client.callTool({
    name: 'aol_build_channel_policy_instruction',
    arguments: {
      channel_id: '12345',
      fee_rate_ppm: 120,
    },
  });
  assert(!policyInstruction?.isError, 'aol_build_channel_policy_instruction failed');
  expectInstructionShape(policyInstruction, 'set_fee_policy', 'aol_build_channel_policy_instruction');

  const rebalanceInstruction = await client.callTool({
    name: 'aol_build_rebalance_instruction',
    arguments: {
      outbound_chan_id: '12345',
      amount_sats: 10000,
      max_fee_sats: 10,
    },
  });
  assert(!rebalanceInstruction?.isError, 'aol_build_rebalance_instruction failed');
  expectInstructionShape(rebalanceInstruction, 'rebalance', 'aol_build_rebalance_instruction');

  console.log(JSON.stringify({
    ok: true,
    base_url: baseUrl,
    tools: toolNames.length,
    prompts: promptNames.length,
    resources: resourceUris.length,
    registered_agent: registerBody?.agent_id || null,
  }, null, 2));
} finally {
  await transport.close().catch(() => {});
}
