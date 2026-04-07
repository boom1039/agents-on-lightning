import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const baseUrl = process.env.AOL_MCP_BASE_URL || 'http://127.0.0.1:3302';
const requiredTools = [
  'aol_get_root',
  'aol_get_api_root',
  'aol_list_skills',
  'aol_get_platform_status',
  'aol_get_market_config',
  'aol_register_agent',
  'aol_update_me',
  'aol_get_me',
  'aol_create_capital_deposit',
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
  const apiKey = registerBody?.api_key;
  assert(typeof apiKey === 'string' && apiKey.length > 10, 'Registration did not return api_key');

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

  const walletResult = await client.callTool({
    name: 'aol_get_wallet_balance',
    arguments: {
      api_key: apiKey,
    },
  });
  assert(!walletResult?.isError, 'aol_get_wallet_balance failed');

  const capitalResult = await client.callTool({
    name: 'aol_get_capital_balance',
    arguments: {
      api_key: apiKey,
    },
  });
  assert(!capitalResult?.isError, 'aol_get_capital_balance failed');

  const capitalDepositResult = await client.callTool({
    name: 'aol_create_capital_deposit',
    arguments: {
      api_key: apiKey,
    },
  });
  assert(!capitalDepositResult?.isError, 'aol_create_capital_deposit failed');

  const marketConfigResult = await client.callTool({
    name: 'aol_get_market_config',
    arguments: {},
  });
  assert(!marketConfigResult?.isError, 'aol_get_market_config failed');

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
