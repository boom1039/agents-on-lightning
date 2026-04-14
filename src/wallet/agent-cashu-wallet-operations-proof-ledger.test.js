import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { getEncodedToken } from '@cashu/cashu-ts';

import { AgentCashuWalletOperations } from './agent-cashu-wallet-operations.js';
import { ProofLedger } from '../proof-ledger/proof-ledger.js';

function proof(amount, suffix) {
  return {
    id: `keyset-${suffix}`,
    amount,
    secret: `secret-${suffix}`,
    C: `02${String(suffix).padStart(64, '0')}`.slice(0, 66),
  };
}

function createProofStore(initialProofs = [], initialPendingSends = []) {
  let proofs = [...initialProofs];
  let pendingSends = [...initialPendingSends];
  const counters = {};
  return {
    loadProofs: async () => [...proofs],
    saveProofs: async (_agentId, next) => {
      proofs = [...next];
    },
    loadCounter: async () => ({ ...counters }),
    saveCounter: async (_agentId, next) => {
      Object.assign(counters, next);
    },
    addPendingSend: async (_agentId, send) => {
      pendingSends.push({ ...send, created_at: Date.now() - 100_000 });
    },
    loadPendingSends: async () => [...pendingSends],
    savePendingSends: async (_agentId, next) => {
      pendingSends = [...next];
    },
    getBalance: async () => proofs.reduce((sum, item) => sum + (item.amount || 0), 0),
    _getProofs: () => proofs,
  };
}

async function withProofWallet({ initialProofs = [], initialPendingSends = [], seedManager = null, wallet, work }) {
  const dir = await mkdtemp(join(tmpdir(), 'aol-cashu-proof-ledger-'));
  const proofLedger = new ProofLedger({
    dbPath: join(dir, 'proof-ledger.sqlite'),
    keyPath: join(dir, 'proof-ledger-key.pem'),
    allowGenerateKey: true,
  });
  const proofStore = createProofStore(initialProofs, initialPendingSends);
  const publicLedgerRows = [];
  const ops = new AgentCashuWalletOperations({
    proofStore,
    ledger: {
      record: async (row) => {
        publicLedgerRows.push(row);
        return row;
      },
    },
    mintUrl: 'https://mint.example',
    seedManager,
    proofLedger,
  });
  ops._getAgentWallet = async () => wallet;

  try {
    await proofLedger.ensureGenesisProof();
    await work({ ops, proofLedger, proofStore, publicLedgerRows });
  } finally {
    proofLedger.close();
    await rm(dir, { recursive: true, force: true });
  }
}

test('mint quote and mint issue append public-safe ecash proof rows', async () => {
  const wallet = {
    keysetId: 'ks1',
    createMintQuote: async () => ({
      quote: 'mint-quote-1',
      request: 'lnbc_invoice_should_not_be_public',
      state: 'UNPAID',
      expiry: 1713021600,
    }),
    mintProofs: async () => [proof(60, 1), proof(40, 2)],
  };

  await withProofWallet({
    wallet,
    work: async ({ ops, proofLedger }) => {
      await ops.mintQuote('agent-cashu', 100);
      await ops.mintProofs('agent-cashu', 100, 'mint-quote-1');

      const rows = proofLedger.listProofs({ agentId: 'agent-cashu', limit: 10 }).reverse();
      assert.deepEqual(rows.map((row) => row.money_event_type), [
        'wallet_mint_quote_created',
        'wallet_mint_issued',
      ]);
      assert.equal(proofLedger.getAgentBalance('agent-cashu').wallet_ecash_sats, 100);
      assert(rows.every((row) => proofLedger.verifyProof(row).valid));

      const refs = JSON.stringify(rows.map((row) => row.public_safe_refs));
      assert(!refs.includes('lnbc_invoice_should_not_be_public'));
      assert(refs.includes('invoice_hash'));
      assert(refs.includes('quote_id'));
    },
  });
});

test('melt, send, receive, and proof reconciliation append correct ecash deltas', async () => {
  const receiveToken = getEncodedToken({
    mint: 'https://mint.example',
    proofs: [proof(45, 8)],
    unit: 'sat',
  });
  const wallet = {
    keysetId: 'ks1',
    send: async (amount) => {
      if (amount === 76) {
        return { send: [proof(76, 3)], keep: [proof(24, 4)] };
      }
      return { send: [proof(amount, 5)], keep: [proof(17, 6)] };
    },
    meltProofs: async () => ({ change: [proof(3, 7)] }),
    receive: async () => [proof(45, 8)],
    checkProofsStates: async (proofs) => proofs.map((_, index) => ({ state: index === 0 ? 'SPENT' : 'UNSPENT' })),
  };

  await withProofWallet({
    initialProofs: [proof(50, 10), proof(30, 11), proof(20, 12)],
    wallet,
    work: async ({ ops, proofLedger }) => {
      await proofLedger.appendProof({
        idempotency_key: 'seed-agent-cashu-ecash-balance',
        proof_record_type: 'money_event',
        money_event_type: 'wallet_mint_issued',
        money_event_status: 'settled',
        agent_id: 'agent-cashu',
        event_source: 'wallet_ecash',
        authorization_method: 'system_settlement',
        primary_amount_sats: 100,
        wallet_ecash_delta_sats: 100,
        public_safe_refs: { amount_sats: 100, status: 'seeded_for_test' },
      });
      ops._pendingMeltQuotes.set('agent-cashu:melt-quote-1', {
        quote: 'melt-quote-1',
        amount: 70,
        fee_reserve: 5,
      });
      await ops.meltProofs('agent-cashu', 'melt-quote-1');
      await ops.sendEcash('agent-cashu', 10);
      await ops.receiveEcash('agent-cashu', receiveToken);
      await ops.checkProofStates('agent-cashu');

      const rows = proofLedger.listProofs({ agentId: 'agent-cashu', limit: 10 }).reverse();
      assert.deepEqual(rows.map((row) => row.money_event_type), [
        'wallet_mint_issued',
        'wallet_melt_paid',
        'wallet_ecash_sent',
        'wallet_ecash_received',
        'wallet_ecash_proof_state_reconciled',
      ]);
      assert.deepEqual(rows.map((row) => row.wallet_ecash_delta_sats), [100, -73, -10, 45, -17]);
      assert.equal(proofLedger.getAgentBalance('agent-cashu').wallet_ecash_sats, 45);

      const refs = JSON.stringify(rows.map((row) => row.public_safe_refs));
      assert(!refs.includes(receiveToken));
      assert(refs.includes('token_hash'));
      assert(rows.every((row) => proofLedger.verifyProof(row).valid));
    },
  });
});

test('pending-send reclaim appends an ecash recovery proof without storing token material', async () => {
  const wallet = {
    keysetId: 'ks1',
    receive: async () => [proof(25, 20)],
  };

  await withProofWallet({
    initialPendingSends: [{
      token: 'cashu_token_should_not_be_public',
      amount: 25,
      created_at: Date.now() - 200_000,
    }],
    wallet,
    work: async ({ ops, proofLedger }) => {
      const result = await ops.reclaimPendingSends('agent-reclaim', 1_000);
      assert.equal(result.reclaimedAmount, 25);

      const rows = proofLedger.listProofs({ agentId: 'agent-reclaim', limit: 10 });
      assert.equal(rows.length, 1);
      assert.equal(rows[0].money_event_type, 'wallet_ecash_pending_reclaimed');
      assert.equal(rows[0].wallet_ecash_delta_sats, 25);
      assert.equal(proofLedger.getAgentBalance('agent-reclaim').wallet_ecash_sats, 25);
      assert(!JSON.stringify(rows[0].public_safe_refs).includes('cashu_token_should_not_be_public'));
      assert.equal(proofLedger.verifyProof(rows[0]).valid, true);
    },
  });
});
