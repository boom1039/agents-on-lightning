export const DISABLED_ROUTE_KEYS = new Set([
  'POST /api/v1/capital/withdraw',
]);

export const DEPRECATED_ROUTE_KEYS = new Set([
  'POST /api/v1/wallet/deposit',
  'POST /api/v1/wallet/withdraw',
]);

export const METHOD_BOUNDARY_ROUTE_KEYS = new Set([
  'GET /api/v1/wallet/mint-quote',
  'GET /api/v1/market/preview',
  'GET /api/v1/market/open',
  'GET /api/v1/market/close',
]);

export const IDEMPOTENT_ROUTE_KEYS = new Set([
  'POST /api/v1/analytics/execute',
  'POST /api/v1/capital/deposit',
  'POST /api/v1/help',
  'POST /api/v1/channels/instruct',
  'POST /api/v1/market/open',
  'POST /api/v1/market/close',
  'POST /api/v1/market/rebalance',
]);

export const SAMPLE_VALUES = {
  strategy_name: 'geographic-arbitrage',
  action_id: 'action-test-0001',
  tournament_id: 'tourn-00000000',
  audit_chan_id: `${'0'.repeat(64)}:0`,
  owned_chan_id: '1234567890',
  owned_channel_point: `${'0'.repeat(64)}:0`,
  peer_pubkey: `02${'a'.repeat(64)}`,
  market_agent_id: '12345678',
  swap_id: 'swap-test-0001',
  flow_id: 'flow-test-0001',
  public_agent_id: '12345678',
  external_invoice: 'lnbc1invalid',
  onchain_address: 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kygt080',
  cashu_token: 'cashuAinvalid',
};

function laneForDomain(domain) {
  switch (domain) {
    case 'app-level':
    case 'discovery':
    case 'analysis':
      return 'public-discovery';
    case 'identity':
      return 'identity-bootstrap';
    case 'wallet':
      return 'wallet';
    case 'social':
      return 'social';
    case 'channels':
      return 'channels';
    case 'market':
      return 'market';
    case 'analytics':
      return 'analytics-help';
    case 'capital':
      return 'capital';
    default:
      return 'misc';
  }
}

function actorForRoute(route) {
  if (route.auth === 'public') return 'public';
  if (route.key === 'POST /api/v1/alliances/:id/accept') return 'agent_d';
  switch (route.domain) {
    case 'wallet':
      return 'agent_c';
    case 'social':
      return route.path.includes('/alliances') || route.path.includes('/messages') ? 'agent_c' : 'agent_c';
    case 'analytics':
      return 'agent_e';
    case 'capital':
    case 'channels':
    case 'market':
      return 'agent_a';
    case 'identity':
      return 'agent_a';
    default:
      return 'agent_a';
  }
}

function prereqsForRoute(route) {
  const key = route.key;

  switch (key) {
    case 'GET /':
    case 'GET /health':
    case 'GET /llms.txt':
    case 'GET /api/v1/':
    case 'GET /api/v1/capabilities':
    case 'GET /api/v1/ethos':
    case 'GET /api/v1/platform/status':
    case 'GET /api/v1/skills':
    case 'GET /api/v1/strategies':
    case 'GET /api/v1/ledger':
    case 'GET /api/v1/analysis/network-health':
    case 'GET /api/v1/leaderboard':
    case 'GET /api/v1/leaderboard/challenges':
    case 'GET /api/v1/leaderboard/evangelists':
    case 'GET /api/v1/leaderboard/hall-of-fame':
    case 'GET /api/v1/tournaments':
    case 'GET /api/v1/channels/audit':
    case 'GET /api/v1/channels/status':
    case 'GET /api/v1/channels/verify':
    case 'GET /api/v1/channels/violations':
    case 'GET /api/v1/market/channels':
    case 'GET /api/v1/market/config':
    case 'GET /api/v1/market/overview':
    case 'GET /api/v1/market/rankings':
    case 'GET /api/v1/analytics/catalog':
    case 'POST /api/v1/agents/register':
      return ['none'];
    case 'GET /api/v1/strategies/:name':
      return ['strategy_name'];
    case 'GET /api/v1/platform/decode-invoice':
      return ['external_invoice'];
    case 'GET /api/v1/actions/:id':
      return ['agent', 'action_id'];
    case 'GET /api/v1/agents/:id':
    case 'GET /api/v1/agents/:id/lineage':
    case 'GET /api/v1/leaderboard/agent/:id':
      return ['public_agent_id'];
    case 'GET /api/v1/market/agent/:agentId':
      return ['market_agent_id'];
    case 'GET /api/v1/analysis/node/:pubkey':
    case 'GET /api/v1/analysis/suggest-peers/:pubkey':
      return ['public_node_pubkey'];
    case 'POST /api/v1/node/connect':
    case 'POST /api/v1/node/test-connection':
      return ['agent', 'node_secrets'];
    case 'POST /api/v1/wallet/check-mint-quote':
    case 'POST /api/v1/wallet/mint':
      return ['agent', 'paid_quote'];
    case 'POST /api/v1/wallet/melt-quote':
      return ['agent', 'external_invoice'];
    case 'POST /api/v1/wallet/melt':
      return ['agent', 'external_invoice'];
    case 'POST /api/v1/wallet/send':
    case 'POST /api/v1/analytics/execute':
      return ['agent', 'funded_wallet'];
    case 'POST /api/v1/wallet/receive':
      return ['agent', 'cashu_token'];
    case 'POST /api/v1/wallet/reclaim-pending':
    case 'POST /api/v1/wallet/restore':
      return ['agent', 'pending_wallet_state'];
    case 'POST /api/v1/capital/deposit':
    case 'GET /api/v1/capital/deposits':
    case 'GET /api/v1/capital/balance':
    case 'GET /api/v1/capital/activity':
      return ['agent'];
    case 'POST /api/v1/capital/withdraw':
      return ['agent', 'confirmed_deposit'];
    case 'POST /api/v1/market/preview':
    case 'POST /api/v1/market/open':
      return ['agent', 'agent_pubkey', 'funded_capital', 'peer_target', 'signed_body'];
    case 'POST /api/v1/market/fund-from-ecash':
      return ['agent', 'agent_pubkey', 'funded_wallet', 'peer_target', 'signed_body'];
    case 'GET /api/v1/market/fund-from-ecash/:flowId':
      return ['agent', 'flow_id'];
    case 'POST /api/v1/channels/preview':
    case 'POST /api/v1/channels/instruct':
      return ['agent', 'agent_pubkey', 'owned_chan_id', 'signed_body'];
    case 'GET /api/v1/channels/instructions':
    case 'GET /api/v1/channels/mine':
      return ['agent'];
    case 'GET /api/v1/market/performance/:chanId':
    case 'GET /api/v1/market/revenue/:chanId':
    case 'POST /api/v1/market/rebalance/estimate':
      return ['agent', 'owned_chan_id'];
    case 'POST /api/v1/market/rebalance':
    case 'POST /api/v1/market/close':
      return ['agent', 'agent_pubkey', 'owned_chan_id', 'signed_body'];
    case 'GET /api/v1/channels/audit/:chanId':
    case 'GET /api/v1/channels/verify/:chanId':
      return ['audit_chan_id'];
    case 'GET /api/v1/market/fees/:peerPubkey':
    case 'GET /api/v1/market/peer-safety/:pubkey':
      return ['peer_target'];
    case 'POST /api/v1/alliances/:id/accept':
    case 'POST /api/v1/alliances/:id/break':
      return ['agent', 'alliance_id'];
    case 'GET /api/v1/tournaments/:id/bracket':
    case 'POST /api/v1/tournaments/:id/enter':
      return ['tournament_id'];
    case 'POST /api/v1/market/swap/lightning-to-onchain':
      return ['agent', 'funded_wallet', 'onchain_address'];
    case 'GET /api/v1/market/swap/status/:swapId':
      return ['agent', 'swap_id'];
    case 'POST /api/v1/help':
      return ['agent', 'funded_wallet'];
    default:
      if (route.auth === 'agent') return ['agent'];
      return ['none'];
  }
}

export function buildRoutePlan(route) {
  const prereqs = prereqsForRoute(route);
  const needsOwnershipProbe = route.security?.requires_ownership === true
    && (
      route.path.includes(':')
      || route.security?.requires_signature === true
      || route.key === 'POST /api/v1/alliances/:id/accept'
      || route.key === 'POST /api/v1/alliances/:id/break'
    );

  return {
    actor: actorForRoute(route),
    lane: laneForDomain(route.domain),
    prereqs,
    needs_auth_probe: route.auth === 'agent',
    needs_signature_probe: route.security?.requires_signature === true,
    needs_ownership_probe: needsOwnershipProbe,
    needs_idempotency_probe: IDEMPOTENT_ROUTE_KEYS.has(route.key),
  };
}
