import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { ChannelOpener } from './channel-opener.js';
import { ProofLedger } from '../proof-ledger/proof-ledger.js';
import {
  mockAuditLog,
  mockDataLayer,
  mockMutex,
} from './test-mock-factories.js';

async function withProofOpener(work) {
  const dir = await mkdtemp(join(tmpdir(), 'aol-channel-opener-proof-'));
  const proofLedger = new ProofLedger({
    dbPath: join(dir, 'proof-ledger.sqlite'),
    keyPath: join(dir, 'proof-ledger-key.pem'),
    allowGenerateKey: true,
  });
  const openClient = {
    connectPeer: async () => {},
    openChannel: async () => ({
      funding_txid_str: 'c'.repeat(64),
      output_index: 0,
    }),
    listChannels: async () => ({
      channels: [{
        channel_point: `${'d'.repeat(64)}:0`,
        chan_id: '12345',
        remote_pubkey: '02' + 'e'.repeat(64),
        capacity: '500000',
      }],
    }),
    getBestBlock: async () => ({ block_height: 900_000 }),
  };
  const opener = new ChannelOpener({
    capitalLedger: {
      lockForChannel: async () => {},
      unlockForFailedOpen: async () => {},
      getBalance: async () => ({ available: 1_000_000, locked: 0 }),
    },
    nodeManager: {
      getScopedDefaultNodeOrNull: () => openClient,
    },
    dataLayer: mockDataLayer(),
    auditLog: mockAuditLog(),
    agentRegistry: {},
    assignmentRegistry: {
      count: () => 0,
      getByAgent: () => [],
      assign: async () => ({}),
    },
    mutex: mockMutex(),
    proofLedger,
  });

  try {
    await proofLedger.ensureGenesisProof();
    await work({ opener, proofLedger });
  } finally {
    proofLedger.close();
    await rm(dir, { recursive: true, force: true });
  }
}

test('channel open execution appends instruction-accepted and submitted lifecycle proofs', async () => {
  await withProofOpener(async ({ opener, proofLedger }) => {
    opener._validate = async () => ({
      success: true,
      instrHash: 'instr-open-proof',
      params: {
        peer_pubkey: '02' + 'e'.repeat(64),
        local_funding_amount_sats: 250_000,
        private: false,
      },
      peerInfo: { node: { alias: 'peer-proof' } },
      safePeerAddress: null,
      startupPolicy: null,
      checks_passed: ['test'],
    });

    const result = await opener.open('agent-open-proof', {});
    assert.equal(result.success, true);
    assert.equal(result.result.instruction_hash, 'instr-open-proof');

    const proofs = proofLedger.listProofs({ agentId: 'agent-open-proof', limit: 10 }).reverse();
    assert.deepEqual(proofs.map((proof) => proof.money_event_type), [
      'channel_open_instruction_accepted',
      'channel_open_submitted',
    ]);
    assert(proofs.every((proof) => proof.proof_record_type === 'money_lifecycle'));
    assert(proofs.every((proof) => proofLedger.verifyProof(proof).valid));
  });
});

test('channel open polling appends active lifecycle proof when LND activates channel', async () => {
  await withProofOpener(async ({ opener, proofLedger }) => {
    opener._state[`${'d'.repeat(64)}:0`] = {
      agent_id: 'agent-open-proof',
      peer_pubkey: '02' + 'e'.repeat(64),
      peer_alias: 'peer-proof',
      channel_point: `${'d'.repeat(64)}:0`,
      local_funding_amount: 250_000,
      status: 'pending_open',
      requested_at: new Date().toISOString(),
      request_block_height: 899_990,
      startup_policy: null,
      startup_policy_apply_status: null,
      private: false,
      instruction_hash: 'instr-open-proof',
    };

    await opener.pollPendingChannels();

    const proofs = proofLedger.listProofs({ agentId: 'agent-open-proof', limit: 10 });
    assert.equal(proofs.length, 1);
    assert.equal(proofs[0].money_event_type, 'channel_open_active');
    assert.equal(proofs[0].money_event_status, 'confirmed');
    assert.equal(proofs[0].capital_locked_delta_sats, 0);
    assert.equal(proofLedger.verifyProof(proofs[0]).valid, true);
  });
});
