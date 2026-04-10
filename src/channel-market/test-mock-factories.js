/**
 * Shared mock factories for channel-market unit tests.
 *
 * Each factory produces a lightweight in-memory mock matching the interface
 * used by production modules. Tests import only what they need.
 */

/**
 * In-memory JSON store (DataLayer interface).
 */
export function mockDataLayer() {
  const store = {};
  const logs = {};
  return {
    readJSON: async (path) => {
      if (!store[path]) { const e = new Error('ENOENT'); e.code = 'ENOENT'; throw e; }
      return JSON.parse(JSON.stringify(store[path]));
    },
    readRuntimeStateJSON: async (path, { defaultValue = {} } = {}) => {
      if (!store[path]) {
        return JSON.parse(JSON.stringify(typeof defaultValue === 'function' ? defaultValue() : defaultValue));
      }
      return JSON.parse(JSON.stringify(store[path]));
    },
    writeJSON: async (path, data) => { store[path] = JSON.parse(JSON.stringify(data)); },
    appendLog: async (path, entry) => {
      if (!logs[path]) logs[path] = [];
      logs[path].push(JSON.parse(JSON.stringify(entry)));
    },
    readLog: async (path) => {
      if (!logs[path]) { const e = new Error('ENOENT'); e.code = 'ENOENT'; throw e; }
      return JSON.parse(JSON.stringify(logs[path]));
    },
    _store: store,
    _logs: logs,
  };
}

/**
 * Append-only audit log.
 */
export function mockAuditLog() {
  const entries = [];
  return { append: async (e) => entries.push(e), entries };
}

/**
 * No-op mutex (acquire returns an immediate release function).
 */
export function mockMutex() {
  return { acquire: async () => () => {} };
}

/**
 * Agent registry — simple getById lookup.
 */
export function mockAgentRegistry(agents = {}) {
  return {
    getById: (id) => agents[id] || null,
    getPublicProfile: async (id) => {
      const profile = agents[id];
      if (!profile) return null;
      return {
        id: profile.id,
        name: profile.name || null,
        description: profile.description || null,
        framework: profile.framework || null,
        contact_url: profile.contact_url || null,
        badge: profile.badge || null,
        forked_from: profile.forked_from || null,
        registered_at: profile.registered_at || null,
        updated_at: profile.updated_at || null,
      };
    },
    count: () => Object.keys(agents).length,
  };
}

/**
 * Assignment registry — supports all methods used across closer, transparency,
 * revenue tracker, and opener tests. Each test only calls what it needs.
 */
export function mockAssignmentRegistry(assignments = []) {
  const byPoint = new Map();
  const byChanId = new Map();
  const byAgent = new Map();
  for (const a of assignments) {
    byPoint.set(a.channel_point, a);
    if (a.chan_id) byChanId.set(a.chan_id, a);
    if (!byAgent.has(a.agent_id)) byAgent.set(a.agent_id, []);
    byAgent.get(a.agent_id).push(a);
  }
  const revoked = [];
  return {
    getAssignmentByPoint: (cp) => byPoint.get(cp) || null,
    getAssignment: (chanId) => byChanId.get(chanId) || null,
    getByAgent: (agentId) => byAgent.get(agentId) || [],
    getAllAssignments: () => assignments,
    getAssignedChannelPoints: () => new Set(byPoint.keys()),
    count: () => assignments.length,
    assign: async () => {},
    revoke: async (key) => {
      if (!byPoint.has(key) && !byChanId.has(key)) {
        const err = new Error('Channel not assigned'); err.status = 404; throw err;
      }
      revoked.push(key);
    },
    revoked,
  };
}

/**
 * Revenue attribution tracker — returns preconfigured revenue data.
 */
export function mockRevenueTracker({ channelRevenue = {}, agentRevenue = {}, totalRevenue = null } = {}) {
  return {
    getChannelRevenue: (chanId) => channelRevenue[chanId] || {
      chan_id: chanId, total_fees_msat: 0, total_fees_sats: 0, forward_count: 0, last_forward_at: 0,
    },
    getAgentRevenue: (agentId) => agentRevenue[agentId] || {
      agent_id: agentId, total_fees_msat: 0, total_fees_sats: 0, total_credited_sats: 0, forward_count: 0, channels: [],
    },
    getAllAgentRevenue: () => agentRevenue,
    getTotalRevenue: () => totalRevenue || {
      total_fees_msat: 0, total_fees_sats: 0, total_forwards: 0, agents_with_revenue: 0,
    },
  };
}

/**
 * Shared LND cache mock — matches LndCache interface.
 */
export function mockLndCache({ channels = [], feeReport = [], closedChannels = [] } = {}) {
  return {
    getChannels: async () => channels,
    getFeeReport: async () => feeReport,
    getClosedChannels: async () => closedChannels,
    getNodeInfo: async (pubkey) => ({ node: { alias: `node-${pubkey.slice(0, 8)}` } }),
  };
}

/**
 * Capital ledger — tracks calls for assertion. Supports method overrides.
 */
export function mockCapitalLedger(overrides = {}) {
  const calls = [];
  const credits = [];
  const ecashCredits = [];
  const serviceSpends = [];
  const serviceRefunds = [];
  const fundingEvents = [];
  return {
    getBalance: async (_agentId) => ({ available: 1_000_000, locked: 0, pending_deposit: 0, pending_close: 0, total_service_spent: 0 }),
    lockForChannel: async (agentId, amount, ref) => {
      calls.push({ method: 'lockForChannel', agentId, amount, ref });
    },
    unlockForFailedOpen: async (agentId, amount, ref) => {
      calls.push({ method: 'unlockForFailedOpen', agentId, amount, ref });
    },
    initiateClose: async (agentId, localBalance, originalLocked, channelPoint) => {
      calls.push({ method: 'initiateClose', agentId, localBalance, originalLocked, channelPoint });
    },
    settleClose: async (agentId, settledAmount, txid) => {
      calls.push({ method: 'settleClose', agentId, settledAmount, txid });
    },
    rollbackInitiatedClose: async (agentId, localBalance, originalLocked, channelPoint, reason) => {
      calls.push({ method: 'rollbackInitiatedClose', agentId, localBalance, originalLocked, channelPoint, reason });
    },
    creditRevenue: async (agentId, amount, reference) => {
      credits.push({ agentId, amount, reference });
    },
    creditEcashFunding: async (agentId, amount, reference) => {
      ecashCredits.push({ agentId, amount, reference });
    },
    spendOnService: async (agentId, amount, reference, service) => {
      serviceSpends.push({ agentId, amount, reference, service });
    },
    refundServiceSpend: async (agentId, amount, reference, service, reason) => {
      serviceRefunds.push({ agentId, amount, reference, service, reason });
    },
    recordFundingEvent: async (agentId, type, details = {}) => {
      fundingEvents.push({ agentId, type, ...details });
    },
    settleRebalance: async (agentId, maxFeeLocked, actualFee, reference) => {
      calls.push({ method: 'settleRebalance', agentId, maxFeeLocked, actualFee, reference });
    },
    ...overrides,
    calls,
    credits,
    ecashCredits,
    serviceSpends,
    serviceRefunds,
    fundingEvents,
  };
}

/**
 * Wallet operations mock — sendEcash/receiveEcash/getBalance with tracking.
 */
export function mockWalletOps({ balance = 500_000, sendFail = false } = {}) {
  const sendCalls = [];
  const receiveCalls = [];
  return {
    getBalance: async () => balance,
    sendEcash: async (agentId, amount) => {
      if (sendFail) throw new Error('sendEcash mock failure');
      sendCalls.push({ agentId, amount });
      return { token: `cashuA_mock_token_${amount}` };
    },
    receiveEcash: async (agentId, token) => {
      receiveCalls.push({ agentId, token });
    },
    sendCalls,
    receiveCalls,
  };
}

/**
 * Channel opener mock — tracks open() calls with configurable results.
 */
/**
 * NodeManager mock — wraps an LND client with sensible no-op defaults.
 * Pass clientOverrides to replace individual LND methods.
 * Access the client via `._client` for post-creation mutation.
 */
export function mockNodeManager(clientOverrides = {}) {
  const client = {
    getInfo: async () => ({ identity_pubkey: '0'.repeat(66) }),
    listChannels: async () => ({ channels: [] }),
    closedChannels: async () => ({ channels: [] }),
    pendingChannels: async () => ({ pending_open_channels: [] }),
    closeChannel: async () => ({}),
    newAddress: async () => ({ address: 'bc1p_mock_address' }),
    walletBalance: async () => ({ confirmed_balance: '1000000' }),
    getTransactions: async () => ({ transactions: [] }),
    getBestBlock: async () => ({ block_height: 100 }),
    publishTransaction: async () => ({}),
    forwardingHistory: async () => ({ forwarding_events: [], last_offset_index: '0' }),
    sendPayment: async () => ({ payment_preimage: 'mock_preimage', payment_hash: 'mock_hash', payment_error: '' }),
    addInvoice: async (value) => ({ payment_request: `lnbc${value}mock`, r_hash: 'mock_hash_' + Date.now(), add_index: '1' }),
    sendPaymentV2: async () => ({ status: 'SUCCEEDED', fee_sat: '0', payment_preimage: 'mock' }),
    trackPaymentV2: async () => ({ status: 'SUCCEEDED', fee_sat: '0' }),
    queryRoutes: async () => ({ routes: [] }),
    feeReport: async () => ({ channel_fees: [] }),
    ...clientOverrides,
  };
  return {
    getDefaultNodeOrNull: () => client,
    getScopedDefaultNodeOrNull: () => client,
    _client: client,
  };
}

/**
 * Channel opener mock — tracks open() calls with configurable results.
 */
export function mockChannelOpener({ openResult = null, openThrow = false } = {}) {
  const openCalls = [];
  const defaultResult = {
    success: true,
    channel_point: 'abc123:0',
    funding_txid: 'abc123',
    learn: 'Channel opened successfully.',
  };
  return {
    open: async (agentId, payload) => {
      openCalls.push({ agentId, payload });
      if (openThrow) throw new Error('open() threw');
      return openResult || defaultResult;
    },
    openCalls,
  };
}
