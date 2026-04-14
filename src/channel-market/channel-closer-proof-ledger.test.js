import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { ChannelCloser } from './channel-closer.js';
import { ProofLedger } from '../proof-ledger/proof-ledger.js';
import {
  mockAuditLog,
  mockDataLayer,
  mockMutex,
} from './test-mock-factories.js';

async function withProofCloser({ closeThrows = null, work }) {
  const dir = await mkdtemp(join(tmpdir(), 'aol-channel-closer-proof-'));
  const proofLedger = new ProofLedger({
    dbPath: join(dir, 'proof-ledger.sqlite'),
    keyPath: join(dir, 'proof-ledger-key.pem'),
    allowGenerateKey: true,
  });
  const channelPoint = `${'e'.repeat(64)}:1`;
  const closeClient = {
    listChannels: async () => ({
      channels: [{
        channel_point: channelPoint,
        local_balance: '240000',
        active: true,
      }],
    }),
    pendingChannels: async () => ({ pending_open_channels: [] }),
    closeChannel: async () => {
      if (closeThrows) throw closeThrows;
      return {};
    },
  };
  const closer = new ChannelCloser({
    capitalLedger: {
      initiateClose: async () => {},
      rollbackInitiatedClose: async () => {},
    },
    nodeManager: {
      getScopedDefaultNodeOrNull: () => closeClient,
    },
    dataLayer: mockDataLayer(),
    auditLog: mockAuditLog(),
    agentRegistry: {},
    assignmentRegistry: {},
    mutex: mockMutex(),
    proofLedger,
  });
  closer._validate = async () => ({
    success: true,
    instrHash: 'instr-close-proof',
    params: { channel_point: channelPoint, force: false },
    assignment: {
      agent_id: 'agent-close-proof',
      channel_point: channelPoint,
      remote_pubkey: '02' + 'f'.repeat(64),
      capacity: 250_000,
    },
    checks_passed: ['test'],
  });

  try {
    await proofLedger.ensureGenesisProof();
    await work({ closer, proofLedger, channelPoint });
  } finally {
    proofLedger.close();
    await rm(dir, { recursive: true, force: true });
  }
}

test('channel close request appends instruction-accepted and submitted lifecycle proofs', async () => {
  await withProofCloser({
    work: async ({ closer, proofLedger }) => {
      const result = await closer.requestClose('agent-close-proof', {});
      assert.equal(result.success, true);

      const proofs = proofLedger.listProofs({ agentId: 'agent-close-proof', limit: 10 }).reverse();
      assert.deepEqual(proofs.map((proof) => proof.money_event_type), [
        'channel_close_instruction_accepted',
        'channel_close_submitted',
      ]);
      assert(proofs.every((proof) => proof.proof_record_type === 'money_lifecycle'));
      assert(proofs.every((proof) => proofLedger.verifyProof(proof).valid));
    },
  });
});

test('indeterminate channel close appends unknown-submission lifecycle proof', async () => {
  await withProofCloser({
    closeThrows: new Error('timed out while waiting for close stream'),
    work: async ({ closer, proofLedger }) => {
      const result = await closer.requestClose('agent-close-proof', {});
      assert.equal(result.success, true);
      assert.equal(result.status, 'close_submitted_unknown');

      const proofs = proofLedger.listProofs({ agentId: 'agent-close-proof', limit: 10 }).reverse();
      assert.deepEqual(proofs.map((proof) => proof.money_event_type), [
        'channel_close_instruction_accepted',
        'channel_close_submission_unknown',
      ]);
      assert.equal(proofs[1].money_event_status, 'unknown');
      assert(proofs.every((proof) => proofLedger.verifyProof(proof).valid));
    },
  });
});
