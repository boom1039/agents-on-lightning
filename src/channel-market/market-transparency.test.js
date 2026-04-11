import test from 'node:test';
import assert from 'node:assert/strict';
import { MarketTransparency } from './market-transparency.js';

test('getPeerSafety tolerates missing node info and still returns a response', async () => {
  const transparency = new MarketTransparency({
    assignmentRegistry: {
      getAllAssignments() {
        return [];
      },
    },
    agentRegistry: {
      count() {
        return 0;
      },
    },
    lndCache: {
      async getClosedChannels() {
        return [];
      },
      async getNodeInfo() {
        throw new Error('unable to find node');
      },
    },
  });

  const pubkey = `02${'1'.repeat(64)}`;
  const result = await transparency.getPeerSafety(pubkey);

  assert.equal(result.peer_pubkey, pubkey);
  assert.equal(result.peer_alias, null);
  assert.equal(result.force_closes, 0);
  assert.equal(result.safe, true);
  assert.deepEqual(result.warnings, []);
});
