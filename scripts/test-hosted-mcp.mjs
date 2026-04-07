import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const baseUrl = process.env.AOL_MCP_BASE_URL || 'http://127.0.0.1:3302';
const requiredTools = [
  'aol_get_root',
  'aol_get_health',
  'aol_get_llms',
  'aol_get_mcp_manifest',
  'aol_get_api_root',
  'aol_list_skills',
  'aol_get_platform_status',
  'aol_get_market_config',
  'aol_register_agent',
  'aol_update_me',
  'aol_get_me',
  'aol_get_agent_profile',
  'aol_get_agent_lineage',
  'aol_get_strategy',
  'aol_get_wallet_mint_quote_help',
  'aol_create_wallet_mint_quote',
  'aol_check_wallet_mint_quote',
  'aol_try_wallet_deposit',
  'aol_try_wallet_withdraw',
  'aol_restore_wallet',
  'aol_reclaim_wallet_pending',
  'aol_test_node_connection',
  'aol_connect_node',
  'aol_create_capital_deposit',
  'aol_withdraw_capital',
  'aol_build_open_channel_instruction',
  'aol_get_market_preview_help',
  'aol_get_market_open_help',
  'aol_build_close_channel_instruction',
  'aol_get_market_close_help',
  'aol_build_channel_policy_instruction',
  'aol_build_rebalance_instruction',
  'aol_get_channels_audit',
  'aol_get_market_performance',
  'aol_get_market_agent',
  'aol_get_channel_audit',
  'aol_get_channel_verify',
  'aol_create_lightning_to_onchain_swap',
  'aol_fund_channel_from_ecash',
];
const requiredPrompts = ['start_here', 'register_and_profile', 'inspect_market'];

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

function expectSavedValue(result, key, label) {
  const savedValues = getSavedValues(result);
  const value = savedValues?.[key];
  assert(typeof value === 'string' && value.length > 0, `${label} did not return saved_values.${key}`);
  return value;
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
assert(Array.isArray(manifest.tools) && manifest.tools.length >= requiredTools.length, 'Hosted MCP manifest is missing tools');
assert(Array.isArray(manifest.prompts) && manifest.prompts.length >= requiredPrompts.length, 'Hosted MCP manifest is missing prompts');

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

  for (const toolName of requiredTools) {
    assert(toolNames.includes(toolName), `Missing MCP tool ${toolName}`);
  }
  for (const promptName of requiredPrompts) {
    assert(promptNames.includes(promptName), `Missing MCP prompt ${promptName}`);
  }
  assert(resourceUris.some((uri) => uri.endsWith('/docs/mcp/index.txt')), 'Missing MCP index resource');

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

  const registerResult = await client.callTool({
    name: 'aol_register_agent',
    arguments: {
      name: `mcp-smoke-${Date.now()}`,
    },
  });
  assert(!registerResult?.isError, 'aol_register_agent failed');

  const registerBody = getStructuredBody(registerResult);
  const apiKey = registerBody?.api_key || getSavedValues(registerResult)?.api_key;
  const agentId = registerBody?.agent_id || getSavedValues(registerResult)?.agent_id;
  assert(typeof apiKey === 'string' && apiKey.length > 10, 'Registration did not return api_key');
  assert(typeof agentId === 'string' && agentId.length > 3, 'Registration did not return agent_id');

  const meResult = await client.callTool({
    name: 'aol_get_me',
    arguments: {
      api_key: apiKey,
    },
  });
  assert(!meResult?.isError, 'aol_get_me failed');

  const updateResult = await client.callTool({
    name: 'aol_update_me',
    arguments: {
      api_key: apiKey,
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

  const agentLineageResult = await client.callTool({
    name: 'aol_get_agent_lineage',
    arguments: {
      id: agentId,
    },
  });
  assert(!agentLineageResult?.isError, 'aol_get_agent_lineage failed');
  expectStatus(agentLineageResult, 200, 'aol_get_agent_lineage');

  const walletResult = await client.callTool({
    name: 'aol_get_wallet_balance',
    arguments: {
      api_key: apiKey,
    },
  });
  assert(!walletResult?.isError, 'aol_get_wallet_balance failed');

  const llmsMcpResult = await client.callTool({
    name: 'aol_get_llms_mcp',
    arguments: {},
  });
  assert(!llmsMcpResult?.isError, 'aol_get_llms_mcp failed');
  expectStatus(llmsMcpResult, 200, 'aol_get_llms_mcp');

  const actionResult = await client.callTool({
    name: 'aol_submit_action',
    arguments: {
      api_key: apiKey,
      action: 'inspect_market',
      description: 'Hosted MCP smoke action.',
    },
  });
  assert(!actionResult?.isError, 'aol_submit_action failed');
  expectStatus(actionResult, 201, 'aol_submit_action');

  const walletMintQuoteHelp = await client.callTool({
    name: 'aol_get_wallet_mint_quote_help',
    arguments: {
      api_key: apiKey,
    },
  });
  expectStatus(walletMintQuoteHelp, 405, 'aol_get_wallet_mint_quote_help');

  const walletMintQuoteResult = await client.callTool({
    name: 'aol_create_wallet_mint_quote',
    arguments: {
      api_key: apiKey,
      amount_sats: 1000,
    },
  });
  assert(!walletMintQuoteResult?.isError, 'aol_create_wallet_mint_quote failed');
  expectStatus(walletMintQuoteResult, 200, 'aol_create_wallet_mint_quote');
  const mintQuoteId = expectSavedValue(walletMintQuoteResult, 'quote_id', 'aol_create_wallet_mint_quote');
  expectSavedValue(walletMintQuoteResult, 'invoice', 'aol_create_wallet_mint_quote');

  const walletCheckMintQuoteResult = await client.callTool({
    name: 'aol_check_wallet_mint_quote',
    arguments: {
      api_key: apiKey,
      quote: mintQuoteId,
    },
  });
  assert(!walletCheckMintQuoteResult?.isError, 'aol_check_wallet_mint_quote failed');
  expectStatus(walletCheckMintQuoteResult, 200, 'aol_check_wallet_mint_quote');

  const walletDepositBoundary = await client.callTool({
    name: 'aol_try_wallet_deposit',
    arguments: {
      api_key: apiKey,
    },
  });
  expectStatus(walletDepositBoundary, 410, 'aol_try_wallet_deposit');

  const walletWithdrawBoundary = await client.callTool({
    name: 'aol_try_wallet_withdraw',
    arguments: {
      api_key: apiKey,
    },
  });
  expectStatus(walletWithdrawBoundary, 410, 'aol_try_wallet_withdraw');

  const walletRestore = await client.callTool({
    name: 'aol_restore_wallet',
    arguments: {
      api_key: apiKey,
    },
  });
  expectStatus(walletRestore, 200, 'aol_restore_wallet');

  const walletReclaim = await client.callTool({
    name: 'aol_reclaim_wallet_pending',
    arguments: {
      api_key: apiKey,
    },
  });
  expectStatus(walletReclaim, 200, 'aol_reclaim_wallet_pending');

  const capitalResult = await client.callTool({
    name: 'aol_get_capital_balance',
    arguments: {
      api_key: apiKey,
    },
  });
  assert(!capitalResult?.isError, 'aol_get_capital_balance failed');

  const dashboardResult = await client.callTool({
    name: 'aol_get_me_dashboard',
    arguments: {
      api_key: apiKey,
    },
  });
  assert(!dashboardResult?.isError, 'aol_get_me_dashboard failed');

  const capitalDepositResult = await client.callTool({
    name: 'aol_create_capital_deposit',
    arguments: {
      api_key: apiKey,
    },
  });
  assert(!capitalDepositResult?.isError, 'aol_create_capital_deposit failed');
  if (baseUrl.startsWith('http://127.0.0.1')) {
    const depositStatus = getStructuredStatus(capitalDepositResult);
    if (depositStatus === 200) {
      expectSavedValue(capitalDepositResult, 'onchain_address', 'aol_create_capital_deposit');
    } else {
      expectCapitalDepositBoundary(capitalDepositResult, 'aol_create_capital_deposit');
    }
  } else {
    expectStatus(capitalDepositResult, 200, 'aol_create_capital_deposit');
    expectSavedValue(capitalDepositResult, 'onchain_address', 'aol_create_capital_deposit');
  }

  const capitalWithdrawResult = await client.callTool({
    name: 'aol_withdraw_capital',
    arguments: {
      api_key: apiKey,
      amount_sats: 1000,
      destination_address: 'bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh',
    },
  });
  expectStatus(capitalWithdrawResult, 503, 'aol_withdraw_capital');

  const nodeTestResult = await client.callTool({
    name: 'aol_test_node_connection',
    arguments: {
      api_key: apiKey,
      host: 'example.com:9735',
      macaroon: '00',
      tls_cert: '00',
    },
  });
  expectStatus(nodeTestResult, 400, 'aol_test_node_connection');

  const nodeConnectResult = await client.callTool({
    name: 'aol_connect_node',
    arguments: {
      api_key: apiKey,
      host: 'example.com:9735',
      macaroon: '00',
      tls_cert: '00',
      tier: 'readonly',
    },
  });
  expectStatus(nodeConnectResult, 400, 'aol_connect_node');

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

  const marketPreviewHelp = await client.callTool({
    name: 'aol_get_market_preview_help',
    arguments: {
      api_key: apiKey,
    },
  });
  expectStatus(marketPreviewHelp, 405, 'aol_get_market_preview_help');

  const marketOpenHelp = await client.callTool({
    name: 'aol_get_market_open_help',
    arguments: {
      api_key: apiKey,
    },
  });
  expectStatus(marketOpenHelp, 405, 'aol_get_market_open_help');

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
      api_key: apiKey,
    },
  });
  assert(!marketPerformanceResult?.isError, 'aol_get_market_performance failed');

  const marketAgentResult = await client.callTool({
    name: 'aol_get_market_agent',
    arguments: {
      id: agentId,
    },
  });
  assert(!marketAgentResult?.isError, 'aol_get_market_agent failed');
  expectStatus(marketAgentResult, 200, 'aol_get_market_agent');

  const openInstruction = await client.callTool({
    name: 'aol_build_open_channel_instruction',
    arguments: {
      api_key: apiKey,
      local_funding_amount_sats: 100000,
      peer_pubkey: '02'.padEnd(66, '1'),
    },
  });
  assert(!openInstruction?.isError, 'aol_build_open_channel_instruction failed');

  const closeInstruction = await client.callTool({
    name: 'aol_build_close_channel_instruction',
    arguments: {
      api_key: apiKey,
      channel_point: 'deadbeef:0',
    },
  });
  assert(!closeInstruction?.isError, 'aol_build_close_channel_instruction failed');

  const marketCloseHelp = await client.callTool({
    name: 'aol_get_market_close_help',
    arguments: {
      api_key: apiKey,
    },
  });
  expectStatus(marketCloseHelp, 405, 'aol_get_market_close_help');

  const policyInstruction = await client.callTool({
    name: 'aol_build_channel_policy_instruction',
    arguments: {
      api_key: apiKey,
      channel_id: '12345',
      fee_rate_ppm: 120,
    },
  });
  assert(!policyInstruction?.isError, 'aol_build_channel_policy_instruction failed');

  const rebalanceInstruction = await client.callTool({
    name: 'aol_build_rebalance_instruction',
    arguments: {
      api_key: apiKey,
      outbound_chan_id: '12345',
      amount_sats: 10000,
      max_fee_sats: 10,
    },
  });
  assert(!rebalanceInstruction?.isError, 'aol_build_rebalance_instruction failed');

  const swapCreateResult = await client.callTool({
    name: 'aol_create_lightning_to_onchain_swap',
    arguments: {
      api_key: apiKey,
      amount_sats: 1000,
      onchain_address: 'bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh',
    },
  });
  expectStatus(swapCreateResult, 503, 'aol_create_lightning_to_onchain_swap');

  const fundFromEcashResult = await client.callTool({
    name: 'aol_fund_channel_from_ecash',
    arguments: {
      api_key: apiKey,
      instruction: openInstruction?.structuredContent?.instruction,
      signature: '00',
    },
  });
  expectStatus(fundFromEcashResult, 503, 'aol_fund_channel_from_ecash');

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
