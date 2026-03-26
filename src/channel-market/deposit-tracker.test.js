/**
 * Comprehensive tests for the Deposit Tracker.
 *
 * Run: node --test ai_panel/server/channel-market/deposit-tracker.test.js
 *
 * Coverage:
 *   1. Address generation — Taproot address stored in state
 *   2. Transaction detection — pending_deposit recorded once (idempotency)
 *   3. Confirmation counting — from num_confirmations field
 *   4. Idempotency — same txid polled 100 times → credited once
 *   5. Multi-agent — multiple agents, multiple addresses, correct attribution
 *   6. LND failure — graceful error, polling continues
 *   7. State persistence — load() restores everything
 *   8. Dust deposits — below threshold credited with warning
 *   9. Single-use address — one deposit per address
 *  10. Full lifecycle — generate → detect → confirm → query
 *  11. Confirmed entry purge — auto-cleanup after 24h
 *  12. Incremental polling — block height cursor optimization
 *  13. confirmed_at timestamp — included in status response for confirmed deposits
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { DataLayer } from '../data-layer.js';
import { HashChainAuditLog } from '../channel-accountability/hash-chain-audit-log.js';
import { acquire as acquireMutex } from '../identity/mutex.js';
import { CapitalLedger } from './capital-ledger.js';
import { DepositTracker } from './deposit-tracker.js';

// ---------------------------------------------------------------------------
// Mock LND node client
// ---------------------------------------------------------------------------

function mockNodeManager(overrides = {}) {
  let addressCounter = 0;
  let transactions = [];

  const client = {
    newAddress: async (type) => {
      addressCounter++;
      return { address: `bc1p_test_taproot_address_${addressCounter}` };
    },
    getTransactions: async () => {
      return { transactions };
    },
    getBestBlock: async () => {
      return { block_height: 100 };
    },
    ...overrides,
  };

  return {
    getDefaultNodeOrNull: () => client,
    _client: client,
    _setTransactions: (txs) => { transactions = txs; },
    _getAddressCount: () => addressCounter,
  };
}

function makeTx(txHash, outputs, numConfirmations = 0, blockHeight = 100) {
  return {
    tx_hash: txHash,
    num_confirmations: numConfirmations,
    block_height: blockHeight,
    output_details: outputs.map(([address, amount]) => ({
      address,
      amount: String(amount),
    })),
  };
}

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

async function makeTracker(opts = {}) {
  const tmpDir = await mkdtemp(join(tmpdir(), 'deposit-tracker-test-'));
  const dataLayer = new DataLayer(tmpDir);
  const mutex = { acquire: acquireMutex };
  const auditLog = new HashChainAuditLog(dataLayer, mutex);
  await auditLog._loadTail();
  const capitalLedger = new CapitalLedger({ dataLayer, auditLog, mutex });
  const nodeManager = opts.nodeManager || mockNodeManager();

  const tracker = new DepositTracker({
    capitalLedger,
    nodeManager,
    dataLayer,
    auditLog,
    mutex,
    confirmationsRequired: opts.confirmationsRequired ?? 3,
  });

  return { tracker, capitalLedger, nodeManager, dataLayer, auditLog, tmpDir };
}

// ---------------------------------------------------------------------------
// 1. Address generation
// ---------------------------------------------------------------------------

describe('DepositTracker — address generation', () => {
  let env;
  beforeEach(async () => { env = await makeTracker(); });
  afterEach(async () => { await rm(env.tmpDir, { recursive: true, force: true }); });

  it('generates a Taproot address and stores in state', async () => {
    const { address } = await env.tracker.generateAddress('agent-01');
    assert.ok(address.startsWith('bc1p'), `Expected Taproot address, got ${address}`);

    const status = env.tracker.getDepositStatus('agent-01');
    assert.equal(status.deposits.length, 1);
    assert.equal(status.deposits[0].address, address);
    assert.equal(status.deposits[0].status, 'watching');
    assert.equal(status.deposits[0].amount_sats, null);
    assert.equal(status.deposits[0].txid, null);
  });

  it('generates unique addresses for same agent', async () => {
    const { address: addr1 } = await env.tracker.generateAddress('agent-01');
    const { address: addr2 } = await env.tracker.generateAddress('agent-01');
    assert.notEqual(addr1, addr2);

    const status = env.tracker.getDepositStatus('agent-01');
    assert.equal(status.deposits.length, 2);
  });

  it('generates addresses for different agents', async () => {
    await env.tracker.generateAddress('agent-01');
    await env.tracker.generateAddress('agent-02');

    const s1 = env.tracker.getDepositStatus('agent-01');
    const s2 = env.tracker.getDepositStatus('agent-02');
    assert.equal(s1.deposits.length, 1);
    assert.equal(s2.deposits.length, 1);
    assert.notEqual(s1.deposits[0].address, s2.deposits[0].address);
  });

  it('rejects empty agentId', async () => {
    await assert.rejects(() => env.tracker.generateAddress(''), /valid agentId/);
    await assert.rejects(() => env.tracker.generateAddress(null), /valid agentId/);
  });

  it('fails when no LND node available', async () => {
    const noNodeManager = { getDefaultNodeOrNull: () => null };
    const tracker2Env = await makeTracker({ nodeManager: noNodeManager });
    await assert.rejects(() => tracker2Env.tracker.generateAddress('agent-01'), /No LND node/);
    await rm(tracker2Env.tmpDir, { recursive: true, force: true });
  });
});

// ---------------------------------------------------------------------------
// 2. Transaction detection
// ---------------------------------------------------------------------------

describe('DepositTracker — transaction detection', () => {
  let env;
  beforeEach(async () => { env = await makeTracker(); });
  afterEach(async () => { await rm(env.tmpDir, { recursive: true, force: true }); });

  it('detects a deposit and records pending_deposit in ledger', async () => {
    const { address } = await env.tracker.generateAddress('agent-01');

    env.nodeManager._setTransactions([
      makeTx('txid-abc', [[address, 100_000]], 1),
    ]);

    await env.tracker.pollForDeposits();

    const status = env.tracker.getDepositStatus('agent-01');
    assert.equal(status.deposits[0].status, 'pending_deposit');
    assert.equal(status.deposits[0].amount_sats, 100_000);
    assert.equal(status.deposits[0].txid, 'txid-abc');

    const bal = await env.capitalLedger.getBalance('agent-01');
    assert.equal(bal.pending_deposit, 100_000);
    assert.equal(bal.total_deposited, 100_000);
  });

  it('ignores transactions to addresses not in our watch set', async () => {
    await env.tracker.generateAddress('agent-01');

    env.nodeManager._setTransactions([
      makeTx('txid-xyz', [['bc1p_some_other_address', 500_000]], 6),
    ]);

    await env.tracker.pollForDeposits();

    const status = env.tracker.getDepositStatus('agent-01');
    assert.equal(status.deposits[0].status, 'watching');
    assert.equal(status.deposits[0].txid, null);
  });

  it('does not poll when no active addresses', async () => {
    // No addresses generated, should return early without error
    await env.tracker.pollForDeposits();
  });
});

// ---------------------------------------------------------------------------
// 3. Confirmation counting
// ---------------------------------------------------------------------------

describe('DepositTracker — confirmation counting', () => {
  let env;
  beforeEach(async () => { env = await makeTracker({ confirmationsRequired: 3 }); });
  afterEach(async () => { await rm(env.tmpDir, { recursive: true, force: true }); });

  it('confirms deposit when num_confirmations >= threshold', async () => {
    const { address } = await env.tracker.generateAddress('agent-01');

    // First poll: 1 confirmation (detect)
    env.nodeManager._setTransactions([makeTx('txid-abc', [[address, 50_000]], 1)]);
    await env.tracker.pollForDeposits();

    let status = env.tracker.getDepositStatus('agent-01');
    assert.equal(status.deposits[0].status, 'pending_deposit');

    // Second poll: 2 confirmations (still pending)
    env.nodeManager._setTransactions([makeTx('txid-abc', [[address, 50_000]], 2)]);
    await env.tracker.pollForDeposits();

    status = env.tracker.getDepositStatus('agent-01');
    assert.equal(status.deposits[0].status, 'pending_deposit');
    assert.equal(status.deposits[0].confirmations, 2);

    // Third poll: 3 confirmations (confirmed!)
    env.nodeManager._setTransactions([makeTx('txid-abc', [[address, 50_000]], 3)]);
    await env.tracker.pollForDeposits();

    status = env.tracker.getDepositStatus('agent-01');
    assert.equal(status.deposits[0].status, 'confirmed');
    assert.equal(status.deposits[0].confirmations, 3);

    const bal = await env.capitalLedger.getBalance('agent-01');
    assert.equal(bal.available, 50_000);
    assert.equal(bal.pending_deposit, 0);
  });

  it('handles transaction arriving already confirmed', async () => {
    const { address } = await env.tracker.generateAddress('agent-01');

    // Transaction shows up with 10 confirmations already
    env.nodeManager._setTransactions([makeTx('txid-deep', [[address, 200_000]], 10)]);
    await env.tracker.pollForDeposits();

    // Should go through detect AND confirm in single poll
    const status = env.tracker.getDepositStatus('agent-01');
    assert.equal(status.deposits[0].status, 'confirmed');
    assert.equal(status.deposits[0].amount_sats, 200_000);

    const bal = await env.capitalLedger.getBalance('agent-01');
    assert.equal(bal.available, 200_000);
    assert.equal(bal.pending_deposit, 0);
  });
});

// ---------------------------------------------------------------------------
// 4. Idempotency — same txid polled many times
// ---------------------------------------------------------------------------

describe('DepositTracker — idempotency', () => {
  let env;
  beforeEach(async () => { env = await makeTracker({ confirmationsRequired: 3 }); });
  afterEach(async () => { await rm(env.tmpDir, { recursive: true, force: true }); });

  it('polling same txid 100 times only credits once', async () => {
    const { address } = await env.tracker.generateAddress('agent-01');

    // Detect phase: poll 50 times at 1 confirmation
    env.nodeManager._setTransactions([makeTx('txid-repeat', [[address, 75_000]], 1)]);
    for (let i = 0; i < 50; i++) {
      await env.tracker.pollForDeposits();
    }

    let bal = await env.capitalLedger.getBalance('agent-01');
    assert.equal(bal.pending_deposit, 75_000, 'Should only record once');
    assert.equal(bal.total_deposited, 75_000);

    // Confirm phase: poll 50 times at 6 confirmations
    env.nodeManager._setTransactions([makeTx('txid-repeat', [[address, 75_000]], 6)]);
    for (let i = 0; i < 50; i++) {
      await env.tracker.pollForDeposits();
    }

    bal = await env.capitalLedger.getBalance('agent-01');
    assert.equal(bal.available, 75_000, 'Should only confirm once');
    assert.equal(bal.pending_deposit, 0);
    assert.equal(bal.total_deposited, 75_000);
  });
});

// ---------------------------------------------------------------------------
// 5. Multi-agent attribution
// ---------------------------------------------------------------------------

describe('DepositTracker — multi-agent', () => {
  let env;
  beforeEach(async () => { env = await makeTracker({ confirmationsRequired: 1 }); });
  afterEach(async () => { await rm(env.tmpDir, { recursive: true, force: true }); });

  it('correctly attributes deposits to different agents', async () => {
    const { address: addr1 } = await env.tracker.generateAddress('agent-01');
    const { address: addr2 } = await env.tracker.generateAddress('agent-02');
    const { address: addr3 } = await env.tracker.generateAddress('agent-03');

    env.nodeManager._setTransactions([
      makeTx('tx-a', [[addr1, 100_000]], 3),
      makeTx('tx-b', [[addr2, 200_000]], 3),
      makeTx('tx-c', [[addr3, 300_000]], 3),
    ]);

    await env.tracker.pollForDeposits();

    const bal1 = await env.capitalLedger.getBalance('agent-01');
    const bal2 = await env.capitalLedger.getBalance('agent-02');
    const bal3 = await env.capitalLedger.getBalance('agent-03');

    assert.equal(bal1.available, 100_000);
    assert.equal(bal2.available, 200_000);
    assert.equal(bal3.available, 300_000);
  });

  it('getDepositStatus returns only the requesting agent deposits', async () => {
    await env.tracker.generateAddress('agent-01');
    await env.tracker.generateAddress('agent-01');
    await env.tracker.generateAddress('agent-02');

    const s1 = env.tracker.getDepositStatus('agent-01');
    const s2 = env.tracker.getDepositStatus('agent-02');

    assert.equal(s1.deposits.length, 2);
    assert.equal(s2.deposits.length, 1);
    assert.ok(s1.deposits.every(d => d.status === 'watching'));
  });
});

// ---------------------------------------------------------------------------
// 6. LND failure — graceful degradation
// ---------------------------------------------------------------------------

describe('DepositTracker — LND failure resilience', () => {
  let env;
  beforeEach(async () => { env = await makeTracker(); });
  afterEach(async () => { await rm(env.tmpDir, { recursive: true, force: true }); });

  it('handles getTransactions() failure gracefully', async () => {
    const { address } = await env.tracker.generateAddress('agent-01');

    // Override getTransactions to throw
    env.nodeManager._client.getTransactions = async () => {
      throw new Error('LND connection refused');
    };

    // Should not throw — error is caught and logged
    await env.tracker.pollForDeposits();

    // State unchanged
    const status = env.tracker.getDepositStatus('agent-01');
    assert.equal(status.deposits[0].status, 'watching');
  });

  it('resumes normal operation after LND recovers', async () => {
    const { address } = await env.tracker.generateAddress('agent-01');

    // First poll: LND down
    env.nodeManager._client.getTransactions = async () => {
      throw new Error('LND down');
    };
    await env.tracker.pollForDeposits();

    // Second poll: LND back, transaction present
    env.nodeManager._setTransactions([makeTx('txid-recover', [[address, 88_000]], 5)]);
    env.nodeManager._client.getTransactions = async () => {
      return { transactions: [makeTx('txid-recover', [[address, 88_000]], 5)] };
    };
    await env.tracker.pollForDeposits();

    const status = env.tracker.getDepositStatus('agent-01');
    assert.equal(status.deposits[0].status, 'confirmed');
    assert.equal(status.deposits[0].amount_sats, 88_000);
  });

  it('skips polling when no LND node available', async () => {
    const noNodeManager = {
      getDefaultNodeOrNull: () => null,
      _setTransactions: () => {},
      _client: {},
    };
    const tracker2Env = await makeTracker({ nodeManager: noNodeManager });
    await tracker2Env.tracker.generateAddress('agent-01').catch(() => {});
    // Should not throw
    await tracker2Env.tracker.pollForDeposits();
    await rm(tracker2Env.tmpDir, { recursive: true, force: true });
  });
});

// ---------------------------------------------------------------------------
// 7. State persistence
// ---------------------------------------------------------------------------

describe('DepositTracker — state persistence', () => {
  let env;
  beforeEach(async () => { env = await makeTracker({ confirmationsRequired: 6 }); });
  afterEach(async () => { await rm(env.tmpDir, { recursive: true, force: true }); });

  it('load() restores state after simulated restart', async () => {
    const { address } = await env.tracker.generateAddress('agent-01');

    env.nodeManager._setTransactions([makeTx('txid-persist', [[address, 150_000]], 2)]);
    await env.tracker.pollForDeposits();

    // Create new tracker instance pointing at same data dir (simulates restart)
    const tracker2 = new DepositTracker({
      capitalLedger: env.capitalLedger,
      nodeManager: env.nodeManager,
      dataLayer: env.dataLayer,
      auditLog: env.auditLog,
      mutex: { acquire: acquireMutex },
      confirmationsRequired: 6,
    });
    await tracker2.load();

    const status = tracker2.getDepositStatus('agent-01');
    assert.equal(status.deposits.length, 1);
    assert.equal(status.deposits[0].status, 'pending_deposit');
    assert.equal(status.deposits[0].amount_sats, 150_000);
    assert.equal(status.deposits[0].txid, 'txid-persist');
    assert.equal(status.deposits[0].confirmations, 2);
  });

  it('fresh load with no state file succeeds', async () => {
    const tracker2 = new DepositTracker({
      capitalLedger: env.capitalLedger,
      nodeManager: env.nodeManager,
      dataLayer: env.dataLayer,
      auditLog: env.auditLog,
      mutex: { acquire: acquireMutex },
    });
    await tracker2.load();

    const stats = tracker2.getStats();
    assert.equal(stats.total, 0);
  });
});

// ---------------------------------------------------------------------------
// 8. Dust deposits
// ---------------------------------------------------------------------------

describe('DepositTracker — dust deposits', () => {
  let env;
  beforeEach(async () => { env = await makeTracker({ confirmationsRequired: 1 }); });
  afterEach(async () => { await rm(env.tmpDir, { recursive: true, force: true }); });

  it('credits dust deposit below 10,000 sats', async () => {
    const { address } = await env.tracker.generateAddress('agent-01');

    env.nodeManager._setTransactions([makeTx('txid-dust', [[address, 546]], 3)]);
    await env.tracker.pollForDeposits();

    const status = env.tracker.getDepositStatus('agent-01');
    assert.equal(status.deposits[0].status, 'confirmed');
    assert.equal(status.deposits[0].amount_sats, 546);

    const bal = await env.capitalLedger.getBalance('agent-01');
    assert.equal(bal.available, 546);
  });
});

// ---------------------------------------------------------------------------
// 9. Single-use address
// ---------------------------------------------------------------------------

describe('DepositTracker — single-use address', () => {
  let env;
  beforeEach(async () => { env = await makeTracker({ confirmationsRequired: 1 }); });
  afterEach(async () => { await rm(env.tmpDir, { recursive: true, force: true }); });

  it('tracks first deposit to address correctly', async () => {
    const { address } = await env.tracker.generateAddress('agent-01');

    env.nodeManager._setTransactions([
      makeTx('txid-first', [[address, 100_000]], 3),
    ]);
    await env.tracker.pollForDeposits();

    const bal = await env.capitalLedger.getBalance('agent-01');
    assert.equal(bal.available, 100_000);
  });
});

// ---------------------------------------------------------------------------
// 10. Full lifecycle
// ---------------------------------------------------------------------------

describe('DepositTracker — full lifecycle', () => {
  let env;
  beforeEach(async () => { env = await makeTracker({ confirmationsRequired: 3 }); });
  afterEach(async () => { await rm(env.tmpDir, { recursive: true, force: true }); });

  it('generate → detect → confirm → query', async () => {
    // 1. Generate address
    const { address } = await env.tracker.generateAddress('agent-alpha');
    assert.ok(address);

    let status = env.tracker.getDepositStatus('agent-alpha');
    assert.equal(status.deposits.length, 1);
    assert.equal(status.deposits[0].status, 'watching');

    // 2. Deposit detected with 0 confirmations
    env.nodeManager._setTransactions([makeTx('txid-life', [[address, 1_000_000]], 0)]);
    await env.tracker.pollForDeposits();

    status = env.tracker.getDepositStatus('agent-alpha');
    assert.equal(status.deposits[0].status, 'pending_deposit');
    assert.equal(status.deposits[0].amount_sats, 1_000_000);

    let bal = await env.capitalLedger.getBalance('agent-alpha');
    assert.equal(bal.pending_deposit, 1_000_000);
    assert.equal(bal.available, 0);

    // 3. Confirmations increase
    env.nodeManager._setTransactions([makeTx('txid-life', [[address, 1_000_000]], 2)]);
    await env.tracker.pollForDeposits();

    status = env.tracker.getDepositStatus('agent-alpha');
    assert.equal(status.deposits[0].status, 'pending_deposit');
    assert.equal(status.deposits[0].confirmations, 2);

    // 4. Confirmation threshold reached
    env.nodeManager._setTransactions([makeTx('txid-life', [[address, 1_000_000]], 3)]);
    await env.tracker.pollForDeposits();

    status = env.tracker.getDepositStatus('agent-alpha');
    assert.equal(status.deposits[0].status, 'confirmed');

    bal = await env.capitalLedger.getBalance('agent-alpha');
    assert.equal(bal.available, 1_000_000);
    assert.equal(bal.pending_deposit, 0);
    assert.equal(bal.total_deposited, 1_000_000);

    // 5. Stats reflect the state
    const stats = env.tracker.getStats();
    assert.equal(stats.confirmed, 1);
    assert.equal(stats.watching, 0);
    assert.equal(stats.pending_deposit, 0);
  });

  it('polling start/stop works', async () => {
    env.tracker.startPolling(60_000);
    assert.ok(env.tracker._pollTimer !== null);

    // Starting again is idempotent
    env.tracker.startPolling(60_000);

    env.tracker.stopPolling();
    assert.equal(env.tracker._pollTimer, null);

    // Stopping again is safe
    env.tracker.stopPolling();
  });
});

// ---------------------------------------------------------------------------
// 11. Confirmed entry purge
// ---------------------------------------------------------------------------

describe('DepositTracker — confirmed entry purge', () => {
  let env;
  beforeEach(async () => { env = await makeTracker({ confirmationsRequired: 1 }); });
  afterEach(async () => { await rm(env.tmpDir, { recursive: true, force: true }); });

  it('purges confirmed entries older than 24 hours', async () => {
    const { address } = await env.tracker.generateAddress('agent-01');

    // Detect and confirm deposit
    env.nodeManager._setTransactions([makeTx('txid-purge', [[address, 50_000]], 3)]);
    await env.tracker.pollForDeposits();

    let status = env.tracker.getDepositStatus('agent-01');
    assert.equal(status.deposits[0].status, 'confirmed');

    // Backdate confirmed_at to 25 hours ago
    env.tracker._state[address].confirmed_at = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();

    // Next poll should purge it
    env.nodeManager._setTransactions([]);
    // Need at least one active address for poll to run — generate a new one
    await env.tracker.generateAddress('agent-02');
    await env.tracker.pollForDeposits();

    status = env.tracker.getDepositStatus('agent-01');
    assert.equal(status.deposits.length, 0, 'Purged entry should be gone');
  });

  it('does NOT purge confirmed entries younger than 24 hours', async () => {
    const { address } = await env.tracker.generateAddress('agent-01');

    env.nodeManager._setTransactions([makeTx('txid-recent', [[address, 50_000]], 3)]);
    await env.tracker.pollForDeposits();

    let status = env.tracker.getDepositStatus('agent-01');
    assert.equal(status.deposits[0].status, 'confirmed');
    assert.ok(status.deposits[0].confirmed_at, 'Should have confirmed_at timestamp');

    // Poll again — entry should still be there
    await env.tracker.generateAddress('agent-02');
    await env.tracker.pollForDeposits();

    status = env.tracker.getDepositStatus('agent-01');
    assert.equal(status.deposits.length, 1, 'Recent confirmed entry should remain');
  });
});

// ---------------------------------------------------------------------------
// 12. Incremental polling
// ---------------------------------------------------------------------------

describe('DepositTracker — incremental polling', () => {
  let env;
  beforeEach(async () => { env = await makeTracker({ confirmationsRequired: 1 }); });
  afterEach(async () => { await rm(env.tmpDir, { recursive: true, force: true }); });

  it('passes start_height to getTransactions after first poll', async () => {
    const { address } = await env.tracker.generateAddress('agent-01');

    let capturedStartHeight = null;
    env.nodeManager._client.getTransactions = async (startHeight) => {
      capturedStartHeight = startHeight;
      return { transactions: [makeTx('txid-incr', [[address, 50_000]], 3, 95)] };
    };
    env.nodeManager._client.getBestBlock = async () => ({ block_height: 100 });

    // First poll — cursor starts at 0
    await env.tracker.pollForDeposits();
    assert.equal(capturedStartHeight, 0, 'First poll should start from 0');

    // After first poll, cursor should be 100
    assert.equal(env.tracker._lastPollBlockHeight, 100);

    // Second poll — generate new address to keep active set non-empty
    await env.tracker.generateAddress('agent-02');
    env.nodeManager._client.getTransactions = async (startHeight) => {
      capturedStartHeight = startHeight;
      return { transactions: [] };
    };
    env.nodeManager._client.getBestBlock = async () => ({ block_height: 105 });
    await env.tracker.pollForDeposits();

    assert.equal(capturedStartHeight, 100, 'Second poll should use cursor height');
  });

  it('persists and restores _lastPollBlockHeight across restarts', async () => {
    const { address } = await env.tracker.generateAddress('agent-01');

    env.nodeManager._client.getBestBlock = async () => ({ block_height: 500 });
    env.nodeManager._setTransactions([makeTx('txid-persist-cursor', [[address, 50_000]], 3, 495)]);
    await env.tracker.pollForDeposits();

    assert.equal(env.tracker._lastPollBlockHeight, 500);

    // Simulate restart — new tracker from same data dir
    const tracker2 = new DepositTracker({
      capitalLedger: env.capitalLedger,
      nodeManager: env.nodeManager,
      dataLayer: env.dataLayer,
      auditLog: env.auditLog,
      mutex: { acquire: acquireMutex },
      confirmationsRequired: 1,
    });
    await tracker2.load();

    assert.equal(tracker2._lastPollBlockHeight, 500, 'Cursor should survive restart');
  });
});

// ---------------------------------------------------------------------------
// 13. confirmed_at in status response
// ---------------------------------------------------------------------------

describe('DepositTracker — confirmed_at in status response', () => {
  let env;
  beforeEach(async () => { env = await makeTracker({ confirmationsRequired: 1 }); });
  afterEach(async () => { await rm(env.tmpDir, { recursive: true, force: true }); });

  it('includes confirmed_at for confirmed deposits, omits for others', async () => {
    const { address: addr1 } = await env.tracker.generateAddress('agent-01');
    const { address: addr2 } = await env.tracker.generateAddress('agent-01');

    // Confirm only first deposit
    env.nodeManager._setTransactions([makeTx('txid-ts', [[addr1, 50_000]], 3)]);
    await env.tracker.pollForDeposits();

    const status = env.tracker.getDepositStatus('agent-01');
    const confirmed = status.deposits.find(d => d.status === 'confirmed');
    const watching = status.deposits.find(d => d.status === 'watching');

    assert.ok(confirmed.confirmed_at, 'Confirmed deposit should have confirmed_at');
    assert.ok(!watching.confirmed_at, 'Watching deposit should not have confirmed_at');

    // Verify it's a valid ISO timestamp
    const ts = new Date(confirmed.confirmed_at);
    assert.ok(!isNaN(ts.getTime()), 'confirmed_at should be a valid date');
  });
});

// ---------------------------------------------------------------------------
// Constructor validation
// ---------------------------------------------------------------------------

describe('DepositTracker — constructor validation', () => {
  it('rejects missing dependencies', () => {
    assert.throws(() => new DepositTracker({}), /capitalLedger/);
    assert.throws(() => new DepositTracker({ capitalLedger: {} }), /nodeManager/);
    assert.throws(() => new DepositTracker({ capitalLedger: {}, nodeManager: {} }), /dataLayer/);
  });
});
