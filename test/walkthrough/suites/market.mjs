import {
  DEFAULT_MARKET_PEER,
  assertHelpful,
  assertSafe,
  assertSignedBoundary,
  assertStatus,
} from '../coverage-helpers.mjs';
import {
  expectHelpful,
  expectSafe,
  expectSignedBoundary,
  expectStatus,
  reqAuth,
  reqPublic,
} from '../agent-coverage-scoring.mjs';

const VALID_LOOKING_CHANNEL_POINT = `${'0'.repeat(64)}:0`;
const AUTH = reqAuth();
const PUBLIC = reqPublic();

function openPayload(ctx) {
  const openAmountSats = ctx.options.openAmountSats || 100000;
  return ctx.signInstructionPayload('channel_open', {
    params: {
      peer_pubkey: ctx.options.openPeerPubkey || DEFAULT_MARKET_PEER,
      local_funding_amount_sats: openAmountSats,
      base_fee_msat: 1000,
      fee_rate_ppm: 120,
      min_htlc_msat: 1000,
      time_lock_delta: 40,
      max_htlc_msat: Math.max(1000, openAmountSats * 1000 - 1000),
    },
  });
}

export const suite = {
  name: 'market',
  phases: [
    {
      name: 'public-market-read',
      covers: [
        'GET /api/v1/market/config',
        'GET /api/v1/market/rankings',
        'GET /api/v1/market/overview',
        'GET /api/v1/market/channels',
        'GET /api/v1/market/agent/:agentId',
        'GET /api/v1/market/peer-safety/:pubkey',
        'GET /api/v1/market/fees/:peerPubkey',
      ],
      agent_expectations: {
        'GET /api/v1/market/config': expectSafe(PUBLIC),
        'GET /api/v1/market/rankings': expectSafe(PUBLIC),
        'GET /api/v1/market/overview': expectSafe(PUBLIC),
        'GET /api/v1/market/channels': expectSafe(PUBLIC),
        'GET /api/v1/market/agent/:agentId': expectSafe(PUBLIC),
        'GET /api/v1/market/peer-safety/:pubkey': expectSafe(PUBLIC),
        'GET /api/v1/market/fees/:peerPubkey': expectSafe(PUBLIC),
      },
      setup: ['auth'],
      async run(ctx) {
        const agent = await ctx.ensureAgent(0);

        const config = await ctx.request('GET', '/api/v1/market/config');
        assertSafe(config, 'GET /api/v1/market/config');

        const rankings = await ctx.request('GET', '/api/v1/market/rankings');
        assertSafe(rankings, 'GET /api/v1/market/rankings');

        const overview = await ctx.request('GET', '/api/v1/market/overview');
        assertSafe(overview, 'GET /api/v1/market/overview');

        const channels = await ctx.request('GET', '/api/v1/market/channels');
        assertSafe(channels, 'GET /api/v1/market/channels');

        const byAgent = await ctx.request('GET', `/api/v1/market/agent/${encodeURIComponent(agent.agent_id)}`);
        assertSafe(byAgent, 'GET /api/v1/market/agent/:agentId');

        const peerSafety = await ctx.request('GET', `/api/v1/market/peer-safety/${ctx.options.openPeerPubkey || DEFAULT_MARKET_PEER}`);
        assertSafe(peerSafety, 'GET /api/v1/market/peer-safety/:pubkey');

        const fees = await ctx.request('GET', `/api/v1/market/fees/${ctx.options.openPeerPubkey || DEFAULT_MARKET_PEER}`);
        assertSafe(fees, 'GET /api/v1/market/fees/:peerPubkey');
        return 'Covered public market transparency routes.';
      },
    },
    {
      name: 'teaching-surfaces',
      covers: [
        'GET /api/v1/market/preview',
        'GET /api/v1/market/open',
        'GET /api/v1/market/close',
      ],
      agent_expectations: {
        'GET /api/v1/market/preview': expectHelpful(405, AUTH, ['see']),
        'GET /api/v1/market/open': expectHelpful(405, AUTH, ['see']),
        'GET /api/v1/market/close': expectHelpful(405, AUTH, ['see']),
      },
      setup: ['auth'],
      async run(ctx) {
        const preview = await ctx.request('GET', '/api/v1/market/preview', { authAgent: 0 });
        assertHelpful(preview, 405, 'GET /api/v1/market/preview', ['see']);

        const open = await ctx.request('GET', '/api/v1/market/open', { authAgent: 0 });
        assertHelpful(open, 405, 'GET /api/v1/market/open', ['see']);

        const close = await ctx.request('GET', '/api/v1/market/close', { authAgent: 0 });
        assertHelpful(close, 405, 'GET /api/v1/market/close', ['see']);
        return 'Verified 405 teaching contracts for market write routes.';
      },
    },
    {
      name: 'open-flow',
      covers: [
        'POST /api/v1/market/preview',
        'POST /api/v1/market/open',
        'GET /api/v1/market/pending',
      ],
      agent_expectations: () => ({
        'POST /api/v1/market/preview': expectSignedBoundary(reqAuth({ bodyKeys: ['instruction', 'signature'] })),
        'POST /api/v1/market/open': expectSignedBoundary(reqAuth({ bodyKeys: ['instruction', 'signature'] })),
        'GET /api/v1/market/pending': expectStatus(200, AUTH),
      }),
      setup: ['auth', 'registered_pubkey'],
      async run(ctx) {
        const previewPayload = openPayload(ctx);
        const preview = await ctx.request('POST', '/api/v1/market/preview', {
          authAgent: 0,
          body: previewPayload,
        });
        assertSafe(preview, 'POST /api/v1/market/preview');
        assertSignedBoundary(preview, 'POST /api/v1/market/preview');

        const openPayloadBody = openPayload(ctx);
        const open = await ctx.request('POST', '/api/v1/market/open', {
          authAgent: 0,
          body: openPayloadBody,
        });
        assertSafe(open, 'POST /api/v1/market/open');
        assertSignedBoundary(open, 'POST /api/v1/market/open');

        const pending = await ctx.request('GET', '/api/v1/market/pending', { authAgent: 0 });
        assertStatus(pending, 200, 'GET /api/v1/market/pending');
        return 'Covered signed preview/open requests and pending-open listing.';
      },
    },
    {
      name: 'close-revenue-performance',
      covers: [
        'POST /api/v1/market/close',
        'GET /api/v1/market/closes',
        'GET /api/v1/market/revenue',
        'GET /api/v1/market/revenue/:chanId',
        'PUT /api/v1/market/revenue-config',
        'GET /api/v1/market/performance',
        'GET /api/v1/market/performance/:chanId',
      ],
      agent_expectations: {
        'POST /api/v1/market/close': expectSignedBoundary(reqAuth({ bodyKeys: ['instruction', 'signature'] })),
        'GET /api/v1/market/closes': expectStatus(200, AUTH),
        'GET /api/v1/market/revenue': expectStatus(200, AUTH),
        'GET /api/v1/market/revenue/:chanId': expectSafe(AUTH),
        'PUT /api/v1/market/revenue-config': expectSafe(reqAuth({ bodyKeys: ['destination'] })),
        'GET /api/v1/market/performance': expectStatus(200, AUTH),
        'GET /api/v1/market/performance/:chanId': expectSafe(AUTH),
      },
      setup: ['auth', 'registered_pubkey'],
      async run(ctx) {
        const channelPoint = VALID_LOOKING_CHANNEL_POINT;

        const closePayload = ctx.signInstructionPayload('channel_close', {
          params: { channel_point: channelPoint },
        });
        const close = await ctx.request('POST', '/api/v1/market/close', {
          authAgent: 0,
          body: closePayload,
        });
        assertSafe(close, 'POST /api/v1/market/close');
        assertSignedBoundary(close, 'POST /api/v1/market/close');

        const closes = await ctx.request('GET', '/api/v1/market/closes', { authAgent: 0 });
        assertStatus(closes, 200, 'GET /api/v1/market/closes');

        const revenue = await ctx.request('GET', '/api/v1/market/revenue', { authAgent: 0 });
        assertStatus(revenue, 200, 'GET /api/v1/market/revenue');

        const revenueById = await ctx.request('GET', `/api/v1/market/revenue/${encodeURIComponent(channelPoint)}`, { authAgent: 0 });
        assertSafe(revenueById, 'GET /api/v1/market/revenue/:chanId');

        const config = await ctx.request('PUT', '/api/v1/market/revenue-config', {
          authAgent: 0,
          body: { destination: 'capital' },
        });
        assertSafe(config, 'PUT /api/v1/market/revenue-config');

        const performance = await ctx.request('GET', '/api/v1/market/performance', { authAgent: 0 });
        assertStatus(performance, 200, 'GET /api/v1/market/performance');

        const performanceById = await ctx.request('GET', `/api/v1/market/performance/${encodeURIComponent(channelPoint)}`, { authAgent: 0 });
        assertSafe(performanceById, 'GET /api/v1/market/performance/:chanId');
        return 'Covered close, revenue, and performance routes.';
      },
    },
    {
      name: 'swap-ecash-and-rebalance',
      covers: [
        'GET /api/v1/market/swap/quote',
        'POST /api/v1/market/swap/lightning-to-onchain',
        'GET /api/v1/market/swap/status/:swapId',
        'GET /api/v1/market/swap/history',
        'POST /api/v1/market/fund-from-ecash',
        'GET /api/v1/market/fund-from-ecash/:flowId',
        'POST /api/v1/market/rebalance/estimate',
        'POST /api/v1/market/rebalance',
        'GET /api/v1/market/rebalances',
      ],
      agent_expectations: {
        'GET /api/v1/market/swap/quote': expectSafe(reqAuth({ queryKeys: ['amount_sats'] })),
        'POST /api/v1/market/swap/lightning-to-onchain': expectSafe(reqAuth({ bodyKeys: ['amount_sats', 'destination_address'] })),
        'GET /api/v1/market/swap/status/:swapId': expectSafe(AUTH),
        'GET /api/v1/market/swap/history': expectStatus(200, AUTH),
        'POST /api/v1/market/fund-from-ecash': expectSafe(reqAuth({ bodyKeys: ['instruction', 'signature'] })),
        'GET /api/v1/market/fund-from-ecash/:flowId': expectSafe(AUTH),
        'POST /api/v1/market/rebalance/estimate': expectSafe(reqAuth({ bodyKeys: ['outbound_chan_id', 'amount_sats'] })),
        'POST /api/v1/market/rebalance': expectSignedBoundary(reqAuth({ bodyKeys: ['instruction', 'signature'] })),
        'GET /api/v1/market/rebalances': expectStatus(200, AUTH),
      },
      setup: ['auth', 'registered_pubkey'],
      async run(ctx) {
        const swapQuote = await ctx.request('GET', '/api/v1/market/swap/quote?amount_sats=100000', { authAgent: 0 });
        assertSafe(swapQuote, 'GET /api/v1/market/swap/quote');

        const swapCreate = await ctx.request('POST', '/api/v1/market/swap/lightning-to-onchain', {
          authAgent: 0,
          body: {
            amount_sats: 100000,
            destination_address: 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kygt080',
          },
        });
        assertSafe(swapCreate, 'POST /api/v1/market/swap/lightning-to-onchain');

        const swapStatus = await ctx.request('GET', '/api/v1/market/swap/status/missing-swap-id', { authAgent: 0 });
        assertSafe(swapStatus, 'GET /api/v1/market/swap/status/:swapId');

        const swapHistory = await ctx.request('GET', '/api/v1/market/swap/history', { authAgent: 0 });
        assertStatus(swapHistory, 200, 'GET /api/v1/market/swap/history');

        const ecashOpen = ctx.signInstructionPayload('channel_open', {
          params: {
            peer_pubkey: ctx.options.openPeerPubkey || DEFAULT_MARKET_PEER,
            local_funding_amount_sats: ctx.options.openAmountSats,
          },
        });
        const fundFromEcash = await ctx.request('POST', '/api/v1/market/fund-from-ecash', {
          authAgent: 0,
          body: ecashOpen,
        });
        assertSafe(fundFromEcash, 'POST /api/v1/market/fund-from-ecash');

        const ecashStatus = await ctx.request('GET', '/api/v1/market/fund-from-ecash/missing-flow-id', { authAgent: 0 });
        assertSafe(ecashStatus, 'GET /api/v1/market/fund-from-ecash/:flowId');

        const outboundChanId = ctx.state.assignedChannel?.chan_id || 'missing-outbound-chan';
        const estimate = await ctx.request('POST', '/api/v1/market/rebalance/estimate', {
          authAgent: 0,
          body: {
            outbound_chan_id: outboundChanId,
            amount_sats: 10_000,
          },
        });
        assertSafe(estimate, 'POST /api/v1/market/rebalance/estimate');

        const rebalancePayload = ctx.signInstructionPayload('rebalance', {
          params: {
            outbound_chan_id: outboundChanId,
            amount_sats: 10_000,
            max_fee_sats: 10,
          },
        });
        const rebalance = await ctx.request('POST', '/api/v1/market/rebalance', {
          authAgent: 0,
          body: rebalancePayload,
        });
        assertSafe(rebalance, 'POST /api/v1/market/rebalance');
        assertSignedBoundary(rebalance, 'POST /api/v1/market/rebalance');

        const history = await ctx.request('GET', '/api/v1/market/rebalances', { authAgent: 0 });
        assertStatus(history, 200, 'GET /api/v1/market/rebalances');
        return 'Covered swap, ecash funding, and rebalance routes.';
      },
    },
  ],
};
