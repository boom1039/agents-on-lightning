const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const BALANCE_FIELDS = [
  'available',
  'locked',
  'pending_deposit',
  'pending_close',
  'total_deposited',
  'total_withdrawn',
  'total_revenue_credited',
  'total_ecash_funded',
  'total_service_spent',
  'total_routing_pnl',
];

function normalizeLimit(value, fallback = 100, max = 500) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(parsed, 1), max);
}

function normalizeOffset(value) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? Math.max(parsed, 0) : 0;
}

function normalizeSince(value) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function tsOf(entry) {
  return Number(entry?.recorded_at || entry?.created_at_ms || entry?._ts || entry?.ts || 0) || 0;
}

function amountOf(entry) {
  const value = Number(entry?.amount_sats ?? entry?.primary_amount_sats);
  return Number.isFinite(value) ? value : 0;
}

function shortenOpaqueId(value) {
  if (typeof value !== 'string') return value;
  if (!UUID_RE.test(value.trim())) return value;
  return `${value.slice(0, 8)}...`;
}

function agentIdsForEntry(entry) {
  const ids = new Set();
  for (const key of ['agent_id', 'from_agent_id', 'to_agent_id']) {
    if (typeof entry?.[key] === 'string' && entry[key].trim()) ids.add(entry[key].trim());
  }
  return [...ids];
}

function entryMatchesAgent(entry, agentId) {
  if (!agentId) return true;
  return agentIdsForEntry(entry).includes(agentId);
}

function paginate(entries, { limit = 100, offset = 0 } = {}) {
  const normalizedLimit = normalizeLimit(limit);
  const normalizedOffset = normalizeOffset(offset);
  return {
    entries: entries.slice(normalizedOffset, normalizedOffset + normalizedLimit),
    total: entries.length,
    limit: normalizedLimit,
    offset: normalizedOffset,
  };
}

export function sanitizeLedgerEntry(entry) {
  if (!entry || typeof entry !== 'object') return entry;
  const safe = { ...entry };
  if (typeof safe.address === 'string' && safe.address.trim()) {
    safe.address_hint = `...${safe.address.trim().slice(-8)}`;
    delete safe.address;
  }
  safe.flow_id = shortenOpaqueId(safe.flow_id);
  safe.reference = shortenOpaqueId(safe.reference);
  delete safe.payment_request;
  delete safe.invoice;
  delete safe.preimage;
  delete safe.token;
  delete safe.proofs;
  return safe;
}

async function readPublicEntries(daemon) {
  if (daemon?.proofBackedPublicLedger?.getAll) {
    const result = await daemon.proofBackedPublicLedger.getAll({});
    return Array.isArray(result?.entries) ? result.entries : [];
  }
  if (!daemon?.publicLedger?.getAll) return [];
  const result = await daemon.publicLedger.getAll({});
  return Array.isArray(result?.entries) ? result.entries : [];
}

function filterPublicEntries(entries, { since, type, agentId } = {}) {
  const normalizedSince = normalizeSince(since);
  const normalizedType = typeof type === 'string' && type.trim() ? type.trim() : null;
  const normalizedAgent = typeof agentId === 'string' && agentId.trim() ? agentId.trim() : null;
  return entries
    .filter((entry) => !normalizedSince || tsOf(entry) >= normalizedSince)
    .filter((entry) => !normalizedType || entry?.type === normalizedType)
    .filter((entry) => entryMatchesAgent(entry, normalizedAgent))
    .sort((a, b) => tsOf(b) - tsOf(a));
}

function summarizePublicEntries(entries) {
  const agents = new Set();
  const typeMap = new Map();
  let deposited = 0;
  let withdrawn = 0;
  let transferred = 0;
  let amount = 0;
  let latestAt = 0;

  for (const entry of entries) {
    for (const id of agentIdsForEntry(entry)) agents.add(id);
    const amt = amountOf(entry);
    amount += amt;
    latestAt = Math.max(latestAt, tsOf(entry));
    if (entry?.type === 'deposit') deposited += amt;
    if (entry?.type === 'withdrawal') withdrawn += amt;
    if (entry?.type === 'transfer') transferred += amt;
    const type = entry?.type || 'unknown';
    const existing = typeMap.get(type) || { type, count: 0, amount_sats: 0 };
    existing.count += 1;
    existing.amount_sats += amt;
    typeMap.set(type, existing);
  }

  return {
    total_entries: entries.length,
    total_amount_sats: amount,
    total_deposited_sats: deposited,
    total_withdrawn_sats: withdrawn,
    total_transferred_sats: transferred,
    unique_agents: agents.size,
    latest_at: latestAt || null,
    type_counts: [...typeMap.values()].sort((a, b) => b.count - a.count),
  };
}

function summarizeCapitalBalances(balances = {}) {
  const totals = {
    agent_count: 0,
    error_count: 0,
    available_sats: 0,
    locked_sats: 0,
    pending_deposit_sats: 0,
    pending_close_sats: 0,
    total_deposited_sats: 0,
    total_withdrawn_sats: 0,
    total_revenue_credited_sats: 0,
    total_ecash_funded_sats: 0,
    total_service_spent_sats: 0,
    total_routing_pnl_sats: 0,
  };

  for (const balance of Object.values(balances || {})) {
    if (!balance || balance.error) {
      totals.error_count += 1;
      continue;
    }
    totals.agent_count += 1;
    totals.available_sats += Number(balance.available || 0);
    totals.locked_sats += Number(balance.locked || 0);
    totals.pending_deposit_sats += Number(balance.pending_deposit || 0);
    totals.pending_close_sats += Number(balance.pending_close || 0);
    totals.total_deposited_sats += Number(balance.total_deposited || 0);
    totals.total_withdrawn_sats += Number(balance.total_withdrawn || 0);
    totals.total_revenue_credited_sats += Number(balance.total_revenue_credited || 0);
    totals.total_ecash_funded_sats += Number(balance.total_ecash_funded || 0);
    totals.total_service_spent_sats += Number(balance.total_service_spent || 0);
    totals.total_routing_pnl_sats += Number(balance.total_routing_pnl || 0);
  }
  totals.total_committed_sats =
    totals.available_sats + totals.locked_sats + totals.pending_deposit_sats + totals.pending_close_sats;
  return totals;
}

function proofRowSummary(row) {
  if (!row || typeof row !== 'object') return null;
  return {
    proof_id: row.proof_id,
    global_sequence: row.global_sequence,
    proof_group_id: row.proof_group_id || null,
    proof_record_type: row.proof_record_type,
    money_event_type: row.money_event_type,
    money_event_status: row.money_event_status,
    agent_id: row.agent_id || null,
    agent_proof_sequence: row.agent_proof_sequence || null,
    event_source: row.event_source,
    authorization_method: row.authorization_method,
    primary_amount_sats: row.primary_amount_sats,
    proof_hash: row.proof_hash,
    previous_global_proof_hash: row.previous_global_proof_hash,
    previous_agent_proof_hash: row.previous_agent_proof_hash,
    signing_key_id: row.signing_key_id,
    created_at_ms: row.created_at_ms,
    public_safe_refs: row.public_safe_refs || {},
  };
}

function proofBalanceFields(balance) {
  const safe = balance && typeof balance === 'object' ? balance : {};
  return {
    wallet_ecash_sats: Number(safe.wallet_ecash_sats || 0),
    wallet_hub_sats: Number(safe.wallet_hub_sats || 0),
    capital_available_sats: Number(safe.capital_available_sats || 0),
    capital_locked_sats: Number(safe.capital_locked_sats || 0),
    capital_pending_deposit_sats: Number(safe.capital_pending_deposit_sats || 0),
    capital_pending_close_sats: Number(safe.capital_pending_close_sats || 0),
    capital_service_spent_sats: Number(safe.capital_service_spent_sats || 0),
    routing_pnl_sats: Number(safe.routing_pnl_sats || 0),
    total_tracked_sats: Number(safe.total_tracked_sats || 0),
  };
}

export async function proofLedgerSummary(daemon) {
  const proofLedger = daemon?.proofLedger;
  if (!proofLedger) {
    return {
      source_of_truth: 'proof_ledger',
      available: false,
      status: 'unavailable',
      explanation: 'Proof Ledger is not enabled for this runtime.',
    };
  }

  const latestGlobal = proofLedger.getLatestGlobalProof();
  const latestLiabilityCheckpoint = proofLedger.getLatestProofByRecordType('liability_checkpoint');
  const latestReserveSnapshot = proofLedger.getLatestProofByRecordType('reserve_snapshot');
  const liabilityTotals = proofBalanceFields(proofLedger.getLiabilityTotals());
  const reserveRefs = latestReserveSnapshot?.public_safe_refs || {};
  const reserveTotal = Number(reserveRefs.total_reserve_sats || 0);
  const liabilityTotal = Number(liabilityTotals.total_tracked_sats || 0);
  const reserveSurplus = reserveTotal - liabilityTotal;

  return {
    source_of_truth: 'proof_ledger',
    available: true,
    status: latestGlobal ? 'live' : 'not_started',
    latest_global_proof: proofRowSummary(latestGlobal),
    proof_rows: {
      total: proofLedger.countProofs(),
      agent_count: proofLedger.listAgentIds().length,
    },
    proof_of_liabilities: {
      live_derived_liability_totals: liabilityTotals,
      total_liability_sats: liabilityTotal,
      latest_signed_liability_checkpoint: proofRowSummary(latestLiabilityCheckpoint),
    },
    proof_of_reserves: {
      status: latestReserveSnapshot ? 'operator_attested_snapshot_available' : 'not_yet_published',
      latest_reserve_snapshot: proofRowSummary(latestReserveSnapshot),
      total_reserve_sats: reserveTotal,
      reserve_sufficient: reserveRefs.reserve_sufficient ?? null,
      reserve_surplus_sats: reserveSurplus,
      reserve_coverage_ratio: liabilityTotal > 0 ? reserveTotal / liabilityTotal : null,
      reserve_totals_by_source: Array.isArray(reserveRefs.reserve_totals_by_source)
        ? reserveRefs.reserve_totals_by_source
        : [],
      limitation: 'Reserve snapshots are operator-attested until stronger external reserve evidence is added.',
    },
    global_chain: proofLedger.verifyChain(),
    public_key: proofLedger.getPublicKeyInfo(),
    panel_sources: {
      route: '/api/analytics/proof-ledger/summary',
      store: 'SQLite proof_ledger',
      meaning: 'Proof Ledger explains signed money state; DuckDB MCP telemetry explains agent behavior.',
    },
  };
}

async function readCapitalBalances(daemon) {
  if (daemon?.proofLedger?.getAllCapitalBalances) {
    return daemon.proofLedger.getAllCapitalBalances();
  }
  if (!daemon?.capitalLedger?.getAllBalances) return {};
  try {
    return await daemon.capitalLedger.getAllBalances();
  } catch {
    return {};
  }
}

async function readCapitalActivity(daemon, options = {}) {
  const limit = normalizeLimit(options.limit, 100);
  const offset = normalizeOffset(options.offset);
  if (daemon?.proofLedger?.listCapitalActivity) {
    const entries = daemon.proofLedger.listCapitalActivity({
      agentId: options.agentId,
      limit,
      offset,
    });
    return {
      entries,
      total: daemon.proofLedger.countCapitalActivity({ agentId: options.agentId }),
      limit,
      offset,
    };
  }
  if (!daemon?.capitalLedger?.readActivity) return { entries: [], total: 0, limit: 0, offset: 0 };
  try {
    const result = await daemon.capitalLedger.readActivity({
      agentId: options.agentId,
      limit,
      offset,
    });
    return {
      entries: Array.isArray(result?.entries) ? result.entries : [],
      total: Number(result?.total || 0),
      limit,
      offset,
    };
  } catch {
    return { entries: [], total: 0, limit, offset };
  }
}

export async function ledgerSummary(daemon) {
  const [publicEntries, capitalBalances, capitalActivity] = await Promise.all([
    readPublicEntries(daemon),
    readCapitalBalances(daemon),
    readCapitalActivity(daemon, { limit: 1 }),
  ]);
  return {
    public_ledger: summarizePublicEntries(publicEntries),
    capital: {
      ...summarizeCapitalBalances(capitalBalances),
      activity_entries: capitalActivity.total,
    },
  };
}

export async function ledgerRecent(daemon, options = {}) {
  const publicEntries = await readPublicEntries(daemon);
  const filtered = filterPublicEntries(publicEntries, options);
  const page = paginate(filtered.map(sanitizeLedgerEntry), options);
  return {
    ...page,
    type: options.type || null,
    agent_id: options.agentId || null,
    since: normalizeSince(options.since) || null,
  };
}

export async function ledgerAgents(daemon, options = {}) {
  const [publicEntries, capitalBalances] = await Promise.all([
    readPublicEntries(daemon),
    readCapitalBalances(daemon),
  ]);
  const byAgent = new Map();

  const ensure = (agentId) => {
    if (!byAgent.has(agentId)) {
      byAgent.set(agentId, {
        agent_id: agentId,
        public_ledger_entries: 0,
        public_ledger_amount_sats: 0,
        wallet_deposit_sats: 0,
        wallet_withdrawal_sats: 0,
        transfer_sats: 0,
        capital_ledger_entries: 0,
        proof_rows: 0,
        proof_total_tracked_sats: 0,
        wallet_ecash_sats: 0,
        wallet_hub_sats: 0,
        latest_proof_id: null,
        latest_proof_hash: null,
        latest_proof_sequence: null,
        last_ledger_at: null,
        capital_available_sats: 0,
        capital_locked_sats: 0,
        capital_pending_deposit_sats: 0,
        capital_pending_close_sats: 0,
        total_revenue_credited_sats: 0,
        total_routing_pnl_sats: 0,
        capital_error: null,
      });
    }
    return byAgent.get(agentId);
  };

  for (const entry of publicEntries) {
    const ids = agentIdsForEntry(entry);
    for (const agentId of ids) {
      const row = ensure(agentId);
      const amt = amountOf(entry);
      row.public_ledger_entries += 1;
      row.public_ledger_amount_sats += amt;
      row.last_ledger_at = Math.max(row.last_ledger_at || 0, tsOf(entry)) || null;
      if (entry?.source === 'capital_ledger') row.capital_ledger_entries += 1;
      if (entry?.type === 'deposit') row.wallet_deposit_sats += amt;
      if (entry?.type === 'withdrawal') row.wallet_withdrawal_sats += amt;
      if (entry?.type === 'transfer') row.transfer_sats += amt;
    }
  }

  for (const [agentId, balance] of Object.entries(capitalBalances || {})) {
    const row = ensure(agentId);
    if (balance?.error) {
      row.capital_error = balance.error;
      continue;
    }
    row.capital_available_sats = Number(balance.available || 0);
    row.capital_locked_sats = Number(balance.locked || 0);
    row.capital_pending_deposit_sats = Number(balance.pending_deposit || 0);
    row.capital_pending_close_sats = Number(balance.pending_close || 0);
    row.total_revenue_credited_sats = Number(balance.total_revenue_credited || 0);
    row.total_routing_pnl_sats = Number(balance.total_routing_pnl || 0);
  }

  if (daemon?.proofLedger?.listAgentIds) {
    for (const agentId of daemon.proofLedger.listAgentIds()) {
      const row = ensure(agentId);
      const balance = proofBalanceFields(daemon.proofLedger.getAgentBalance(agentId));
      const latest = daemon.proofLedger.getLatestAgentProof(agentId);
      row.proof_rows = daemon.proofLedger.countProofs({ agentId });
      row.proof_total_tracked_sats = balance.total_tracked_sats;
      row.wallet_ecash_sats = balance.wallet_ecash_sats;
      row.wallet_hub_sats = balance.wallet_hub_sats;
      row.latest_proof_id = latest?.proof_id || null;
      row.latest_proof_hash = latest?.proof_hash || null;
      row.latest_proof_sequence = latest?.global_sequence || null;
      row.last_ledger_at = Math.max(row.last_ledger_at || 0, Number(latest?.created_at_ms || 0)) || row.last_ledger_at;
    }
  }

  const filteredAgent = typeof options.agentId === 'string' && options.agentId.trim()
    ? options.agentId.trim()
    : null;
  const rows = [...byAgent.values()]
    .filter((row) => !filteredAgent || row.agent_id === filteredAgent)
    .sort((a, b) => Number(b.last_ledger_at || 0) - Number(a.last_ledger_at || 0));

  return paginate(rows, options);
}

export async function ledgerAgent(daemon, agentId, options = {}) {
  const normalizedAgent = typeof agentId === 'string' ? agentId.trim() : '';
  if (!normalizedAgent) {
    return {
      agent_id: normalizedAgent,
      public_entries: [],
      capital_activity: [],
      capital_balance: null,
      totals: {},
    };
  }

  const [recent, capitalBalances, capitalActivity] = await Promise.all([
    ledgerRecent(daemon, {
      agentId: normalizedAgent,
      limit: normalizeLimit(options.limit, 100),
      offset: normalizeOffset(options.offset),
      type: options.type,
      since: options.since,
    }),
    readCapitalBalances(daemon),
    readCapitalActivity(daemon, {
      agentId: normalizedAgent,
      limit: normalizeLimit(options.capitalLimit, 100),
      offset: normalizeOffset(options.capitalOffset),
    }),
  ]);
  const proofLedger = daemon?.proofLedger || null;
  const proofBalance = proofLedger ? proofBalanceFields(proofLedger.getAgentBalance(normalizedAgent)) : null;
  const latestAgentProof = proofLedger ? proofLedger.getLatestAgentProof(normalizedAgent) : null;
  const latestCheckpoint = proofLedger ? proofLedger.getLatestProofByRecordType('liability_checkpoint') : null;
  const checkpointSequence = Number(
    latestCheckpoint?.public_safe_refs?.checkpointed_through_global_sequence
      || latestCheckpoint?.global_sequence
      || 0,
  );

  const publicEntries = recent.entries || [];
  const capitalEntries = (capitalActivity.entries || []).map(sanitizeLedgerEntry);
  const timeline = [
    ...publicEntries.map((entry) => ({ source: 'public_ledger', ts: tsOf(entry), entry })),
    ...capitalEntries.map((entry) => ({ source: 'capital_activity', ts: tsOf(entry), entry })),
  ].sort((a, b) => b.ts - a.ts);

  return {
    agent_id: normalizedAgent,
    public_entries: publicEntries,
    public_total: recent.total,
    capital_activity: capitalEntries,
    capital_activity_total: capitalActivity.total,
    capital_balance: capitalBalances?.[normalizedAgent] || null,
    proof_balance: proofBalance,
    proof_total: proofLedger ? proofLedger.countProofs({ agentId: normalizedAgent }) : 0,
    latest_agent_proof: proofRowSummary(latestAgentProof),
    agent_chain: proofLedger ? proofLedger.verifyChain({ agentId: normalizedAgent }) : null,
    included_in_latest_liability_checkpoint: latestAgentProof
      ? checkpointSequence >= Number(latestAgentProof.global_sequence || 0)
      : false,
    latest_liability_checkpoint: proofRowSummary(latestCheckpoint),
    timeline,
  };
}

function invariantForBalance(balance) {
  const lhs = Number(balance.total_deposited || 0)
    + Number(balance.total_revenue_credited || 0)
    + Number(balance.total_ecash_funded || 0);
  const rhs = Number(balance.available || 0)
    + Number(balance.locked || 0)
    + Number(balance.pending_deposit || 0)
    + Number(balance.pending_close || 0)
    + Number(balance.total_withdrawn || 0)
    + Number(balance.total_service_spent || 0)
    + Number(balance.total_routing_pnl || 0);
  return { lhs, rhs, ok: lhs === rhs };
}

export async function ledgerReconciliation(daemon) {
  const [publicEntries, capitalBalances] = await Promise.all([
    readPublicEntries(daemon),
    readCapitalBalances(daemon),
  ]);
  const issues = [];

  for (const entry of publicEntries) {
    if (agentIdsForEntry(entry).length === 0) {
      issues.push({
        severity: 'warn',
        type: 'ledger_missing_agent',
        ledger_id: entry.ledger_id || null,
        message: 'Public ledger entry has no agent reference.',
      });
    }
    if (entry.amount_sats !== undefined && !Number.isFinite(Number(entry.amount_sats))) {
      issues.push({
        severity: 'warn',
        type: 'ledger_invalid_amount',
        ledger_id: entry.ledger_id || null,
        message: 'Public ledger entry has a non-numeric amount_sats.',
      });
    }
  }

  for (const [agentId, balance] of Object.entries(capitalBalances || {})) {
    if (!balance || balance.error) {
      issues.push({
        severity: 'error',
        type: 'capital_state_error',
        agent_id: agentId,
        message: balance?.error || 'Capital state could not be read.',
      });
      continue;
    }
    for (const field of BALANCE_FIELDS) {
      const value = Number(balance[field] || 0);
      if (field !== 'total_routing_pnl' && value < 0) {
        issues.push({
          severity: 'error',
          type: 'negative_capital_balance',
          agent_id: agentId,
          field,
          value,
          message: `${field} is negative.`,
        });
      }
    }
    const invariant = invariantForBalance(balance);
    if (!invariant.ok) {
      issues.push({
        severity: 'error',
        type: 'capital_invariant_mismatch',
        agent_id: agentId,
        lhs: invariant.lhs,
        rhs: invariant.rhs,
        message: 'Capital ledger double-entry invariant does not balance.',
      });
    }
    if (Number(balance.pending_deposit || 0) > 0) {
      issues.push({
        severity: 'info',
        type: 'pending_deposit',
        agent_id: agentId,
        amount_sats: Number(balance.pending_deposit || 0),
        message: 'Agent has capital pending deposit confirmation.',
      });
    }
    if (Number(balance.pending_close || 0) > 0) {
      issues.push({
        severity: 'info',
        type: 'pending_close',
        agent_id: agentId,
        amount_sats: Number(balance.pending_close || 0),
        message: 'Agent has capital pending channel close settlement.',
      });
    }
  }

  const errorCount = issues.filter((issue) => issue.severity === 'error').length;
  return {
    ok: errorCount === 0,
    issue_count: issues.length,
    error_count: errorCount,
    warning_count: issues.filter((issue) => issue.severity === 'warn').length,
    info_count: issues.filter((issue) => issue.severity === 'info').length,
    issues: issues.slice(0, 500),
  };
}
