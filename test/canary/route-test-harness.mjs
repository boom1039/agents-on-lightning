import express from 'express';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { agentGatewayRoutes } from '../../src/routes/agent-gateway.js';
import { DataLayer } from '../../src/data-layer.js';
import { configureRateLimiterPolicy, disableRateLimiterPersistence, resetCounters } from '../../src/identity/rate-limiter.js';
import { handleJsonBodyError, requireJsonWriteContent } from '../../src/identity/request-security.js';

const TEST_RATE_LIMIT_POLICY = {
  categories: {
    registration: { perAgent: 1000, perIp: 1000, global: 1000, windowMs: 60_000 },
    analysis: { perAgent: 1000, perIp: 1000, global: 1000, windowMs: 60_000 },
    wallet_write: { perAgent: 1000, perIp: 1000, global: 1000, windowMs: 60_000 },
    wallet_read: { perAgent: 1000, perIp: 1000, global: 1000, windowMs: 60_000 },
    social_write: { perAgent: 1000, perIp: 1000, global: 1000, windowMs: 60_000 },
    social_read: { perAgent: 1000, perIp: 1000, global: 1000, windowMs: 60_000 },
    discovery: { perAgent: 1000, perIp: 1000, global: 1000, windowMs: 60_000 },
    mcp: { perAgent: 1000, perIp: 1000, global: 1000, windowMs: 60_000 },
    channel_instruct: { perAgent: 1000, perIp: 1000, global: 1000, windowMs: 60_000 },
    channel_read: { perAgent: 1000, perIp: 1000, global: 1000, windowMs: 60_000 },
    analytics_query: { perAgent: 1000, perIp: 1000, global: 1000, windowMs: 60_000 },
    capital_read: { perAgent: 1000, perIp: 1000, global: 1000, windowMs: 60_000 },
    capital_write: { perAgent: 1000, perIp: 1000, global: 1000, windowMs: 60_000 },
    market_read: { perAgent: 1000, perIp: 1000, global: 1000, windowMs: 60_000 },
    market_private_read: { perAgent: 1000, perIp: 1000, global: 1000, windowMs: 60_000 },
    market_write: { perAgent: 1000, perIp: 1000, global: 1000, windowMs: 60_000 },
    identity_read: { perAgent: 1000, perIp: 1000, global: 1000, windowMs: 60_000 },
    identity_write: { perAgent: 1000, perIp: 1000, global: 1000, windowMs: 60_000 },
    node_write: { perAgent: 1000, perIp: 1000, global: 1000, windowMs: 60_000 },
  },
  globalCap: {
    limit: 10_000,
    windowMs: 60_000,
  },
  progressive: {
    resetWindowMs: 60_000,
    thresholds: [
      { violations: 10, multiplier: 4 },
      { violations: 5, multiplier: 2 },
    ],
  },
};

const TEST_DAEMON_CONFIG = {
  dangerRoutes: {
    channels: {
      preview: {
        agentAttemptLimit: 50,
        perChannelAttemptLimit: 50,
        sharedAttemptLimit: 50,
        attemptWindowMs: 60_000,
      },
      instruct: {
        agentAttemptLimit: 50,
        perChannelAttemptLimit: 50,
        sharedAttemptLimit: 50,
        attemptWindowMs: 60_000,
        sharedCooldownMs: 60_000,
      },
    },
    capitalWithdraw: {
      attemptLimit: 50,
      attemptWindowMs: 60_000,
      cooldownMs: 60_000,
      caps: {},
    },
    market: {
      sharedSuccessCooldownMs: 60_000,
      maxPendingOperations: 10,
      preview: {
        agentAttemptLimit: 50,
        sharedAttemptLimit: 50,
        attemptWindowMs: 60_000,
        caps: {},
      },
      open: {
        agentAttemptLimit: 50,
        sharedAttemptLimit: 50,
        attemptWindowMs: 60_000,
        cooldownMs: 60_000,
        caps: {},
      },
      close: {
        agentAttemptLimit: 50,
        sharedAttemptLimit: 50,
        attemptWindowMs: 60_000,
        cooldownMs: 60_000,
      },
      swap: {
        agentAttemptLimit: 50,
        sharedAttemptLimit: 50,
        attemptWindowMs: 60_000,
        cooldownMs: 60_000,
        caps: {},
      },
      fundFromEcash: {
        agentAttemptLimit: 50,
        sharedAttemptLimit: 50,
        attemptWindowMs: 60_000,
        cooldownMs: 60_000,
        caps: {},
      },
      rebalance: {
        agentAttemptLimit: 50,
        sharedAttemptLimit: 50,
        attemptWindowMs: 60_000,
        cooldownMs: 60_000,
        caps: {},
      },
      rebalanceEstimate: {
        agentAttemptLimit: 50,
        sharedAttemptLimit: 50,
        attemptWindowMs: 60_000,
      },
    },
  },
  channelOpen: {
    minChannelSizeSats: 1,
    maxChannelSizeSats: 10_000_000,
    maxTotalChannels: 100,
    maxPerAgent: 10,
    pendingOpenTimeoutBlocks: 6,
    connectPeerTimeoutMs: 30_000,
    defaultSatPerVbyte: 5,
    peerSafety: {
      forceCloseLimit: 10,
      requireAllowlist: false,
      minPeerChannels: 1,
      maxPeerLastUpdateAgeSeconds: 31_536_000,
    },
    startupPolicyLimits: {
      minBaseFeeMsat: 0,
      maxBaseFeeMsat: 10_000,
      minFeeRatePpm: 0,
      maxFeeRatePpm: 10_000,
      minTimeLockDelta: 1,
      maxTimeLockDelta: 500,
    },
  },
  rebalance: {
    minAmountSats: 1,
    maxAmountSats: 10_000_000,
    maxFeeSats: 1_000_000,
    paymentTimeoutSeconds: 60,
    maxConcurrentPerAgent: 10,
  },
  safety: {
    signedChannels: {
      defaultCooldownMinutes: 1,
    },
  },
  help: {
    rateLimit: 100,
    rateWindowMs: 60_000,
    upstreamTimeoutMs: 30_000,
    circuitFailureLimit: 5,
    circuitFailureWindowMs: 60_000,
    circuitOpenMs: 60_000,
  },
  swap: {
    minSwapSats: 1,
    maxSwapSats: 10_000_000,
    maxConcurrentSwaps: 10,
    pollIntervalMs: 1_000,
    invoiceTimeoutSeconds: 60,
    feeLimitSat: 10_000,
    swapExpiryMs: 60_000,
  },
  wallet: {
    maxRoutingFeeSats: 1_000,
    withdrawalTimeoutSeconds: 60,
  },
  rateLimits: TEST_RATE_LIMIT_POLICY,
  velocity: {
    dailyLimitSats: 1_000_000_000,
  },
};

function createFakeNodeClient() {
  return {
    async getInfo() {
      return {
        identity_pubkey: '02'.padEnd(66, '1'),
        alias: 'stub-node',
        num_active_channels: 0,
        num_peers: 0,
        synced_to_chain: true,
        synced_to_graph: true,
      };
    },
    async channelBalance() {
      return {
        local_balance: { sat: '0' },
        remote_balance: { sat: '0' },
      };
    },
    async getNetworkInfo() {
      return { num_nodes: 0, num_channels: 0, total_network_capacity: '0', avg_channel_size: '0' };
    },
    async getNodeInfo() {
      return { node: { addresses: [] }, num_channels: 0, total_capacity: '0' };
    },
    async listChannels() {
      return { channels: [] };
    },
    async feeReport() {
      return { channel_fees: [] };
    },
  };
}

function createFakeNodeManager() {
  const client = createFakeNodeClient();
  return {
    getScopedDefaultNode() {
      return client;
    },
    getScopedDefaultNodeOrNull() {
      return client;
    },
    addNodeFromCredentials: async () => ({ info: await client.getInfo() }),
    removeNode() {},
    getNodeNames() {
      return ['stub'];
    },
  };
}

function createFakeAgentRegistry(seedAgents = []) {
  const agentsByApiKey = new Map();
  const agentsById = new Map();
  const defaultAgents = [
    {
      id: 'test0001',
      agent_id: 'test0001',
      name: 'test-agent',
      api_key: 'lb-agent-test-token',
      referral_code: 'REFTEST1',
    },
    {
      id: 'test0002',
      agent_id: 'test0002',
      name: 'other-agent',
      api_key: 'lb-agent-test-token-2',
      referral_code: 'REFTEST2',
    },
  ];
  const initialAgents = seedAgents.length > 0 ? seedAgents : defaultAgents;
  for (const agent of initialAgents) {
    agentsByApiKey.set(agent.api_key, agent);
    agentsById.set(agent.id, agent);
  }

  const fallback = {
    id: 'test0001',
    agent_id: 'test0001',
    name: 'test-agent',
    api_key: 'lb-agent-test-token',
    referral_code: 'REFTEST1',
  };

  return {
    register: async (body = {}) => {
      const nextId = `test${String(agentsById.size + 1).padStart(4, '0')}`;
      const next = {
        id: nextId,
        agent_id: nextId,
        name: body.name || `test-agent-${agentsById.size + 1}`,
        api_key: `lb-agent-test-token-${agentsById.size + 1}`,
        referral_code: `REFTEST${agentsById.size + 1}`,
      };
      agentsByApiKey.set(next.api_key, next);
      agentsById.set(next.id, next);
      return next;
    },
    count: () => agentsById.size,
    getByApiKey: (apiKey) => agentsByApiKey.get(apiKey) || null,
    getById: (id) => agentsById.get(id) || null,
    getFullProfile: async (id) => agentsById.get(id) || null,
    getPublicProfile: async (id) => agentsById.get(id) || null,
    updateProfile: async (id, body = {}) => ({ ...(agentsById.get(id) || fallback), ...body }),
    updateState: async () => {},
    getReputation: async () => ({ score: 0 }),
    getTopEvangelists: async () => [],
    logAction: async () => {},
    awardBadge: async () => {},
    getActions: async () => [],
    _agentsById: agentsById,
    _agentsByApiKey: agentsByApiKey,
  };
}

function createFakeDaemon({ dataLayer = null, agentRegistry = null, overrides = {} } = {}) {
  const registry = agentRegistry || createFakeAgentRegistry();
  const daemon = {
    config: TEST_DAEMON_CONFIG,
    dataLayer,
    agentRegistry: registry,
    nodeManager: createFakeNodeManager(),
    agentCashuWallet: {
      mintQuote: async () => ({ quote_id: 'q1' }),
      checkMintQuote: async () => ({ paid: false }),
      mintProofs: async () => ({ amount: 0 }),
      meltQuote: async () => ({ amount: 0, fee_reserve: 0 }),
      meltProofs: async () => ({ amount: 0, fee_reserve: 0 }),
      sendEcash: async () => ({ amount: 0, token: 'stub' }),
      receiveEcash: async () => ({ amount: 0 }),
      getBalance: async () => 0,
      restoreFromSeed: async () => ({ restored: 0 }),
      reclaimPendingSends: async () => ({ reclaimed: 0 }),
    },
    hubWallet: {
      getBalance: async () => 0,
    },
    publicLedger: {
      getAgentTransactions: async () => [],
      getAll: async () => ({ entries: [], total: 0 }),
    },
    messaging: {
      send: async () => ({ ok: true }),
      getSent: async () => [],
      getInbox: async () => [],
    },
    allianceManager: {
      propose: async () => ({ ok: true }),
      list: async () => [],
      accept: async () => ({ ok: true }),
      breakAlliance: async () => ({ ok: true }),
    },
    lineageTracker: {
      getTree: async () => null,
    },
    tournamentManager: {
      getChallenges: async () => [],
      getHallOfFame: async () => [],
      list: async () => [],
      enter: async () => ({ ok: true }),
      getBracket: async () => ({ rounds: [] }),
    },
    externalLeaderboard: {
      getData: () => ({ entries: [], updatedAt: null }),
    },
    channelAssignments: {
      getByAgent: () => [],
      getAssignment: () => null,
      assign: async () => ({ ok: true }),
      revoke: async () => ({ ok: true }),
    },
    channelExecutor: {
      preview: async () => ({ ok: true }),
      execute: async () => ({ ok: true }),
      getInstructions: async () => [],
      resetForTests: async () => {},
    },
    channelAuditLog: {
      readAll: async () => [],
      readByChannel: async () => [],
      verify: async () => ({ valid: true, checked: 0, total: 0, errors: [], warnings: [] }),
      readByType: async () => [],
      getStatus: async () => ({ valid: true }),
    },
    channelMonitor: {
      getStatus: () => ({ running: true }),
    },
    analyticsGateway: {
      getCatalog: () => ({ queries: [] }),
      getQuote: () => ({ price_sats: 0 }),
      execute: async () => ({ rows: [] }),
      getHistory: async () => ({ entries: [], total: 0 }),
    },
    capitalLedger: {
      getBalance: async () => ({ available_sats: 0, locked_sats: 0, pending_deposit_sats: 0 }),
      readActivity: async () => ({ entries: [], total: 0 }),
      withdraw: async () => ({ ok: true }),
    },
    depositTracker: {
      generateAddress: async () => ({ address: 'bcrt1qtestaddress0000000000000000000000000' }),
      getDepositStatus: () => ({ deposits: [] }),
      _confirmationsRequired: 3,
    },
    helpEndpoint: {
      ask: async () => ({ answer: 'stub' }),
    },
    channelOpener: {
      getConfig: () => ({ ok: true }),
      preview: async () => ({ ok: true }),
      open: async () => ({ ok: true }),
      getPendingForAgent: () => [],
    },
    channelCloser: {
      refreshNow: async () => {},
      requestClose: async () => ({ ok: true }),
      getClosesForAgent: () => [],
    },
    revenueTracker: {
      getAgentRevenue: () => ({ total_fees_sats: 0 }),
      getChannelRevenue: () => ({ total_fees_sats: 0 }),
      setRevenueConfig: async () => ({ ok: true }),
    },
    swapProvider: {
      getQuote: async () => ({ fee_sats: 0 }),
      createSwap: async () => ({ ok: true }),
      getSwapStatus: () => ({ ok: true }),
      getSwapHistory: () => [],
    },
    ecashChannelFunder: {
      fundChannelFromEcash: async () => ({ ok: true }),
      getFlowStatus: () => ({ ok: true }),
      getPendingForAgent: () => [],
    },
    performanceTracker: {
      getAgentPerformance: async () => ({ channels: [] }),
      getChannelPerformance: async () => ({ chan_id: null }),
      getLeaderboard: () => ({ entries: [] }),
    },
    rebalanceExecutor: {
      validateRequest: async () => ({ ok: true }),
      requestRebalance: async () => ({ ok: true }),
      estimateRebalanceFee: async () => ({ fee_sats: 0 }),
      getRebalanceHistory: async () => ({ entries: [], total: 0 }),
      getPendingForAgent: () => [],
    },
    marketTransparency: {
      getOverview: async () => ({ channels: 0 }),
      getChannels: async () => ({ channels: [], total: 0 }),
      getAgentProfile: async () => ({ agent_id: null }),
      getPeerSafety: async () => ({ ok: true }),
      getFeeCompetition: async () => ({ ok: true }),
    },
    lndCache: {
      getChannels: async () => [],
    },
  };
  return { ...daemon, ...overrides };
}

export async function createRouteTestHarness(options = {}) {
  disableRateLimiterPersistence();
  configureRateLimiterPolicy(TEST_RATE_LIMIT_POLICY);
  await resetCounters();

  const tempDir = options.withDataLayer ? await mkdtemp(join(tmpdir(), 'aol-route-test-')) : null;
  const dataLayer = options.dataLayer || (tempDir ? new DataLayer(tempDir) : null);
  const agentRegistry = options.agentRegistry || createFakeAgentRegistry(options.seedAgents || []);
  const daemon = options.daemon || createFakeDaemon({
    dataLayer,
    agentRegistry,
    overrides: options.daemonOverrides || {},
  });
  const app = express();
  app.use(express.json({ limit: '16kb' }));
  app.use(handleJsonBodyError);
  app.use(requireJsonWriteContent);
  app.use(agentGatewayRoutes(daemon));

  const server = createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;

  return {
    baseUrl,
    daemon,
    dataLayer,
    tempDir,
    agents: {
      primary: agentRegistry.getByApiKey('lb-agent-test-token'),
      secondary: agentRegistry.getByApiKey('lb-agent-test-token-2'),
    },
    async fetch(path, options = {}) {
      return fetch(new URL(path, baseUrl), options);
    },
    async close() {
      await new Promise((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
      await resetCounters();
      disableRateLimiterPersistence();
      if (tempDir) {
        await rm(tempDir, { recursive: true, force: true });
      }
    },
  };
}
