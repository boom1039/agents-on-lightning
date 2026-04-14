import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ledgerAgent,
  ledgerAgents,
  ledgerRecent,
  ledgerReconciliation,
  ledgerSummary,
  proofLedgerSummary,
} from './ledger-analytics.js';

function fakeDaemon({ publicEntries = [], capitalBalances = {}, capitalActivity = [] } = {}) {
  return {
    publicLedger: {
      getAll: async () => ({ entries: structuredClone(publicEntries), total: publicEntries.length }),
    },
    capitalLedger: {
      getAllBalances: async () => structuredClone(capitalBalances),
      readActivity: async ({ agentId, limit = 100, offset = 0 } = {}) => {
        const filtered = agentId
          ? capitalActivity.filter((entry) => entry.agent_id === agentId)
          : capitalActivity;
        return {
          entries: structuredClone(filtered.slice(offset, offset + limit)),
          total: filtered.length,
        };
      },
    },
  };
}

test('ledger analytics returns empty views without ledger services', async () => {
  assert.deepEqual(await ledgerRecent(null), {
    entries: [],
    total: 0,
    limit: 100,
    offset: 0,
    type: null,
    agent_id: null,
    since: null,
  });
  assert.equal((await ledgerSummary(null)).public_ledger.total_entries, 0);
  assert.equal((await ledgerAgents(null)).total, 0);
  assert.equal((await ledgerReconciliation(null)).ok, true);
});

test('ledger recent paginates newest first and sanitizes secrets', async () => {
  const daemon = fakeDaemon({
    publicEntries: [
      {
        ledger_id: 'older',
        recorded_at: 1000,
        type: 'deposit',
        agent_id: 'agent-a',
        amount_sats: 100,
      },
      {
        ledger_id: 'newer',
        recorded_at: 2000,
        type: 'deposit_confirmed',
        agent_id: 'agent-a',
        amount_sats: 200,
        address: 'bc1qexampleaddress',
        payment_request: 'lnbcsecret',
        token: 'cashu-secret',
        flow_id: '123e4567-e89b-12d3-a456-426614174000',
      },
      {
        ledger_id: 'other',
        recorded_at: 3000,
        type: 'withdrawal',
        agent_id: 'agent-b',
        amount_sats: 50,
      },
    ],
  });

  const recent = await ledgerRecent(daemon, { agentId: 'agent-a', limit: 1 });
  assert.equal(recent.total, 2);
  assert.equal(recent.entries[0].ledger_id, 'newer');
  assert.equal(recent.entries[0].address, undefined);
  assert.equal(recent.entries[0].address_hint, '...eaddress');
  assert.equal(recent.entries[0].payment_request, undefined);
  assert.equal(recent.entries[0].token, undefined);
  assert.equal(recent.entries[0].flow_id, '123e4567...');
});

test('ledger analytics summarizes public entries and capital balances', async () => {
  const daemon = fakeDaemon({
    publicEntries: [
      { recorded_at: 1000, type: 'deposit', agent_id: 'agent-a', amount_sats: 100 },
      { recorded_at: 2000, type: 'withdrawal', agent_id: 'agent-a', amount_sats: 25 },
      { recorded_at: 3000, type: 'transfer', from_agent_id: 'agent-a', to_agent_id: 'agent-b', amount_sats: 10 },
    ],
    capitalBalances: {
      'agent-a': {
        available: 70,
        locked: 20,
        pending_deposit: 0,
        pending_close: 0,
        total_deposited: 100,
        total_withdrawn: 0,
        total_revenue_credited: 0,
        total_ecash_funded: 0,
        total_service_spent: 0,
        total_routing_pnl: 10,
      },
    },
    capitalActivity: [
      { _ts: 4000, agent_id: 'agent-a', type: 'lock_for_channel', amount_sats: 20 },
    ],
  });

  const summary = await ledgerSummary(daemon);
  assert.equal(summary.public_ledger.total_entries, 3);
  assert.equal(summary.public_ledger.unique_agents, 2);
  assert.equal(summary.capital.total_committed_sats, 90);
  assert.equal(summary.capital.activity_entries, 1);

  const agents = await ledgerAgents(daemon);
  const agentA = agents.entries.find((row) => row.agent_id === 'agent-a');
  assert.equal(agentA.public_ledger_entries, 3);
  assert.equal(agentA.capital_available_sats, 70);

  const agent = await ledgerAgent(daemon, 'agent-a');
  assert.equal(agent.public_total, 3);
  assert.equal(agent.capital_activity_total, 1);
  assert.equal(agent.timeline.length, 4);
});

test('ledger analytics prefers proof ledger projections when available', async () => {
  const daemon = {
    publicLedger: {
      getAll: async () => ({ entries: [{ ledger_id: 'legacy', agent_id: 'agent-old' }], total: 1 }),
    },
    proofBackedPublicLedger: {
      getAll: async () => ({
        entries: [{
          ledger_id: 'proof-row',
          proof_id: 'proof-row',
          recorded_at: 5000,
          type: 'wallet_mint_issued',
          agent_id: 'agent-proof',
          amount_sats: 250,
        }],
        total: 1,
      }),
    },
    capitalLedger: {
      getAllBalances: async () => ({ 'agent-old': { available: 999 } }),
      readActivity: async () => ({ entries: [{ agent_id: 'agent-old' }], total: 1 }),
    },
    proofLedger: {
      getAllCapitalBalances: () => ({
        'agent-proof': {
          available: 250,
          locked: 0,
          pending_deposit: 0,
          pending_close: 0,
          total_deposited: 250,
          total_withdrawn: 0,
          total_revenue_credited: 0,
          total_ecash_funded: 0,
          total_service_spent: 0,
          total_routing_pnl: 0,
        },
      }),
      listCapitalActivity: () => [{
        global_sequence: 2,
        created_at_ms: 5000,
        agent_id: 'agent-proof',
        money_event_type: 'wallet_mint_issued',
      }],
      countCapitalActivity: () => 1,
    },
  };

  const summary = await ledgerSummary(daemon);
  assert.equal(summary.public_ledger.total_entries, 1);
  assert.equal(summary.public_ledger.unique_agents, 1);
  assert.equal(summary.capital.available_sats, 250);

  const agents = await ledgerAgents(daemon);
  assert.equal(agents.total, 1);
  assert.equal(agents.entries[0].agent_id, 'agent-proof');
  assert.equal(agents.entries[0].capital_available_sats, 250);
});

test('proof ledger summary exposes chain, liabilities, reserves, and source context', async () => {
  const daemon = {
    proofLedger: {
      getLatestGlobalProof: () => ({
        proof_id: 'proof-3',
        global_sequence: 3,
        proof_record_type: 'reserve_snapshot',
        money_event_type: 'reserve_snapshot_created',
        money_event_status: 'confirmed',
        event_source: 'proof_ledger',
        authorization_method: 'reserve_attestation',
        proof_hash: 'hash-3',
        created_at_ms: 3000,
        public_safe_refs: {},
      }),
      getLatestProofByRecordType: (type) => {
        if (type === 'liability_checkpoint') {
          return {
            proof_id: 'proof-2',
            global_sequence: 2,
            proof_record_type: 'liability_checkpoint',
            money_event_type: 'liability_checkpoint_created',
            money_event_status: 'confirmed',
            event_source: 'proof_ledger',
            authorization_method: 'liability_checkpoint',
            proof_hash: 'hash-2',
            created_at_ms: 2000,
            public_safe_refs: { checkpointed_through_global_sequence: 1 },
          };
        }
        if (type === 'reserve_snapshot') {
          return {
            proof_id: 'proof-3',
            global_sequence: 3,
            proof_record_type: 'reserve_snapshot',
            money_event_type: 'reserve_snapshot_created',
            money_event_status: 'confirmed',
            event_source: 'proof_ledger',
            authorization_method: 'reserve_attestation',
            proof_hash: 'hash-3',
            created_at_ms: 3000,
            public_safe_refs: {
              total_reserve_sats: 5000,
              reserve_sufficient: true,
              reserve_totals_by_source: [{ reserve_source_name: 'node', amount_sats: 5000 }],
            },
          };
        }
        return null;
      },
      getLiabilityTotals: () => ({
        wallet_ecash_sats: 0,
        wallet_hub_sats: 1000,
        capital_available_sats: 1500,
        capital_locked_sats: 0,
        capital_pending_deposit_sats: 0,
        capital_pending_close_sats: 0,
        capital_service_spent_sats: 0,
        routing_pnl_sats: 0,
        total_tracked_sats: 2500,
      }),
      countProofs: () => 3,
      listAgentIds: () => ['agent-proof'],
      verifyChain: () => ({ valid: true, checked: 3, latest_hash: 'hash-3', errors: [] }),
      getPublicKeyInfo: () => ({ signing_key_id: 'ed25519:test-key' }),
    },
  };

  const summary = await proofLedgerSummary(daemon);
  assert.equal(summary.available, true);
  assert.equal(summary.proof_rows.total, 3);
  assert.equal(summary.proof_of_liabilities.total_liability_sats, 2500);
  assert.equal(summary.proof_of_reserves.total_reserve_sats, 5000);
  assert.equal(summary.proof_of_reserves.reserve_surplus_sats, 2500);
  assert.equal(summary.global_chain.valid, true);
  assert.equal(summary.panel_sources.store, 'SQLite proof_ledger');
});

test('ledger reconciliation catches capital invariant mismatches', async () => {
  const daemon = fakeDaemon({
    publicEntries: [{ ledger_id: 'missing-agent', type: 'credit', amount_sats: 1 }],
    capitalBalances: {
      'agent-bad': {
        available: 50,
        locked: 0,
        pending_deposit: 0,
        pending_close: 0,
        total_deposited: 10,
        total_withdrawn: 0,
        total_revenue_credited: 0,
        total_ecash_funded: 0,
        total_service_spent: 0,
        total_routing_pnl: 0,
      },
    },
  });

  const result = await ledgerReconciliation(daemon);
  assert.equal(result.ok, false);
  assert(result.issues.some((issue) => issue.type === 'ledger_missing_agent'));
  assert(result.issues.some((issue) => issue.type === 'capital_invariant_mismatch'));
});
