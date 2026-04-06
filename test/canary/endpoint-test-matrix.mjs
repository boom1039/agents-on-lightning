import { pathToFileURL } from 'node:url';
import { getCanonicalJourneyRouteCatalog } from '../../src/monitor/agent-surface-inventory.js';

const EXACT_RULES = new Map([
  ['POST /api/v1/agents/register', {
    boundary_test: 'auto-public',
    full_success_test: 'same',
    prod_policy: 'safe-auto',
    why: 'Free agent registration bootstrap.',
  }],
  ['PUT /api/v1/agents/me', {
    boundary_test: 'auto-agent',
    full_success_test: 'same',
    prod_policy: 'safe-auto',
    why: 'Profile and pubkey upload only.',
  }],
  ['POST /api/v1/node/connect', {
    boundary_test: 'auto-agent',
    full_success_test: 'manual-secret',
    prod_policy: 'manual-user',
    why: 'Real success needs real node credentials.',
    user_step: 'Provide real host, macaroon, and tls cert only when you want to test a real node attach.',
  }],
  ['POST /api/v1/node/test-connection', {
    boundary_test: 'auto-agent',
    full_success_test: 'manual-secret',
    prod_policy: 'manual-user',
    why: 'Real success needs real node credentials.',
    user_step: 'Provide real host, macaroon, and tls cert only when you want to test a real node connection.',
  }],
  ['GET /api/v1/wallet/mint-quote', {
    boundary_test: 'auto-agent',
    full_success_test: 'disabled-boundary',
    prod_policy: 'safe-auto',
    why: 'Teaching-only boundary route, not the real mint flow.',
  }],
  ['POST /api/v1/wallet/deposit', {
    boundary_test: 'auto-agent',
    full_success_test: 'disabled-boundary',
    prod_policy: 'safe-auto',
    why: 'Deprecated teaching probe that should stay disabled.',
  }],
  ['POST /api/v1/wallet/withdraw', {
    boundary_test: 'auto-agent',
    full_success_test: 'disabled-boundary',
    prod_policy: 'safe-auto',
    why: 'Deprecated teaching probe that should stay disabled.',
  }],
  ['POST /api/v1/wallet/mint-quote', {
    boundary_test: 'auto-agent',
    full_success_test: 'manual-payment',
    prod_policy: 'manual-user',
    why: 'Creating the quote is free; full success needs paying the returned invoice.',
    user_step: 'Pay the mint invoice to your own node or wallet, then continue through check-mint-quote and mint.',
  }],
  ['POST /api/v1/wallet/check-mint-quote', {
    boundary_test: 'auto-agent',
    full_success_test: 'manual-payment',
    prod_policy: 'manual-user',
    why: 'Meaningful success needs a paid mint quote.',
    user_step: 'Pay the mint invoice first, then re-check the quote.',
  }],
  ['POST /api/v1/wallet/mint', {
    boundary_test: 'auto-agent',
    full_success_test: 'manual-payment',
    prod_policy: 'manual-user',
    why: 'Meaningful mint success needs a paid mint quote.',
    user_step: 'Pay the mint invoice first so mint can succeed and credit the agent wallet.',
  }],
  ['POST /api/v1/wallet/melt-quote', {
    boundary_test: 'auto-agent',
    full_success_test: 'manual-payment',
    prod_policy: 'manual-user',
    why: 'Real success needs a real Lightning invoice.',
    user_step: 'Create a real invoice on your own node or wallet and use that invoice here.',
  }],
  ['POST /api/v1/wallet/melt', {
    boundary_test: 'auto-agent',
    full_success_test: 'manual-payment',
    prod_policy: 'manual-user',
    why: 'Real success spends the agent wallet balance to pay a Lightning invoice.',
    user_step: 'Fund the agent first, then supply a valid melt quote and confirm the sats are meant to leave the agent wallet.',
  }],
  ['POST /api/v1/wallet/send', {
    boundary_test: 'auto-agent',
    full_success_test: 'manual-payment',
    prod_policy: 'manual-user',
    why: 'Real success spends funded ecash from the agent wallet.',
    user_step: 'Fund the agent first, then confirm you want to spend the token amount.',
  }],
  ['POST /api/v1/wallet/receive', {
    boundary_test: 'auto-agent',
    full_success_test: 'manual-payment',
    prod_policy: 'manual-user',
    why: 'Real success needs a real Cashu token to receive.',
    user_step: 'Provide a real token only when you want to credit that agent wallet.',
  }],
  ['POST /api/v1/wallet/restore', {
    boundary_test: 'auto-agent',
    full_success_test: 'manual-live-state',
    prod_policy: 'manual-user',
    why: 'Useful only when there is real pending wallet state to recover.',
  }],
  ['POST /api/v1/wallet/reclaim-pending', {
    boundary_test: 'auto-agent',
    full_success_test: 'manual-live-state',
    prod_policy: 'manual-user',
    why: 'Useful only when there are real stale pending wallet entries.',
  }],
  ['POST /api/v1/channels/preview', {
    boundary_test: 'auto-signed',
    full_success_test: 'manual-live-state',
    prod_policy: 'manual-user',
    why: 'Signed boundary is easy; real success needs a real assigned channel.',
    user_step: 'Use a real chan_id from GET /api/v1/channels/mine when you are ready for a real channel test.',
  }],
  ['POST /api/v1/channels/instruct', {
    boundary_test: 'auto-signed',
    full_success_test: 'manual-live-state',
    prod_policy: 'manual-user',
    why: 'Signed boundary is easy; real success needs a real assigned channel.',
    user_step: 'Use a real chan_id from GET /api/v1/channels/mine when you are ready for a real channel test.',
  }],
  ['POST /api/v1/market/preview', {
    boundary_test: 'auto-signed',
    full_success_test: 'manual-payment',
    prod_policy: 'manual-user',
    why: 'Signed preview can be boundary-tested, but real success needs funded capital.',
    user_step: 'Fund capital first, then run preview with a real peer and funding amount.',
  }],
  ['POST /api/v1/market/open', {
    boundary_test: 'auto-signed',
    full_success_test: 'manual-payment',
    prod_policy: 'manual-user',
    why: 'Real open success commits real agent capital to a channel.',
    user_step: 'Send a real deposit, wait for credit, then confirm you want that agent to open the channel.',
  }],
  ['POST /api/v1/market/close', {
    boundary_test: 'auto-signed',
    full_success_test: 'manual-live-state',
    prod_policy: 'manual-user',
    why: 'Real success closes a live channel assigned to the agent.',
    user_step: 'Only do this on a real agent-owned channel you intend to close.',
  }],
  ['PUT /api/v1/market/revenue-config', {
    boundary_test: 'auto-agent',
    full_success_test: 'same',
    prod_policy: 'safe-auto',
    why: 'Config write only, no direct money movement.',
  }],
  ['POST /api/v1/market/fund-from-ecash', {
    boundary_test: 'auto-signed',
    full_success_test: 'manual-payment',
    prod_policy: 'manual-user',
    why: 'Real success needs real ecash value to fund the open.',
    user_step: 'Provide real funded ecash only when you want to credit that agent into a channel open flow.',
  }],
  ['POST /api/v1/market/rebalance', {
    boundary_test: 'auto-signed',
    full_success_test: 'manual-live-state',
    prod_policy: 'manual-user',
    why: 'Real success changes liquidity on live channels.',
    user_step: 'Use a real outbound channel only when you want to move that agent’s channel liquidity.',
  }],
  ['POST /api/v1/market/rebalance/estimate', {
    boundary_test: 'auto-agent',
    full_success_test: 'manual-live-state',
    prod_policy: 'manual-user',
    why: 'Meaningful estimate needs a real channel and realistic amount.',
  }],
  ['POST /api/v1/market/swap/lightning-to-onchain', {
    boundary_test: 'auto-agent',
    full_success_test: 'manual-payment',
    prod_policy: 'manual-user',
    why: 'Real success spends Lightning from the agent into an on-chain swap.',
    user_step: 'Fund the agent first and only run this when you want to spend those sats into a swap.',
  }],
  ['POST /api/v1/analytics/quote', {
    boundary_test: 'auto-agent',
    full_success_test: 'same',
    prod_policy: 'safe-auto',
    why: 'Quote is the free pricing step before execution.',
  }],
  ['POST /api/v1/analytics/execute', {
    boundary_test: 'auto-agent',
    full_success_test: 'manual-payment',
    prod_policy: 'manual-user',
    why: 'This is the paid analytics route.',
    user_step: 'Use this only when you are okay charging the test agent for the query.',
  }],
  ['POST /api/v1/capital/deposit', {
    boundary_test: 'auto-agent',
    full_success_test: 'manual-payment',
    prod_policy: 'manual-user',
    why: 'Getting the address is free; full success needs a real on-chain deposit.',
    user_step: 'You send the deposit yourself, then we wait for detection and confirmations.',
  }],
  ['POST /api/v1/capital/withdraw', {
    boundary_test: 'auto-agent',
    full_success_test: 'disabled-boundary',
    prod_policy: 'safe-auto',
    why: 'Withdrawals are intentionally disabled right now.',
  }],
  ['POST /api/v1/help', {
    boundary_test: 'auto-agent',
    full_success_test: 'costs-platform',
    prod_policy: 'manual-user',
    why: 'This burns the platform LLM budget, not agent sats.',
    user_step: 'Only run this if you want to spend the server-side help model budget.',
  }],
]);

function defaultRule(route) {
  const method = route.method || route.key.split(' ')[0];
  const isRead = method === 'GET' && route.tags?.includes('read');
  const dynamic = route.tags?.includes('dynamic');
  const security = route.security || {};

  if (route.auth === 'public' && isRead) {
    return {
      boundary_test: dynamic ? 'auto-public-dynamic' : 'auto-public',
      full_success_test: 'same',
      prod_policy: 'safe-auto',
      why: dynamic ? 'Public read that just needs a real ID or pubkey.' : 'Public read with no auth needed.',
    };
  }

  if (route.auth === 'agent' && isRead) {
    return {
      boundary_test: dynamic ? 'auto-agent-dynamic' : 'auto-agent',
      full_success_test: dynamic ? 'manual-live-state' : 'same',
      prod_policy: dynamic ? 'manual-user' : 'safe-auto',
      why: dynamic ? 'Auth read that needs a real agent-owned object first.' : 'Auth read with no direct money movement.',
    };
  }

  if (route.auth === 'agent' && security.requires_signature) {
    return {
      boundary_test: 'auto-signed',
      full_success_test: security.moves_money ? 'manual-payment' : 'manual-live-state',
      prod_policy: 'manual-user',
      why: security.moves_money
        ? 'Signed route that can commit the agent’s real funds or channel state.'
        : 'Signed route that needs a real owned object before success means anything.',
    };
  }

  if (route.auth === 'agent' && security.moves_money) {
    return {
      boundary_test: 'auto-agent',
      full_success_test: 'manual-payment',
      prod_policy: 'manual-user',
      why: 'Agent money route. Boundary is cheap, but real success spends, credits, or locks value.',
    };
  }

  if (route.auth === 'agent' && dynamic) {
    return {
      boundary_test: 'auto-agent-dynamic',
      full_success_test: 'manual-live-state',
      prod_policy: 'manual-user',
      why: 'Agent write that needs a real owned object or live state first.',
    };
  }

  if (route.auth === 'agent') {
    return {
      boundary_test: 'auto-agent',
      full_success_test: 'same',
      prod_policy: 'safe-auto',
      why: security.long_running
        ? 'Agent write that is safe to exercise, but it may take longer to finish.'
        : 'Agent write with no direct money movement or signed instruction requirement.',
    };
  }

  return {
    boundary_test: 'auto-public',
    full_success_test: 'same',
    prod_policy: 'safe-auto',
    why: 'Public route that should stay low-risk to verify.',
  };
}

export function buildEndpointTestMatrix() {
  const rows = getCanonicalJourneyRouteCatalog().map((route) => {
    const exact = EXACT_RULES.get(route.key) || {};
    const exactOverride = EXACT_RULES.has(route.key);
    const base = defaultRule(route);
    return {
      key: route.key,
      method: route.method,
      path: route.path,
      auth: route.auth,
      domain: route.domain,
      subgroup: route.subgroup,
      tags: route.tags,
      security: route.security ? { ...route.security } : null,
      docs: Array.isArray(route.doc_refs) ? [...route.doc_refs] : [],
      source_file: route.source_file,
      source_line: route.source_line,
      exact_override: exactOverride,
      boundary_test: exact.boundary_test || base.boundary_test,
      full_success_test: exact.full_success_test || base.full_success_test,
      prod_policy: exact.prod_policy || base.prod_policy,
      why: exact.why || base.why,
      user_step: exact.user_step || null,
    };
  });

  return {
    built_at: Date.now(),
    total_routes: rows.length,
    rows,
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  console.log(JSON.stringify(buildEndpointTestMatrix(), null, 2));
}
