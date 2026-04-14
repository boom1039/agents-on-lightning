import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { HubWallet } from './hub-wallet.js';
import { ProofLedger } from '../proof-ledger/proof-ledger.js';

class MemoryDataLayer {
  constructor() {
    this.json = new Map();
    this.logs = new Map();
  }

  async readJSON(path) {
    if (!this.json.has(path)) {
      const err = new Error('not found');
      err.code = 'ENOENT';
      throw err;
    }
    return structuredClone(this.json.get(path));
  }

  async writeJSON(path, value) {
    this.json.set(path, structuredClone(value));
  }

  async appendLog(path, entry) {
    const rows = this.logs.get(path) || [];
    rows.push(structuredClone({ ...entry, _ts: entry._ts || Date.now() }));
    this.logs.set(path, rows);
  }
}

function mockNodeManager(node) {
  return {
    getNodeNames: () => ['node'],
    getScopedDefaultNodeOrNull: () => node,
    getNode: () => node,
  };
}

async function withProofHubWallet(node, fn) {
  const dir = await mkdtemp(join(tmpdir(), 'aol-hub-wallet-proof-'));
  const proofLedger = new ProofLedger({
    dbPath: join(dir, 'proof-ledger.sqlite'),
    keyPath: join(dir, 'proof-ledger-key.pem'),
    allowGenerateKey: true,
  });
  const dataLayer = new MemoryDataLayer();
  const legacyRecords = [];
  const hubWallet = new HubWallet({
    dataLayer,
    nodeManager: mockNodeManager(node),
    ledger: {
      record: async (entry) => {
        legacyRecords.push(structuredClone(entry));
        return entry;
      },
      getAgentTransactions: async () => legacyRecords,
    },
    proofLedger,
    config: {
      maxRoutingFeeSats: 10,
      withdrawalTimeoutSeconds: 30,
    },
  });

  try {
    await proofLedger.ensureGenesisProof();
    await fn({ hubWallet, proofLedger, dataLayer, legacyRecords });
  } finally {
    proofLedger.close();
    await rm(dir, { recursive: true, force: true });
  }
}

test('proof-backed hub wallet credits settled deposits once and syncs state cache', async () => {
  const node = {
    request: async (method, path) => {
      assert.equal(method, 'GET');
      assert.match(path, /^\/v1\/invoice\//);
      return { settled: true, value: '1000' };
    },
  };

  await withProofHubWallet(node, async ({ hubWallet, proofLedger, dataLayer, legacyRecords }) => {
    const first = await hubWallet.checkDeposit('agent-a', 'a'.repeat(64));
    const second = await hubWallet.checkDeposit('agent-a', 'a'.repeat(64));

    assert.equal(first.status, 'settled');
    assert.equal(second.status, 'settled');
    assert.equal(first.proof_id, second.proof_id);
    assert.equal(await hubWallet.getBalance('agent-a'), 1000);
    assert.equal(proofLedger.getAgentBalance('agent-a').wallet_hub_sats, 1000);
    assert.equal(legacyRecords.length, 0);

    const state = await dataLayer.readJSON('data/external-agents/agent-a/state.json');
    assert.equal(state.wallet_balance_sats, 1000);

    const proofs = proofLedger.listProofs({ agentId: 'agent-a', limit: 10 });
    assert.equal(proofs.length, 1);
    assert.equal(proofs[0].money_event_type, 'hub_deposit_settled');
    assert.equal(proofs[0].public_safe_refs.payment_hash, undefined);
  });
});

test('proof-backed hub wallet withdraws by submitting debit, settling fee, and syncing projection', async () => {
  const node = {
    request: async (method, path, body) => {
      if (method === 'GET' && path.startsWith('/v1/payreq/')) {
        return { num_satoshis: '1000' };
      }
      if (method === 'POST' && path === '/v1/channels/transactions') {
        assert.equal(body.fee_limit.fixed, '10');
        return {
          payment_hash: 'payment-hash-visible-only-in-return-value',
          payment_route: { total_fees: '7' },
        };
      }
      throw new Error(`unexpected request ${method} ${path}`);
    },
  };

  await withProofHubWallet(node, async ({ hubWallet, proofLedger, dataLayer, legacyRecords }) => {
    await hubWallet.creditBalance('agent-a', 2000, 'test credit');
    const result = await hubWallet.withdraw('agent-a', 'lnbc1000n1test', 10);

    assert.equal(result.status, 'settled');
    assert.equal(result.amount_sats, 1000);
    assert.equal(result.fee_sats, 7);
    assert.equal(await hubWallet.getBalance('agent-a'), 993);
    assert.equal(proofLedger.getAgentBalance('agent-a').wallet_hub_sats, 993);
    assert.equal(legacyRecords.length, 0);

    const state = await dataLayer.readJSON('data/external-agents/agent-a/state.json');
    assert.equal(state.wallet_balance_sats, 993);

    const eventTypes = proofLedger
      .listProofs({ agentId: 'agent-a', limit: 10 })
      .map((proof) => proof.money_event_type)
      .sort();
    assert.deepEqual(eventTypes, [
      'hub_internal_credit',
      'hub_withdrawal_settled',
      'hub_withdrawal_submitted',
    ].sort());
  });
});

test('proof-backed hub wallet refunds submitted withdrawal when payment fails', async () => {
  const node = {
    request: async (method, path) => {
      if (method === 'GET' && path.startsWith('/v1/payreq/')) {
        return { num_satoshis: '1000' };
      }
      if (method === 'POST' && path === '/v1/channels/transactions') {
        return { payment_error: 'temporary channel failure' };
      }
      throw new Error(`unexpected request ${method} ${path}`);
    },
  };

  await withProofHubWallet(node, async ({ hubWallet, proofLedger }) => {
    await hubWallet.creditBalance('agent-a', 2000, 'test credit');
    await assert.rejects(
      () => hubWallet.withdraw('agent-a', 'lnbc1000n1fail', 10),
      /Payment failed: temporary channel failure/,
    );

    assert.equal(await hubWallet.getBalance('agent-a'), 2000);
    const eventTypes = proofLedger
      .listProofs({ agentId: 'agent-a', limit: 10 })
      .map((proof) => proof.money_event_type)
      .sort();
    assert.deepEqual(eventTypes, [
      'hub_internal_credit',
      'hub_withdrawal_refunded',
      'hub_withdrawal_submitted',
    ].sort());
  });
});

test('proof-backed hub wallet leaves withdrawal pending unknown when payment submission state is unknown', async () => {
  const node = {
    request: async (method, path) => {
      if (method === 'GET' && path.startsWith('/v1/payreq/')) {
        return { num_satoshis: '1000' };
      }
      if (method === 'POST' && path === '/v1/channels/transactions') {
        throw new Error('transport lost after submission');
      }
      throw new Error(`unexpected request ${method} ${path}`);
    },
  };

  await withProofHubWallet(node, async ({ hubWallet, proofLedger }) => {
    await hubWallet.creditBalance('agent-a', 2000, 'test credit');
    await assert.rejects(
      () => hubWallet.withdraw('agent-a', 'lnbc1000n1unknown', 10),
      /transport lost after submission/,
    );

    assert.equal(await hubWallet.getBalance('agent-a'), 1000);
    const proofs = proofLedger.listProofs({ agentId: 'agent-a', limit: 10 });
    assert(proofs.some((proof) =>
      proof.money_event_type === 'hub_withdrawal_submitted' &&
      proof.money_event_status === 'submitted'
    ));
    assert(proofs.some((proof) =>
      proof.money_event_type === 'hub_withdrawal_submitted' &&
      proof.money_event_status === 'unknown'
    ));
    assert.equal(proofs.some((proof) => proof.money_event_type === 'hub_withdrawal_refunded'), false);
  });
});

test('proof-backed hub wallet transfers as one grouped proof event', async () => {
  const node = { request: async () => { throw new Error('not used'); } };

  await withProofHubWallet(node, async ({ hubWallet, proofLedger, dataLayer }) => {
    await hubWallet.creditBalance('agent-a', 1500, 'test credit');
    const result = await hubWallet.transfer('agent-a', 'agent-b', 400, 'test transfer');

    assert.deepEqual(result, { status: 'completed', amount_sats: 400 });
    assert.equal(await hubWallet.getBalance('agent-a'), 1100);
    assert.equal(await hubWallet.getBalance('agent-b'), 400);

    const agentA = proofLedger.listProofs({ agentId: 'agent-a', limit: 10 });
    const agentB = proofLedger.listProofs({ agentId: 'agent-b', limit: 10 });
    assert(agentA.some((proof) => proof.money_event_type === 'hub_transfer_debited'));
    assert(agentB.some((proof) => proof.money_event_type === 'hub_transfer_credited'));

    const debit = agentA.find((proof) => proof.money_event_type === 'hub_transfer_debited');
    const credit = agentB.find((proof) => proof.money_event_type === 'hub_transfer_credited');
    assert.equal(debit.proof_group_id, credit.proof_group_id);

    assert.equal((await dataLayer.readJSON('data/external-agents/agent-a/state.json')).wallet_balance_sats, 1100);
    assert.equal((await dataLayer.readJSON('data/external-agents/agent-b/state.json')).wallet_balance_sats, 400);
  });
});
