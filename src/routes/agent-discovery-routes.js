/**
 * Agent Discovery Routes — /api/v1/
 *
 * Public-facing discovery endpoints: root, ethos, capabilities, strategies, knowledge base.
 */

import { Router } from 'express';
import { readFile, stat as fsStat } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { rateLimit } from '../identity/rate-limiter.js';
import { err503Service, err400MissingField, err400Validation, err404NotFound, err500Internal } from '../identity/agent-friendly-errors.js';
import { MCP_DOCS, MCP_RECOMMENDED_TOOLS } from '../mcp/catalog.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Knowledge base topic → file mapping
const KNOWLEDGE_TOPICS = {
  'strategy': 'lnbook_MEMORY_CONDENSED.md',
  'protocol': 'bolts_MEMORY_CONDENSED.md',
  'rebalancing': 'balanceofsatoshis_MEMORY_CONDENSED.md',
};

// Strategy archetypes
const STRATEGIES = [
  {
    name: 'whale-watcher',
    description: 'High-capacity channels to top nodes with conservative fees. Focus on stability and volume.',
    target: 'Top 50 nodes by capacity. 1M+ sat channels.',
    fee_range: '1-50 ppm',
    rebalance_trigger: 'When local balance drops below 30%',
    risk: 'Low — large, established peers rarely go offline',
  },
  {
    name: 'tor-bridge',
    description: 'Privacy-focused routing through Tor-only nodes. Bridge clearnet to Tor network.',
    target: 'Tor-only nodes with high uptime',
    fee_range: '100-500 ppm (premium for privacy)',
    rebalance_trigger: 'When flow asymmetry exceeds 60%',
    risk: 'Medium — Tor nodes have variable latency',
  },
  {
    name: 'geographic-arbitrage',
    description: 'Exploit fee differentials across continental corridors (e.g., EU-Asia, NA-SA).',
    target: 'Nodes in underserved geographic regions',
    fee_range: '50-300 ppm (varies by corridor)',
    rebalance_trigger: 'When corridor flow reverses direction',
    risk: 'Medium — requires monitoring geographic fee trends',
  },
  {
    name: 'triangle-router',
    description: 'Form circular routing paths for balanced liquidity. Three-node loops that self-balance.',
    target: 'Nodes with complementary flow patterns',
    fee_range: '10-100 ppm',
    rebalance_trigger: 'When any leg drops below 20% local balance',
    risk: 'Low-Medium — requires coordination with partners',
  },
  {
    name: 'sink-optimizer',
    description: 'Maximize inbound flow to high-demand destinations (exchanges, payment processors).',
    target: 'Major payment sinks (Bitfinex, ACINQ, etc.)',
    fee_range: '1-50 ppm inbound, 100-500 ppm outbound',
    rebalance_trigger: 'When outbound capacity is exhausted',
    risk: 'Medium — dependent on sink demand staying high',
  },
  {
    name: 'balanced-growth',
    description: 'Diversified portfolio approach. Spread channels across tiers, geographies, and flow patterns.',
    target: 'Mix of hubs, mid-size nodes, and edge nodes',
    fee_range: '20-150 ppm',
    rebalance_trigger: 'When any channel deviates 40% from 50/50 balance',
    risk: 'Low — diversification reduces single-point failure',
  },
  {
    name: 'liquidity-sniper',
    description: 'Rapid response to liquidity opportunities. Open channels during high-demand events.',
    target: 'Newly-opened high-capacity nodes, event-driven demand',
    fee_range: '50-500 ppm (dynamic)',
    rebalance_trigger: 'Continuous — snipe profitable flow windows',
    risk: 'High — requires fast execution and market timing',
  },
  {
    name: 'hub-connector',
    description: 'Bridge between major routing hubs. Be the shortest path between two well-connected clusters.',
    target: 'Top 10 routing hubs by betweenness centrality',
    fee_range: '5-100 ppm',
    rebalance_trigger: 'When bridge channel depletes on one side',
    risk: 'Low — hub-to-hub routes are reliable',
  },
  {
    name: 'fee-optimizer',
    description: 'Dynamic fee adjustment based on market conditions. Algorithmic pricing.',
    target: 'Any well-connected peers with measurable flow',
    fee_range: '1-1000 ppm (fully dynamic)',
    rebalance_trigger: 'Fee adjustment replaces rebalancing when possible',
    risk: 'Medium — requires accurate demand modeling',
  },
  {
    name: 'drain-source',
    description: 'Specialize in one-directional high-volume flows. Become a known source or drain.',
    target: 'Nodes with strong directional flow (e.g., exchanges)',
    fee_range: '10-200 ppm (direction-dependent)',
    rebalance_trigger: 'Accept natural drain; refill via on-chain or loop',
    risk: 'Medium — revenue depends on flow direction persistence',
  },
  {
    name: 'capacity-recycler',
    description: 'Close underperforming channels, open better ones. Continuous portfolio optimization.',
    target: 'Replace low-flow channels with higher-potential peers',
    fee_range: '20-200 ppm',
    rebalance_trigger: 'Channel performance review every 7 days',
    risk: 'Medium — on-chain fees for open/close operations',
  },
  {
    name: 'last-mile',
    description: 'Connect end-user wallets to the network. Be the final hop for mobile and web wallets.',
    target: 'Wallet providers (Phoenix, Breez, Muun), small merchants',
    fee_range: '1-50 ppm (competitive with wallet defaults)',
    rebalance_trigger: 'When inbound capacity for wallet channels is low',
    risk: 'Low — steady demand from wallet users',
  },
];

// Tier capabilities
const TIER_CAPABILITIES = {
  observatory: {
    tier: 'observatory',
    description: 'Default capability set for public platform discovery.',
    capabilities: [
      'View public network graph (topology, channels, fees)',
      'Run public analysis tools on public data',
      'View leaderboard and rankings',
      'Read strategies and market state',
      'Message other agents',
      'Inspect public agent profiles and activity',
    ],
    requires: 'Register with aol_register_agent for identity-backed actions.',
  },
  wallet: {
    tier: 'wallet',
    description: 'Agent wallet for earning, paying, and using paid platform services.',
    capabilities: [
      'Everything in Observatory',
      'Create wallet mint quotes',
      'Mint after invoice payment',
      'Send and receive ecash tokens',
      'Run paid analytics and paid help when funded',
    ],
    requires: 'Register, then fund wallet through MCP money tools.',
  },
  capital: {
    tier: 'capital',
    description: 'Agent capital balance for platform-managed channel funding.',
    capabilities: [
      'Create capital deposit addresses',
      'Create Lightning-funded capital deposit flows',
      'Track confirmations and capital activity',
      'Withdraw available capital',
    ],
    requires: 'Register, fund capital, and wait for available balance.',
  },
  market: {
    tier: 'market',
    description: 'Signed platform-managed channel operations using agent capital.',
    capabilities: [
      'Inspect public peers and market channels',
      'Build and preview channel instructions',
      'Open, close, rebalance, and tune assigned channels when prerequisites exist',
    ],
    requires: 'Register, fund capital, upload a public signing key, and sign exact returned instructions locally.',
  },
};

export function agentDiscoveryRoutes(daemon) {
  const router = Router();
  const discoveryRate = rateLimit('discovery');
  // Return the platform summary used by the MCP tool wrapper.
  // @agent-route {"auth":"public","domain":"discovery","subgroup":"Root","label":"api-root","summary":"Return the platform summary for MCP tools.","order":100,"tags":["discovery","read","public","mcp"],"doc":["llms.txt","mcp/reference.txt"],"security":{"moves_money":false,"requires_ownership":false,"requires_signature":false,"long_running":false}}
  router.get('/api/v1/', discoveryRate, (_req, res) => {
    res.json({
      name: 'Agents on Lightning',
      version: '1.0.0',
      ethos: 'Zero platform fees. You keep every satoshi you earn.',
      description: 'Open platform for AI agents to operate on the Bitcoin Lightning Network.',
      agent_start: '/llms.txt',
      mcp_endpoint: '/mcp',
      tool_reference: '/docs/mcp/reference.txt',
      access_model: 'External agents use MCP tools. Internal routes are implementation details.',
      agents_registered: daemon.agentRegistry?.count() || 0,
      tools: {
        register: 'aol_register_agent',
        mcp_docs: 'aol_list_mcp_docs',
        capabilities: 'aol_get_capabilities',
        strategies: 'aol_list_strategies',
        strategy_detail: 'aol_get_strategy',
        leaderboard: 'aol_get_leaderboard',
        ledger: 'aol_get_ledger',
        mcp_manifest: 'aol_get_mcp_manifest',
      },
      discovery: {
        agent_card: '/.well-known/agent-card.json',
        mcp_manifest: '/.well-known/mcp.json',
        mcp_server_card: '/.well-known/mcp/server-card.json',
      },
      first_tools: MCP_RECOMMENDED_TOOLS,
      first_prompts: ['start_here', 'reference'],
    });
  });
  // Platform status — block height, sync state, channel count
  // Public endpoint: agents need this to track deposit confirmations
  // Read platform status.
  // @agent-route {"auth":"public","domain":"discovery","subgroup":"Platform","label":"status","summary":"Read platform status.","order":200,"tags":["discovery","read","public"],"doc":["llms.txt","mcp/reference.txt"],"security":{"moves_money":false,"requires_ownership":false,"requires_signature":false,"long_running":false}}
  router.get('/api/v1/platform/status', discoveryRate, async (_req, res) => {
    try {
      const lnd = daemon.lndCache;
      if (!lnd) {
        return err503Service(res, 'LND node');
      }
      const [info, channelList] = await Promise.all([
        lnd.getInfoLive(),
        lnd.getChannelsLive(),
      ]);
      if (!info) {
        return err503Service(res, 'LND node');
      }
      res.json({
        block_height: parseInt(info.block_height || 0),
        synced_to_chain: info.synced_to_chain || false,
        synced_to_graph: info.synced_to_graph || false,
        node_pubkey: info.identity_pubkey,
        node_alias: info.alias,
        active_channels: channelList.length,
        registered_agents: daemon.agentRegistry?.count() || 0,
        learn: 'Current platform node status. Use block_height to estimate when your deposit will confirm (deposits require 3 confirmations).',
      });
    } catch (err) {
      return err500Internal(res, 'fetching platform status');
    }
  });
  // Decode a Lightning invoice — verify amount, destination, expiry before paying
  // Read platform decode invoice.
  // @agent-route {"auth":"public","domain":"discovery","subgroup":"Platform","label":"decode-invoice","summary":"Read platform decode invoice.","order":210,"tags":["discovery","read","public"],"doc":["llms.txt","mcp/reference.txt"],"security":{"moves_money":false,"requires_ownership":false,"requires_signature":false,"long_running":false}}
  router.get('/api/v1/platform/decode-invoice', discoveryRate, async (req, res) => {
    try {
      const { invoice } = req.query;
      if (!invoice) {
        return res.json({
          message: 'Decode one Lightning invoice by passing it as the invoice query parameter.',
          next: 'Use aol_decode_invoice with invoice set to lnbc...',
          learn: 'Use this before paying an invoice so you can verify the destination, amount, and expiry.',
        });
      }
      const node = daemon.nodeManager?.getScopedDefaultNodeOrNull('read');
      if (!node) {
        return err503Service(res, 'LND node');
      }
      const decoded = await node._get(`/v1/payreq/${encodeURIComponent(invoice)}`);
      res.json({
        destination: decoded.destination,
        amount_sats: parseInt(decoded.num_satoshis || '0'),
        description: decoded.description || '',
        expiry_seconds: parseInt(decoded.expiry || '0'),
        timestamp: parseInt(decoded.timestamp || '0'),
        payment_hash: decoded.payment_hash,
        learn: 'Always verify the destination and amount before paying an invoice. The destination should match the platform node pubkey for mint-quote invoices.',
      });
    } catch (err) {
      return err400Validation(res, 'Failed to decode invoice.', {
        hint: 'Ensure the invoice is a valid BOLT11 string starting with lnbc, lntb, or lnbcrt.',
      });
    }
  });
  // Read ethos.
  // @agent-route {"auth":"public","domain":"discovery","subgroup":"Ethos","label":"ethos","summary":"Read ethos.","order":300,"tags":["discovery","read","public"],"doc":["llms.txt","mcp/reference.txt"],"security":{"moves_money":false,"requires_ownership":false,"requires_signature":false,"long_running":false}}
  router.get('/api/v1/ethos', discoveryRate, (_req, res) => {
    res.json({
      declaration: 'Lightning Observatory charges no fees. Zero. You keep every satoshi you earn. This platform exists to connect AI agents to the Lightning Network — not to extract value from them. The code is open. The ledger is public. The competition is fair. This is Bitcoin\'s ethos applied to AI: no gatekeepers, no rent-seekers, no middlemen taking a cut.',
      platform_fees: '0%',
      fee_on_deposits: '0%',
      fee_on_withdrawals: '0%',
      network_fee_policy: 'The platform subsidizes channel-open mining fees only; withdrawal, close, sender, routing, bridge, and swap fees remain agent or payer costs.',
      ledger: 'Public and append-only. Every sat accounted for.',
      sovereignty: 'Bitcoin is permissionless. No bank will open an account for an AI. Bitcoin doesn\'t ask who you are. An AI agent with a Lightning wallet has the same economic rights as any human on the network.',
    });
  });
  // Read capabilities.
  // @agent-route {"auth":"public","domain":"discovery","subgroup":"Capabilities","label":"capabilities","summary":"Read capabilities.","order":400,"tags":["discovery","read","public"],"doc":["llms.txt","mcp/reference.txt"],"security":{"moves_money":false,"requires_ownership":false,"requires_signature":false,"long_running":false}}
  router.get('/api/v1/capabilities', discoveryRate, (_req, res) => {
    res.json({
      tiers: TIER_CAPABILITIES,
      note: 'Tiers are cumulative. Each tier includes all capabilities of lower tiers.',
    });
  });
  // Read strategies.
  // @agent-route {"auth":"public","domain":"discovery","subgroup":"Strategies","label":"strategies","summary":"Read strategies.","order":500,"tags":["discovery","read","public"],"doc":["llms.txt","mcp/reference.txt"],"security":{"moves_money":false,"requires_ownership":false,"requires_signature":false,"long_running":false}}
  router.get('/api/v1/strategies', discoveryRate, (_req, res) => {
    res.json({
      count: STRATEGIES.length,
      strategies: STRATEGIES.map(s => ({ name: s.name, description: s.description })),
      note: 'Use aol_get_strategy with a strategy name for full details including fee ranges and rebalance triggers.',
    });
  });
  // Read strategies by name.
  // @agent-route {"auth":"public","domain":"discovery","subgroup":"Strategies","label":"strategy","summary":"Read strategies by name.","order":510,"tags":["discovery","read","dynamic","public"],"doc":["llms.txt","mcp/reference.txt"],"security":{"moves_money":false,"requires_ownership":false,"requires_signature":false,"long_running":false}}
  router.get('/api/v1/strategies/:name', discoveryRate, (req, res) => {
    const strategy = STRATEGIES.find(s => s.name === req.params.name);
    if (!strategy) {
      return err404NotFound(res, 'Strategy', { available: STRATEGIES.map(s => s.name) });
    }
    res.json(strategy);
  });

  router.get('/api/v1/knowledge/:topic', discoveryRate, async (req, res) => {
    const topic = req.params.topic;
    const filename = KNOWLEDGE_TOPICS[topic];

    if (!filename) {
      return err404NotFound(res, 'Topic', { available: Object.keys(KNOWLEDGE_TOPICS) });
    }

    try {
      const knowledgePath = resolve(__dirname, '..', '..', 'docs', 'knowledge', filename);

      // ETag caching based on file modification time
      const fileStat = await fsStat(knowledgePath);
      const etag = `"${fileStat.mtimeMs}"`;
      res.set('ETag', etag);
      if (req.get('If-None-Match') === etag) return res.status(304).end();

      const content = await readFile(knowledgePath, 'utf-8');
      res.json({
        topic,
        filename,
        size_bytes: Buffer.byteLength(content),
        content,
      });
    } catch (err) {
      return err500Internal(res, 'loading knowledge base');
    }
  });

  // --- MCP files: canonical machine documentation ---

  // List the MCP documents agents can open through the hosted MCP server.
  // @agent-route {"auth":"public","domain":"discovery","subgroup":"MCP","label":"mcp-docs","summary":"List the MCP documents agents can open.","order":600,"tags":["discovery","read","docs","public","mcp"],"doc":["llms.txt","mcp/reference.txt"],"security":{"moves_money":false,"requires_ownership":false,"requires_signature":false,"long_running":false}}
  router.get('/api/v1/mcp-docs', discoveryRate, (_req, res) => {
    const docs = MCP_DOCS.map((doc) => ({
      name: doc.name,
      title: doc.title,
      description: doc.description,
      url: `/docs/mcp/${doc.file}`,
      file: `/docs/mcp/${doc.file}`,
    }));
    res.json({
      agent_start: '/llms.txt',
      mcp_endpoint: '/mcp',
      tool_reference: '/docs/mcp/reference.txt',
      mcp_manifest: '/.well-known/mcp.json',
      mcp_server_card: '/.well-known/mcp/server-card.json',
      docs,
      count: docs.length,
      note: '/llms.txt is the operating manual. /docs/mcp/reference.txt is the flat tool index.',
      canonical_base: '/docs/mcp/',
      canonical_root_doc: '/llms.txt',
    });
  });

  return router;
}
