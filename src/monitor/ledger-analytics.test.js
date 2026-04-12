import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ledgerAgent,
  ledgerAgents,
  ledgerRecent,
  ledgerReconciliation,
  ledgerSummary,
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
