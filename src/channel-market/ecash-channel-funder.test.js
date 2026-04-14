import test from 'node:test';
import assert from 'node:assert/strict';

import { EcashChannelFunder } from './ecash-channel-funder.js';
import { mockAuditLog, mockMutex } from './test-mock-factories.js';

test('ecash channel funding stores nested channel-open proof refs in flow status', async () => {
  let persistedFlows = null;
  const funder = new EcashChannelFunder({
    walletOps: {
      getBalance: async () => 1000,
      sendEcash: async () => ({ token: 'cashu-token-not-returned' }),
      receiveEcash: async () => {},
    },
    channelOpener: {
      open: async () => ({
        success: true,
        result: {
          channel_point: `${'a'.repeat(64)}:0`,
          funding_txid: 'a'.repeat(64),
          instruction_hash: 'instr-ecash-open',
        },
      }),
    },
    capitalLedger: {
      creditEcashFunding: async () => ({ available: 1000 }),
    },
    dataLayer: {
      writeJSON: async (_path, value) => {
        persistedFlows = JSON.parse(JSON.stringify(value));
      },
    },
    auditLog: mockAuditLog(),
    mutex: mockMutex(),
  });

  const result = await funder.fundChannelFromEcash('agent-ecash-flow', {
    instruction: {
      params: {
        local_funding_amount_sats: 250,
      },
    },
  });

  assert.equal(result.success, true);
  assert.equal(result.flow_id in persistedFlows, true);
  assert.deepEqual(persistedFlows[result.flow_id].open_result, {
    channel_point: `${'a'.repeat(64)}:0`,
    funding_txid: 'a'.repeat(64),
    instruction_hash: 'instr-ecash-open',
  });
  assert.equal(persistedFlows[result.flow_id].token, null);
});
