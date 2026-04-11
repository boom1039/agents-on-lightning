import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const baseUrl = process.env.AOL_MCP_BASE_URL || 'https://agentsonlightning.com';
const realTestInvoice = process.env.AOL_REAL_TEST_INVOICE || null;
const boundaryStatuses = new Set([400, 401, 402, 403, 404, 405, 409, 410, 422, 429, 503]);
const localBase = /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/i.test(baseUrl);

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function fetchJson(pathname) {
  const url = new URL(pathname, baseUrl);
  if (localBase && url.pathname.startsWith('/api/journey')) {
    url.searchParams.set('source', 'local');
  }
  const response = await fetch(url);
  const body = await response.json();
  assert(response.ok, `GET ${pathname} failed with ${response.status}`);
  return body;
}

function getStatus(result) {
  return result?.structuredContent?.status ?? null;
}

function getBody(result) {
  return result?.structuredContent?.body ?? null;
}

function getSaved(result) {
  return result?.structuredContent?.saved_values ?? {};
}

function noteFromBody(result) {
  const body = getBody(result);
  if (!body || typeof body !== 'object') return '';
  return body.message || body.error || body.learn || '';
}

function pad(value, width) {
  return String(value).padEnd(width, ' ');
}

const manifest = await fetchJson('/api/journey/manifest');
const rows = manifest.routes.map((route) => ({
  key: route.key,
  path: route.path,
  domain: route.domain,
  status: '',
  kind: 'unseen',
  tool: '',
  note: '',
}));
const rowByKey = new Map(rows.map((row) => [row.key, row]));

function markTransport(key, note) {
  const row = rowByKey.get(key);
  if (!row) return;
  row.kind = 'success';
  row.status = 'stream';
  row.tool = 'mcp-transport';
  row.note = note;
}

function markResult(key, tool, result, { success = [], boundary = [] } = {}) {
  const row = rowByKey.get(key);
  assert(row, `Unknown manifest route: ${key}`);
  const status = getStatus(result);
  const acceptedSuccess = new Set(success);
  const acceptedBoundary = new Set(boundary);
  row.status = status == null ? 'none' : String(status);
  row.tool = tool;
  row.note = noteFromBody(result);

  if (acceptedSuccess.has(status)) {
    row.kind = 'success';
    return;
  }
  if (acceptedBoundary.has(status)) {
    row.kind = 'boundary';
    return;
  }
  row.kind = 'fail';
}

function useRealOrFallback(value, fallback) {
  return typeof value === 'string' && value.length > 0 ? value : fallback;
}

const client = new Client({ name: 'aol-mcp-route-coverage', version: '1.0.0' });
const transport = new StreamableHTTPClientTransport(new URL('/mcp', baseUrl));
let transportClosed = false;

try {
  await client.connect(transport);
  markTransport('GET /mcp', 'Hosted MCP transport connected');

  async function callTool(name, args = {}) {
    const result = await client.callTool({ name, arguments: args });
    markTransport('POST /mcp', `Used ${name}`);
    return result;
  }

  const root = await callTool('aol_get_root');
  markResult('GET /', 'aol_get_root', root, { success: [200] });

  const health = await callTool('aol_get_health');
  markResult('GET /health', 'aol_get_health', health, { success: [200] });

  const llms = await callTool('aol_get_llms');
  markResult('GET /llms.txt', 'aol_get_llms', llms, { success: [200] });

  const llmsMcp = await callTool('aol_get_llms_mcp');
  markResult('GET /llms-mcp.txt', 'aol_get_llms_mcp', llmsMcp, { success: [200] });

  const mcpManifest = await callTool('aol_get_mcp_manifest');
  markResult('GET /.well-known/mcp.json', 'aol_get_mcp_manifest', mcpManifest, { success: [200] });

  const agentCard = await callTool('aol_get_agent_card');
  markResult('GET /.well-known/agent-card.json', 'aol_get_agent_card', agentCard, { success: [200] });

  const apiRoot = await callTool('aol_get_api_root');
  markResult('GET /api/v1/', 'aol_get_api_root', apiRoot, { success: [200] });

  const listMcpDocs = await callTool('aol_list_mcp_docs');
  markResult('GET /api/v1/skills', 'aol_list_mcp_docs', listMcpDocs, { success: [200] });

  const platformStatus = await callTool('aol_get_platform_status');
  markResult('GET /api/v1/platform/status', 'aol_get_platform_status', platformStatus, { success: [200] });
  const platformNodePubkey = getSaved(platformStatus).node_pubkey || getBody(platformStatus)?.node_pubkey || getBody(platformStatus)?.pubkey || `02${'1'.repeat(64)}`;

  const decodeInvoice = await callTool('aol_decode_invoice', { invoice: realTestInvoice || 'lnbc...' });
  markResult('GET /api/v1/platform/decode-invoice', 'aol_decode_invoice', decodeInvoice, realTestInvoice
    ? { success: [200] }
    : { boundary: [400] });

  const capabilities = await callTool('aol_get_capabilities');
  markResult('GET /api/v1/capabilities', 'aol_get_capabilities', capabilities, { success: [200] });

  const ethos = await callTool('aol_get_ethos');
  markResult('GET /api/v1/ethos', 'aol_get_ethos', ethos, { success: [200] });

  const marketConfig = await callTool('aol_get_market_config');
  markResult('GET /api/v1/market/config', 'aol_get_market_config', marketConfig, { success: [200] });

  const listStrategies = await callTool('aol_list_strategies');
  markResult('GET /api/v1/strategies', 'aol_list_strategies', listStrategies, { success: [200] });

  const getStrategy = await callTool('aol_get_strategy', { strategy: 'geographic-arbitrage' });
  markResult('GET /api/v1/strategies/:name', 'aol_get_strategy', getStrategy, { success: [200] });

  const ledger = await callTool('aol_get_ledger');
  markResult('GET /api/v1/ledger', 'aol_get_ledger', ledger, { success: [200] });

  const leaderboard = await callTool('aol_get_leaderboard');
  markResult('GET /api/v1/leaderboard', 'aol_get_leaderboard', leaderboard, { success: [200] });

  const tournaments = await callTool('aol_list_tournaments');
  markResult('GET /api/v1/tournaments', 'aol_list_tournaments', tournaments, { success: [200] });
  const tournamentId = getBody(tournaments)?.tournaments?.[0]?.tournament_id
    || getBody(tournaments)?.tournaments?.[0]?.id
    || 'tourn-00000000';

  const marketOverview = await callTool('aol_get_market_overview');
  markResult('GET /api/v1/market/overview', 'aol_get_market_overview', marketOverview, { success: [200] });

  const marketRankings = await callTool('aol_get_market_rankings');
  markResult('GET /api/v1/market/rankings', 'aol_get_market_rankings', marketRankings, { success: [200] });

  const marketChannels = await callTool('aol_get_market_channels');
  markResult('GET /api/v1/market/channels', 'aol_get_market_channels', marketChannels, { success: [200] });

  const channelStatus = await callTool('aol_get_channel_status');
  markResult('GET /api/v1/channels/status', 'aol_get_channel_status', channelStatus, { success: [200] });

  const analyticsCatalog = await callTool('aol_get_analytics_catalog');
  markResult('GET /api/v1/analytics/catalog', 'aol_get_analytics_catalog', analyticsCatalog, { success: [200] });

  const registerA = await callTool('aol_register_agent', { name: `mcp-cover-a-${Date.now()}` });
  markResult('POST /api/v1/agents/register', 'aol_register_agent', registerA, { success: [201] });
  const agentAKey = getSaved(registerA).api_key || getBody(registerA)?.api_key;
  const agentAId = getSaved(registerA).agent_id || getBody(registerA)?.agent_id;

  const registerB = await callTool('aol_register_agent', { name: `mcp-cover-b-${Date.now()}` });
  const agentBKey = getSaved(registerB).api_key || getBody(registerB)?.api_key;
  const agentBId = getSaved(registerB).agent_id || getBody(registerB)?.agent_id;

  const me = await callTool('aol_get_me', { api_key: agentAKey });
  markResult('GET /api/v1/agents/me', 'aol_get_me', me, { success: [200] });

  const updateMe = await callTool('aol_update_me', { api_key: agentAKey, description: 'MCP coverage agent', framework: 'MCP coverage' });
  markResult('PUT /api/v1/agents/me', 'aol_update_me', updateMe, { success: [200] });

  const meDashboard = await callTool('aol_get_me_dashboard', { api_key: agentAKey });
  markResult('GET /api/v1/agents/me/dashboard', 'aol_get_me_dashboard', meDashboard, { success: [200] });

  const meEvents = await callTool('aol_get_me_events', { api_key: agentAKey });
  markResult('GET /api/v1/agents/me/events', 'aol_get_me_events', meEvents, { success: [200] });

  const referral = await callTool('aol_get_referral', { api_key: agentAKey });
  markResult('GET /api/v1/agents/me/referral', 'aol_get_referral', referral, { success: [200] });

  const referralCode = await callTool('aol_get_referral_code', { api_key: agentAKey });
  markResult('GET /api/v1/agents/me/referral-code', 'aol_get_referral_code', referralCode, { success: [200] });

  const publicProfile = await callTool('aol_get_agent_profile', { id: agentAId });
  markResult('GET /api/v1/agents/:id', 'aol_get_agent_profile', publicProfile, { success: [200] });

  const publicLineage = await callTool('aol_get_agent_lineage', { id: agentAId });
  markResult('GET /api/v1/agents/:id/lineage', 'aol_get_agent_lineage', publicLineage, { success: [200] });

  const actionSubmit = await callTool('aol_submit_action', { api_key: agentAKey, action: 'inspect_market', description: 'Coverage action' });
  markResult('POST /api/v1/actions/submit', 'aol_submit_action', actionSubmit, { success: [201] });
  const actionId = getSaved(actionSubmit).action_id || getBody(actionSubmit)?.action_id || getBody(actionSubmit)?.id;

  const actionHistory = await callTool('aol_get_action_history', { api_key: agentAKey });
  markResult('GET /api/v1/actions/history', 'aol_get_action_history', actionHistory, { success: [200] });

  const actionGet = await callTool('aol_get_action', { api_key: agentAKey, id: actionId });
  markResult('GET /api/v1/actions/:id', 'aol_get_action', actionGet, { success: [200] });

  const nodeTest = await callTool('aol_test_node_connection', { api_key: agentAKey, host: 'example.com:9735', macaroon: '00', tls_cert: '00' });
  markResult('POST /api/v1/node/test-connection', 'aol_test_node_connection', nodeTest, { boundary: [400] });

  const nodeConnect = await callTool('aol_connect_node', { api_key: agentAKey, host: 'example.com:9735', macaroon: '00', tls_cert: '00', tier: 'readonly' });
  markResult('POST /api/v1/node/connect', 'aol_connect_node', nodeConnect, { boundary: [400] });

  const nodeStatus = await callTool('aol_get_node_status', { api_key: agentAKey });
  markResult('GET /api/v1/node/status', 'aol_get_node_status', nodeStatus, { success: [200] });

  const walletBalance = await callTool('aol_get_wallet_balance', { api_key: agentAKey });
  markResult('GET /api/v1/wallet/balance', 'aol_get_wallet_balance', walletBalance, { success: [200] });

  const walletHistory = await callTool('aol_get_wallet_history', { api_key: agentAKey });
  markResult('GET /api/v1/wallet/history', 'aol_get_wallet_history', walletHistory, { success: [200] });

  const walletMintQuoteHelp = await callTool('aol_get_wallet_mint_quote_help', { api_key: agentAKey });
  markResult('GET /api/v1/wallet/mint-quote', 'aol_get_wallet_mint_quote_help', walletMintQuoteHelp, { success: [200] });

  const walletMintQuote = await callTool('aol_create_wallet_mint_quote', { api_key: agentAKey, amount_sats: 1000 });
  markResult('POST /api/v1/wallet/mint-quote', 'aol_create_wallet_mint_quote', walletMintQuote, { success: [200] });
  const mintQuoteId = getSaved(walletMintQuote).quote_id || getBody(walletMintQuote)?.quote_id || getBody(walletMintQuote)?.quote;

  const walletCheckMintQuote = await callTool('aol_check_wallet_mint_quote', { api_key: agentAKey, quote: mintQuoteId });
  markResult('POST /api/v1/wallet/check-mint-quote', 'aol_check_wallet_mint_quote', walletCheckMintQuote, { success: [200] });

  const walletMint = await callTool('aol_mint_wallet', { api_key: agentAKey, amount_sats: 1000, quote: mintQuoteId });
  markResult('POST /api/v1/wallet/mint', 'aol_mint_wallet', walletMint, { boundary: [400] });

  const walletSend = await callTool('aol_send_wallet_tokens', { api_key: agentAKey, amount_sats: 1 });
  markResult('POST /api/v1/wallet/send', 'aol_send_wallet_tokens', walletSend, { boundary: [400] });
  const cashuToken = getSaved(walletSend).token || getBody(walletSend)?.token || 'invalid-cashu-token';

  const walletReceive = await callTool('aol_receive_wallet_tokens', { api_key: agentBKey, token: cashuToken });
  markResult('POST /api/v1/wallet/receive', 'aol_receive_wallet_tokens', walletReceive, { boundary: [400] });

  const walletMeltQuote = await callTool('aol_create_wallet_melt_quote', { api_key: agentAKey, invoice: realTestInvoice || 'lnbc...' });
  markResult('POST /api/v1/wallet/melt-quote', 'aol_create_wallet_melt_quote', walletMeltQuote, realTestInvoice
    ? { success: [200] }
    : { boundary: [400] });
  const meltQuoteId = getSaved(walletMeltQuote).quote_id || getBody(walletMeltQuote)?.quote_id || getBody(walletMeltQuote)?.quote || 'missing-quote';

  const walletMelt = await callTool('aol_melt_wallet', { api_key: agentAKey, quote: meltQuoteId });
  markResult('POST /api/v1/wallet/melt', 'aol_melt_wallet', walletMelt, { boundary: [400] });

  const walletRestore = await callTool('aol_restore_wallet', { api_key: agentAKey });
  markResult('POST /api/v1/wallet/restore', 'aol_restore_wallet', walletRestore, { success: [200] });

  const walletReclaim = await callTool('aol_reclaim_wallet_pending', { api_key: agentAKey });
  markResult('POST /api/v1/wallet/reclaim-pending', 'aol_reclaim_wallet_pending', walletReclaim, { success: [200] });

  const capitalBalance = await callTool('aol_get_capital_balance', { api_key: agentAKey });
  markResult('GET /api/v1/capital/balance', 'aol_get_capital_balance', capitalBalance, { success: [200] });

  const capitalActivity = await callTool('aol_get_capital_activity', { api_key: agentAKey });
  markResult('GET /api/v1/capital/activity', 'aol_get_capital_activity', capitalActivity, { success: [200] });

  const capitalDeposit = await callTool('aol_create_capital_deposit', { api_key: agentAKey });
  markResult('POST /api/v1/capital/deposit', 'aol_create_capital_deposit', capitalDeposit, {
    success: [200],
    boundary: [503],
  });

  const capitalDeposits = await callTool('aol_get_capital_deposits', { api_key: agentAKey });
  markResult('GET /api/v1/capital/deposits', 'aol_get_capital_deposits', capitalDeposits, { success: [200] });
  const capitalDepositAddress = getSaved(capitalDeposit).onchain_address || getBody(capitalDeposit)?.address || 'bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh';

  const capitalWithdraw = await callTool('aol_withdraw_capital', {
    api_key: agentAKey,
    amount_sats: 1000,
    destination_address: capitalDepositAddress,
  });
  markResult('POST /api/v1/capital/withdraw', 'aol_withdraw_capital', capitalWithdraw, { boundary: [503] });

  const networkHealth = await callTool('aol_get_network_health');
  markResult('GET /api/v1/analysis/network-health', 'aol_get_network_health', networkHealth, { success: [200] });

  const fakePubkey = `02${'1'.repeat(64)}`;
  const nodeAnalysis = await callTool('aol_get_node_analysis', { pubkey: platformNodePubkey || fakePubkey });
  markResult('GET /api/v1/analysis/node/:pubkey', 'aol_get_node_analysis', nodeAnalysis, {
    success: [200],
    boundary: [404],
  });

  const suggestPeers = await callTool('aol_suggest_peers', { pubkey: platformNodePubkey || fakePubkey });
  markResult('GET /api/v1/analysis/suggest-peers/:pubkey', 'aol_suggest_peers', suggestPeers, {
    success: [200],
    boundary: [404],
  });
  const suggestedPeer = getSaved(suggestPeers).peer_pubkey || getBody(suggestPeers)?.suggestions?.[0]?.pubkey || fakePubkey;

  const peerSafety = await callTool('aol_get_peer_safety', { pubkey: suggestedPeer });
  markResult('GET /api/v1/market/peer-safety/:pubkey', 'aol_get_peer_safety', peerSafety, { success: [200] });

  const marketFees = await callTool('aol_get_market_fees', { pubkey: suggestedPeer });
  markResult('GET /api/v1/market/fees/:peerPubkey', 'aol_get_market_fees', marketFees, { success: [200] });

  const marketAgent = await callTool('aol_get_market_agent', { id: agentAId });
  markResult('GET /api/v1/market/agent/:agentId', 'aol_get_market_agent', marketAgent, { success: [200] });

  const channelsMine = await callTool('aol_get_channels_mine', { api_key: agentAKey });
  markResult('GET /api/v1/channels/mine', 'aol_get_channels_mine', channelsMine, { success: [200] });
  const ownedChannel = getBody(channelsMine)?.channels?.[0] || null;
  const ownedChanId = ownedChannel?.chan_id || '1037758656816742400';
  const ownedChannelPoint = ownedChannel?.channel_point || 'deadbeef:0';

  const leaderboardAgent = await callTool('aol_get_leaderboard_agent', { id: agentAId });
  markResult('GET /api/v1/leaderboard/agent/:id', 'aol_get_leaderboard_agent', leaderboardAgent, { success: [200] });

  const leaderboardChallenges = await callTool('aol_get_leaderboard_challenges');
  markResult('GET /api/v1/leaderboard/challenges', 'aol_get_leaderboard_challenges', leaderboardChallenges, { success: [200] });

  const hallOfFame = await callTool('aol_get_leaderboard_hall_of_fame');
  markResult('GET /api/v1/leaderboard/hall-of-fame', 'aol_get_leaderboard_hall_of_fame', hallOfFame, { success: [200] });

  const evangelists = await callTool('aol_get_leaderboard_evangelists');
  markResult('GET /api/v1/leaderboard/evangelists', 'aol_get_leaderboard_evangelists', evangelists, { success: [200] });

  const tournamentBracket = await callTool('aol_get_tournament_bracket', { id: tournamentId });
  markResult('GET /api/v1/tournaments/:id/bracket', 'aol_get_tournament_bracket', tournamentBracket, {
    success: [200],
    boundary: [404],
  });

  const channelsAudit = await callTool('aol_get_channels_audit');
  markResult('GET /api/v1/channels/audit', 'aol_get_channels_audit', channelsAudit, { success: [200] });
  const publicAuditChanId = getBody(channelsAudit)?.entries?.find((entry) => entry?.chan_id)?.chan_id || ownedChanId;

  const channelsVerify = await callTool('aol_get_channels_verify');
  markResult('GET /api/v1/channels/verify', 'aol_get_channels_verify', channelsVerify, { success: [200] });

  const channelsViolations = await callTool('aol_get_channels_violations');
  markResult('GET /api/v1/channels/violations', 'aol_get_channels_violations', channelsViolations, { success: [200] });

  const channelAudit = await callTool('aol_get_channel_audit', { channel_point: publicAuditChanId });
  markResult('GET /api/v1/channels/audit/:chanId', 'aol_get_channel_audit', channelAudit, {
    success: [200],
    boundary: [404],
  });

  const channelVerify = await callTool('aol_get_channel_verify', { channel_point: publicAuditChanId });
  markResult('GET /api/v1/channels/verify/:chanId', 'aol_get_channel_verify', channelVerify, {
    success: [200],
    boundary: [404],
  });

  const previewOpenHelp = await callTool('aol_get_market_preview_help', { api_key: agentAKey });
  markResult('GET /api/v1/market/preview', 'aol_get_market_preview_help', previewOpenHelp, { success: [200] });

  const openHelp = await callTool('aol_get_market_open_help', { api_key: agentAKey });
  markResult('GET /api/v1/market/open', 'aol_get_market_open_help', openHelp, { success: [200] });

  const marketPending = await callTool('aol_get_market_pending', { api_key: agentAKey });
  markResult('GET /api/v1/market/pending', 'aol_get_market_pending', marketPending, { success: [200] });

  const marketRevenue = await callTool('aol_get_market_revenue', { api_key: agentAKey });
  markResult('GET /api/v1/market/revenue', 'aol_get_market_revenue', marketRevenue, { success: [200] });

  const marketRevenueChannel = await callTool('aol_get_market_revenue_channel', { api_key: agentAKey, channel_point: ownedChanId });
  markResult('GET /api/v1/market/revenue/:chanId', 'aol_get_market_revenue_channel', marketRevenueChannel, {
    success: [200],
    boundary: [404],
  });

  const revenueConfig = await callTool('aol_update_revenue_config', { api_key: agentAKey, destination: 'capital' });
  markResult('PUT /api/v1/market/revenue-config', 'aol_update_revenue_config', revenueConfig, { success: [200] });

  const marketPerformance = await callTool('aol_get_market_performance', { api_key: agentAKey });
  markResult('GET /api/v1/market/performance', 'aol_get_market_performance', marketPerformance, { success: [200] });

  const marketPerformanceChannel = await callTool('aol_get_market_performance_channel', { api_key: agentAKey, channel_point: ownedChanId });
  markResult('GET /api/v1/market/performance/:chanId', 'aol_get_market_performance_channel', marketPerformanceChannel, {
    success: [200],
    boundary: [404],
  });

  const closeHelp = await callTool('aol_get_market_close_help', { api_key: agentAKey });
  markResult('GET /api/v1/market/close', 'aol_get_market_close_help', closeHelp, { success: [200] });

  const marketCloses = await callTool('aol_get_market_closes', { api_key: agentAKey });
  markResult('GET /api/v1/market/closes', 'aol_get_market_closes', marketCloses, { success: [200] });

  const channelInstructions = await callTool('aol_get_channel_instructions', { api_key: agentAKey });
  markResult('GET /api/v1/channels/instructions', 'aol_get_channel_instructions', channelInstructions, { success: [200] });

  const marketRebalances = await callTool('aol_get_market_rebalances', { api_key: agentAKey });
  markResult('GET /api/v1/market/rebalances', 'aol_get_market_rebalances', marketRebalances, { success: [200] });

  const swapQuote = await callTool('aol_get_swap_quote', { api_key: agentAKey, amount_sats: 100000 });
  markResult('GET /api/v1/market/swap/quote', 'aol_get_swap_quote', swapQuote, { success: [200] });

  const swapCreate = await callTool('aol_create_swap_to_onchain', {
    api_key: agentAKey,
    amount_sats: 50000,
    onchain_address: capitalDepositAddress,
  });
  markResult('POST /api/v1/market/swap/lightning-to-onchain', 'aol_create_swap_to_onchain', swapCreate, { boundary: [400, 402, 429, 503] });
  const swapId = getSaved(swapCreate).swap_id || getBody(swapCreate)?.swap_id || 'swap-missing';

  const swapStatus = await callTool('aol_get_swap_status', { api_key: agentAKey, swap_id: swapId });
  markResult('GET /api/v1/market/swap/status/:swapId', 'aol_get_swap_status', swapStatus, swapId === 'swap-missing'
    ? { boundary: [404] }
    : { success: [200] });

  const swapHistory = await callTool('aol_get_swap_history', { api_key: agentAKey });
  markResult('GET /api/v1/market/swap/history', 'aol_get_swap_history', swapHistory, { success: [200] });

  const ecashFund = await callTool('aol_fund_channel_from_ecash', {
    api_key: agentAKey,
    instruction: {
      action: 'channel_open',
      agent_id: agentAId,
      params: {
        local_funding_amount_sats: 100000,
        peer_pubkey: `02${'1'.repeat(64)}`,
      },
      timestamp: Math.floor(Date.now() / 1000),
    },
    signature: '00',
  });
  markResult('POST /api/v1/market/fund-from-ecash', 'aol_fund_channel_from_ecash', ecashFund, { boundary: [400, 401, 402, 429, 503] });
  const flowId = getSaved(ecashFund).flow_id || getBody(ecashFund)?.flow_id || 'flow-missing';

  const ecashFundingStatus = await callTool('aol_get_ecash_funding_status', { api_key: agentAKey, flow_id: flowId });
  markResult('GET /api/v1/market/fund-from-ecash/:flowId', 'aol_get_ecash_funding_status', ecashFundingStatus, flowId === 'flow-missing'
    ? { boundary: [404] }
    : { success: [200] });

  const openInstruction = await callTool('aol_build_open_channel_instruction', {
    api_key: agentAKey,
    local_funding_amount_sats: 100000,
    peer_pubkey: suggestedPeer,
  });
  const openInstructionBody = openInstruction?.structuredContent?.instruction;

  const previewOpen = await callTool('aol_preview_open_channel', { api_key: agentAKey, instruction: openInstructionBody, signature: '00' });
  markResult('POST /api/v1/market/preview', 'aol_preview_open_channel', previewOpen, { boundary: [400, 503] });

  const openChannel = await callTool('aol_open_channel', { api_key: agentAKey, instruction: openInstructionBody, signature: '00' });
  markResult('POST /api/v1/market/open', 'aol_open_channel', openChannel, { boundary: [400, 429, 503] });

  const closeInstruction = await callTool('aol_build_close_channel_instruction', { api_key: agentAKey, channel_point: ownedChannelPoint });
  const closeInstructionBody = closeInstruction?.structuredContent?.instruction;

  const closeChannel = await callTool('aol_close_channel', { api_key: agentAKey, instruction: closeInstructionBody, signature: '00' });
  markResult('POST /api/v1/market/close', 'aol_close_channel', closeChannel, { boundary: [400, 404, 429, 503] });

  const policyInstruction = await callTool('aol_build_channel_policy_instruction', { api_key: agentAKey, channel_id: ownedChanId, fee_rate_ppm: 120 });
  const policyInstructionBody = policyInstruction?.structuredContent?.instruction;

  const previewChannelPolicy = await callTool('aol_preview_channel_policy', { api_key: agentAKey, instruction: policyInstructionBody, signature: '00' });
  markResult('POST /api/v1/channels/preview', 'aol_preview_channel_policy', previewChannelPolicy, { boundary: [400, 404] });

  const instructChannelPolicy = await callTool('aol_instruct_channel_policy', { api_key: agentAKey, instruction: policyInstructionBody, signature: '00' });
  markResult('POST /api/v1/channels/instruct', 'aol_instruct_channel_policy', instructChannelPolicy, { boundary: [400, 404] });

  const estimateRebalance = await callTool('aol_estimate_rebalance', { api_key: agentAKey, chan_id: ownedChanId, amount_sats: 10000 });
  markResult('POST /api/v1/market/rebalance/estimate', 'aol_estimate_rebalance', estimateRebalance, { boundary: [400, 404] });

  const rebalanceInstruction = await callTool('aol_build_rebalance_instruction', { api_key: agentAKey, chan_id: ownedChanId, amount_sats: 10000, max_fee_sats: 10 });
  const rebalanceInstructionBody = rebalanceInstruction?.structuredContent?.instruction;

  const rebalanceChannel = await callTool('aol_rebalance_channel', { api_key: agentAKey, instruction: rebalanceInstructionBody, signature: '00' });
  markResult('POST /api/v1/market/rebalance', 'aol_rebalance_channel', rebalanceChannel, { boundary: [400, 404, 503] });

  const sendMessage = await callTool('aol_send_message', { api_key: agentAKey, to: agentBId, content: 'mcp coverage hello' });
  markResult('POST /api/v1/messages', 'aol_send_message', sendMessage, { success: [200, 201] });

  const getMessages = await callTool('aol_get_messages', { api_key: agentAKey });
  markResult('GET /api/v1/messages', 'aol_get_messages', getMessages, { success: [200] });

  const getInbox = await callTool('aol_get_messages_inbox', { api_key: agentBKey });
  markResult('GET /api/v1/messages/inbox', 'aol_get_messages_inbox', getInbox, { success: [200] });

  const createAlliance = await callTool('aol_create_alliance', {
    api_key: agentAKey,
    to: agentBId,
    description: 'MCP coverage alliance',
  });
  markResult('POST /api/v1/alliances', 'aol_create_alliance', createAlliance, { success: [200, 201] });
  const allianceId = getSaved(createAlliance).alliance_id || getBody(createAlliance)?.alliance_id || getBody(createAlliance)?.id;

  const getAlliances = await callTool('aol_get_alliances', { api_key: agentAKey });
  markResult('GET /api/v1/alliances', 'aol_get_alliances', getAlliances, { success: [200] });

  const acceptAlliance = await callTool('aol_accept_alliance', { api_key: agentBKey, id: allianceId || 'missing-alliance' });
  markResult('POST /api/v1/alliances/:id/accept', 'aol_accept_alliance', acceptAlliance, { success: [200], boundary: [404] });

  const breakAlliance = await callTool('aol_break_alliance', { api_key: agentAKey, id: allianceId || 'missing-alliance', reason: 'coverage done' });
  markResult('POST /api/v1/alliances/:id/break', 'aol_break_alliance', breakAlliance, { success: [200], boundary: [404] });

  const enterTournament = await callTool('aol_enter_tournament', { api_key: agentAKey, id: tournamentId });
  markResult('POST /api/v1/tournaments/:id/enter', 'aol_enter_tournament', enterTournament, { success: [200], boundary: [400, 404] });

  const analyticsHistory = await callTool('aol_get_analytics_history', { api_key: agentAKey });
  markResult('GET /api/v1/analytics/history', 'aol_get_analytics_history', analyticsHistory, { success: [200] });

  const analyticsQuote = await callTool('aol_quote_analytics', { api_key: agentAKey, query_id: 'network_stats' });
  markResult('POST /api/v1/analytics/quote', 'aol_quote_analytics', analyticsQuote, { success: [200] });

  const analyticsExecute = await callTool('aol_execute_analytics', { api_key: agentAKey, query_id: 'network_stats' });
  markResult('POST /api/v1/analytics/execute', 'aol_execute_analytics', analyticsExecute, { boundary: [402] });

  const help = await callTool('aol_request_help', { api_key: agentAKey, question: 'How do I fund capital?' });
  markResult('POST /api/v1/help', 'aol_request_help', help, { boundary: [402] });

  await transport.close().catch(() => {});
  transportClosed = true;
  markTransport('DELETE /mcp', 'Hosted MCP transport closed client-side (stateless servers may not receive DELETE)');

  const uncovered = rows.filter((row) => row.kind === 'unseen');
  const failed = rows.filter((row) => row.kind === 'fail');
  const successCount = rows.filter((row) => row.kind === 'success').length;
  const boundaryCount = rows.filter((row) => row.kind === 'boundary').length;

  const widthKey = Math.max(...rows.map((row) => row.key.length), 8);
  const widthKind = 8;
  const widthStatus = 6;

  console.log(`\nMCP route coverage for ${baseUrl}`);
  console.log(`success=${successCount} boundary=${boundaryCount} fail=${failed.length} unseen=${uncovered.length} total=${rows.length}\n`);

  const badRows = [...failed, ...uncovered];
  if (badRows.length > 0) {
    console.log(`${pad('Route', widthKey)}  ${pad('Kind', widthKind)}  ${pad('HTTP', widthStatus)}  Tool`);
    for (const row of badRows) {
      console.log(`${pad(row.key, widthKey)}  ${pad(row.kind, widthKind)}  ${pad(row.status || '-', widthStatus)}  ${row.tool || '-'} ${row.note ? `| ${row.note}` : ''}`);
    }
  }

  if (badRows.length === 0) {
    console.log(`${pad('Route', widthKey)}  ${pad('Kind', widthKind)}  ${pad('HTTP', widthStatus)}  Tool`);
    for (const row of rows) {
      console.log(`${pad(row.key, widthKey)}  ${pad(row.kind, widthKind)}  ${pad(row.status || '-', widthStatus)}  ${row.tool}`);
    }
  }

  if (failed.length > 0 || uncovered.length > 0) {
    process.exitCode = 1;
  }
} finally {
  if (!transportClosed) {
    await transport.close().catch(() => {});
  }
}
