import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { ChannelAssignmentRegistry } from './channel-assignment-registry.js';
import { ProofLedger } from '../proof-ledger/proof-ledger.js';
import {
  mockAuditLog,
  mockDataLayer,
} from '../channel-market/test-mock-factories.js';

test('channel assignment and revoke write zero-delta ownership lifecycle proofs', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'aol-assignment-proof-ledger-'));
  const proofLedger = new ProofLedger({
    dbPath: join(dir, 'proof-ledger.sqlite'),
    keyPath: join(dir, 'proof-ledger-key.pem'),
    allowGenerateKey: true,
  });

  try {
    await proofLedger.ensureGenesisProof();
    const registry = new ChannelAssignmentRegistry(mockDataLayer(), mockAuditLog(), { proofLedger });
    await registry.assign(
      '12345',
      `${'b'.repeat(64)}:1`,
      'agent-assigned',
      { remote_pubkey: '02' + 'c'.repeat(64), capacity: 500_000 },
    );
    await registry.revoke('12345');

    const proofs = proofLedger.listProofs({ agentId: 'agent-assigned', limit: 10 }).reverse();
    assert.deepEqual(proofs.map((proof) => proof.money_event_type), [
      'channel_assignment_created',
      'channel_assignment_revoked',
    ]);
    assert(proofs.every((proof) => proof.proof_record_type === 'money_lifecycle'));
    assert(proofs.every((proof) => proof.wallet_ecash_delta_sats === 0));
    assert(proofs.every((proof) => proof.capital_available_delta_sats === 0));
    assert(proofs.every((proof) => proofLedger.verifyProof(proof).valid));
    assert.equal(proofLedger.verifyChain({ agentId: 'agent-assigned' }).valid, true);
  } finally {
    proofLedger.close();
    await rm(dir, { recursive: true, force: true });
  }
});
