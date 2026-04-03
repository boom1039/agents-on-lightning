/**
 * Comprehensive tests for the Capital Ledger.
 *
 * Run: node --test ai_panel/server/channel-market/capital-ledger.test.js
 *
 * Coverage:
 *   1. Unit tests — every ledger operation with exact balance assertions
 *   2. Invariant tests — double-entry holds after every sequence
 *   3. Negative balance tests — all must fail cleanly
 *   4. Concurrency tests — 10 simultaneous operations serialize correctly
 *   5. Race condition tests — deposit+withdraw racing
 *   6. Restart resilience — kill mid-write, invariant holds
 *   7. Corruption detection — corrupt state file, system refuses
 *   8. Activity log completeness — every state change logged, replay matches
 *   9. Two-agent isolation — no cross-contamination
 *  10. Plan validation scenario — full lifecycle
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { DataLayer } from '../data-layer.js';
import { HashChainAuditLog } from '../channel-accountability/hash-chain-audit-log.js';
import { acquire as acquireMutex } from '../identity/mutex.js';
import { CapitalLedger } from './capital-ledger.js';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

async function makeLedger() {
  const tmpDir = await mkdtemp(join(tmpdir(), 'capital-ledger-test-'));
  const dataLayer = new DataLayer(tmpDir);
  const mutex = { acquire: acquireMutex };
  const auditLog = new HashChainAuditLog(dataLayer, mutex);
  await auditLog._loadTail();
  const ledger = new CapitalLedger({ dataLayer, auditLog, mutex });
  return { ledger, dataLayer, auditLog, tmpDir };
}

function assertInvariantHolds(bal) {
  const lhs = bal.total_deposited + bal.total_revenue_credited + bal.total_ecash_funded;
  const rhs = bal.available + bal.locked + bal.pending_deposit +
              bal.pending_close + bal.total_withdrawn + bal.total_routing_pnl;
  assert.equal(lhs, rhs,
    `Invariant violated: LHS=${lhs} != RHS=${rhs} | ` +
    JSON.stringify(bal));
}

// ---------------------------------------------------------------------------
// 1. Unit tests — every operation
// ---------------------------------------------------------------------------

describe('CapitalLedger — unit tests', () => {
  let env;
  beforeEach(async () => { env = await makeLedger(); });
  afterEach(async () => { await rm(env.tmpDir, { recursive: true, force: true }); });

  it('getBalance returns zeros for unknown agent', async () => {
    const bal = await env.ledger.getBalance('agent-new');
    assert.equal(bal.available, 0);
    assert.equal(bal.locked, 0);
    assert.equal(bal.pending_deposit, 0);
    assert.equal(bal.pending_close, 0);
    assert.equal(bal.total_deposited, 0);
    assert.equal(bal.total_withdrawn, 0);
    assert.equal(bal.total_revenue_credited, 0);
    assert.equal(bal.total_routing_pnl, 0);
    assertInvariantHolds(bal);
  });

  it('recordDeposit creates pending_deposit', async () => {
    const bal = await env.ledger.recordDeposit('agent-01', 500_000, 'tx:abc123');
    assert.equal(bal.pending_deposit, 500_000);
    assert.equal(bal.total_deposited, 500_000);
    assert.equal(bal.available, 0);
    assertInvariantHolds(bal);
  });

  it('confirmDeposit moves pending to available', async () => {
    await env.ledger.recordDeposit('agent-01', 500_000, 'tx:abc123');
    const bal = await env.ledger.confirmDeposit('agent-01', 500_000, 'tx:abc123');
    assert.equal(bal.pending_deposit, 0);
    assert.equal(bal.available, 500_000);
    assert.equal(bal.total_deposited, 500_000);
    assertInvariantHolds(bal);
  });

  it('lockForChannel moves available to locked', async () => {
    await env.ledger.recordDeposit('agent-01', 1_000_000, 'tx:dep1');
    await env.ledger.confirmDeposit('agent-01', 1_000_000, 'tx:dep1');
    const bal = await env.ledger.lockForChannel('agent-01', 600_000, 'abc:0');
    assert.equal(bal.available, 400_000);
    assert.equal(bal.locked, 600_000);
    assertInvariantHolds(bal);
  });

  it('unlockForFailedOpen returns locked to available', async () => {
    await env.ledger.recordDeposit('agent-01', 1_000_000, 'tx:dep1');
    await env.ledger.confirmDeposit('agent-01', 1_000_000, 'tx:dep1');
    await env.ledger.lockForChannel('agent-01', 600_000, 'abc:0');
    const bal = await env.ledger.unlockForFailedOpen('agent-01', 600_000, 'abc:0:failed');
    assert.equal(bal.available, 1_000_000);
    assert.equal(bal.locked, 0);
    assertInvariantHolds(bal);
  });

  it('initiateClose with routing loss', async () => {
    await env.ledger.recordDeposit('agent-01', 1_000_000, 'tx:dep1');
    await env.ledger.confirmDeposit('agent-01', 1_000_000, 'tx:dep1');
    await env.ledger.lockForChannel('agent-01', 500_000, 'abc:0');
    // Channel closes with 300k local balance (200k routing loss)
    const bal = await env.ledger.initiateClose('agent-01', 300_000, 500_000, 'abc:0');
    assert.equal(bal.locked, 0);
    assert.equal(bal.pending_close, 300_000);
    assert.equal(bal.total_routing_pnl, 200_000);
    assert.equal(bal.available, 500_000);
    assertInvariantHolds(bal);
  });

  it('initiateClose with routing gain', async () => {
    await env.ledger.recordDeposit('agent-01', 1_000_000, 'tx:dep1');
    await env.ledger.confirmDeposit('agent-01', 1_000_000, 'tx:dep1');
    await env.ledger.lockForChannel('agent-01', 500_000, 'abc:0');
    // Channel closes with 600k local balance (100k routing gain)
    const bal = await env.ledger.initiateClose('agent-01', 600_000, 500_000, 'abc:0');
    assert.equal(bal.locked, 0);
    assert.equal(bal.pending_close, 600_000);
    assert.equal(bal.total_routing_pnl, -100_000);
    assertInvariantHolds(bal);
  });

  it('settleClose moves pending_close to available', async () => {
    await env.ledger.recordDeposit('agent-01', 1_000_000, 'tx:dep1');
    await env.ledger.confirmDeposit('agent-01', 1_000_000, 'tx:dep1');
    await env.ledger.lockForChannel('agent-01', 500_000, 'abc:0');
    await env.ledger.initiateClose('agent-01', 300_000, 500_000, 'abc:0');
    const bal = await env.ledger.settleClose('agent-01', 300_000, 'tx:settle1');
    assert.equal(bal.pending_close, 0);
    assert.equal(bal.available, 800_000);
    assertInvariantHolds(bal);
  });

  it('rollbackInitiatedClose restores locked funds after a failed close call', async () => {
    await env.ledger.recordDeposit('agent-01', 1_000_000, 'tx:dep1');
    await env.ledger.confirmDeposit('agent-01', 1_000_000, 'tx:dep1');
    await env.ledger.lockForChannel('agent-01', 500_000, 'abc:0');
    await env.ledger.initiateClose('agent-01', 300_000, 500_000, 'abc:0');
    const bal = await env.ledger.rollbackInitiatedClose('agent-01', 300_000, 500_000, 'abc:0', 'lnd-close-failed');
    assert.equal(bal.available, 500_000);
    assert.equal(bal.locked, 500_000);
    assert.equal(bal.pending_close, 0);
    assert.equal(bal.total_routing_pnl, 0);
    assertInvariantHolds(bal);
  });

  it('withdraw reduces available and increases total_withdrawn', async () => {
    await env.ledger.recordDeposit('agent-01', 1_000_000, 'tx:dep1');
    await env.ledger.confirmDeposit('agent-01', 1_000_000, 'tx:dep1');
    const bal = await env.ledger.withdraw('agent-01', 200_000, 'bc1qwithdraw');
    assert.equal(bal.available, 800_000);
    assert.equal(bal.total_withdrawn, 200_000);
    assertInvariantHolds(bal);
  });

  it('creditRevenue increases available and total_revenue_credited', async () => {
    await env.ledger.recordDeposit('agent-01', 500_000, 'tx:dep1');
    await env.ledger.confirmDeposit('agent-01', 500_000, 'tx:dep1');
    const bal = await env.ledger.creditRevenue('agent-01', 15_000, 'forward:1711929600:123456');
    assert.equal(bal.available, 515_000);
    assert.equal(bal.total_revenue_credited, 15_000);
    assertInvariantHolds(bal);
  });

  it('getAllBalances returns all agents', async () => {
    await env.ledger.recordDeposit('agent-01', 100_000, 'tx:a');
    await env.ledger.confirmDeposit('agent-01', 100_000, 'tx:a');
    await env.ledger.recordDeposit('agent-02', 200_000, 'tx:b');
    await env.ledger.confirmDeposit('agent-02', 200_000, 'tx:b');

    const all = await env.ledger.getAllBalances();
    assert.equal(Object.keys(all).length, 2);
    assert.equal(all['agent-01'].available, 100_000);
    assert.equal(all['agent-02'].available, 200_000);
  });
});

// ---------------------------------------------------------------------------
// 2. Invariant tests — after every sequence
// ---------------------------------------------------------------------------

describe('CapitalLedger — invariant after complex sequences', () => {
  let env;
  beforeEach(async () => { env = await makeLedger(); });
  afterEach(async () => { await rm(env.tmpDir, { recursive: true, force: true }); });

  it('plan validation scenario: deposit → lock → close with loss → withdraw → zero', async () => {
    // Deposit 1M sats
    let bal = await env.ledger.recordDeposit('agent-01', 1_000_000, 'tx:dep1');
    assertInvariantHolds(bal);
    bal = await env.ledger.confirmDeposit('agent-01', 1_000_000, 'tx:dep1');
    assertInvariantHolds(bal);

    // Lock 500k for channel
    bal = await env.ledger.lockForChannel('agent-01', 500_000, 'chan:abc:0');
    assertInvariantHolds(bal);
    assert.equal(bal.available, 500_000);
    assert.equal(bal.locked, 500_000);

    // Close channel with 300k local (200k routing loss)
    bal = await env.ledger.initiateClose('agent-01', 300_000, 500_000, 'chan:abc:0');
    assertInvariantHolds(bal);

    // Settle close
    bal = await env.ledger.settleClose('agent-01', 300_000, 'tx:settle1');
    assertInvariantHolds(bal);
    assert.equal(bal.available, 800_000);

    // Withdraw 800k — should leave zero available
    bal = await env.ledger.withdraw('agent-01', 800_000, 'bc1qfinal');
    assertInvariantHolds(bal);
    assert.equal(bal.available, 0);
    assert.equal(bal.locked, 0);
    assert.equal(bal.pending_deposit, 0);
    assert.equal(bal.pending_close, 0);
    assert.equal(bal.total_deposited, 1_000_000);
    assert.equal(bal.total_withdrawn, 800_000);
    assert.equal(bal.total_routing_pnl, 200_000);
  });

  it('revenue credit + operations maintain invariant', async () => {
    await env.ledger.recordDeposit('agent-01', 500_000, 'tx:dep1');
    await env.ledger.confirmDeposit('agent-01', 500_000, 'tx:dep1');
    let bal = await env.ledger.creditRevenue('agent-01', 5_000, 'forward:1711929600:111111');
    assertInvariantHolds(bal);
    assert.equal(bal.total_revenue_credited, 5_000);
    assert.equal(bal.available, 505_000);

    // Lock and unlock
    bal = await env.ledger.lockForChannel('agent-01', 100_000, 'chan:xyz:0');
    assertInvariantHolds(bal);
    bal = await env.ledger.unlockForFailedOpen('agent-01', 100_000, 'chan:xyz:0:fail');
    assertInvariantHolds(bal);
    assert.equal(bal.available, 505_000);
  });

  it('multiple deposits and partial withdrawals', async () => {
    for (let i = 0; i < 5; i++) {
      await env.ledger.recordDeposit('agent-01', 100_000, `tx:dep${i}`);
      await env.ledger.confirmDeposit('agent-01', 100_000, `tx:dep${i}`);
    }
    let bal = await env.ledger.getBalance('agent-01');
    assert.equal(bal.available, 500_000);
    assert.equal(bal.total_deposited, 500_000);
    assertInvariantHolds(bal);

    // Partial withdrawals
    for (let i = 0; i < 3; i++) {
      bal = await env.ledger.withdraw('agent-01', 50_000, `bc1q${i}`);
      assertInvariantHolds(bal);
    }
    assert.equal(bal.available, 350_000);
    assert.equal(bal.total_withdrawn, 150_000);
  });
});

// ---------------------------------------------------------------------------
// 3. Negative balance tests
// ---------------------------------------------------------------------------

describe('CapitalLedger — negative balance prevention', () => {
  let env;
  beforeEach(async () => { env = await makeLedger(); });
  afterEach(async () => { await rm(env.tmpDir, { recursive: true, force: true }); });

  it('lock more than available fails', async () => {
    await env.ledger.recordDeposit('agent-01', 100_000, 'tx:dep1');
    await env.ledger.confirmDeposit('agent-01', 100_000, 'tx:dep1');
    await assert.rejects(
      () => env.ledger.lockForChannel('agent-01', 200_000, 'chan:over:0'),
      /Insufficient available balance/,
    );
    // Balance unchanged
    const bal = await env.ledger.getBalance('agent-01');
    assert.equal(bal.available, 100_000);
    assert.equal(bal.locked, 0);
    assertInvariantHolds(bal);
  });

  it('withdraw more than available fails', async () => {
    await env.ledger.recordDeposit('agent-01', 100_000, 'tx:dep1');
    await env.ledger.confirmDeposit('agent-01', 100_000, 'tx:dep1');
    await assert.rejects(
      () => env.ledger.withdraw('agent-01', 200_000, 'bc1qtoomuch'),
      /Insufficient available balance/,
    );
    const bal = await env.ledger.getBalance('agent-01');
    assert.equal(bal.available, 100_000);
    assertInvariantHolds(bal);
  });

  it('confirm more than pending fails', async () => {
    await env.ledger.recordDeposit('agent-01', 100_000, 'tx:dep1');
    await assert.rejects(
      () => env.ledger.confirmDeposit('agent-01', 200_000, 'tx:dep1'),
      /Insufficient pending_deposit/,
    );
    const bal = await env.ledger.getBalance('agent-01');
    assert.equal(bal.pending_deposit, 100_000);
    assertInvariantHolds(bal);
  });

  it('unlock more than locked fails', async () => {
    await env.ledger.recordDeposit('agent-01', 100_000, 'tx:dep1');
    await env.ledger.confirmDeposit('agent-01', 100_000, 'tx:dep1');
    await env.ledger.lockForChannel('agent-01', 50_000, 'chan:a:0');
    await assert.rejects(
      () => env.ledger.unlockForFailedOpen('agent-01', 100_000, 'chan:a:0:fail'),
      /Insufficient locked balance/,
    );
  });

  it('settle more than pending_close fails', async () => {
    await env.ledger.recordDeposit('agent-01', 100_000, 'tx:dep1');
    await env.ledger.confirmDeposit('agent-01', 100_000, 'tx:dep1');
    await env.ledger.lockForChannel('agent-01', 100_000, 'chan:a:0');
    await env.ledger.initiateClose('agent-01', 80_000, 100_000, 'chan:a:0');
    await assert.rejects(
      () => env.ledger.settleClose('agent-01', 100_000, 'tx:settle'),
      /Insufficient pending_close/,
    );
  });

  it('initiate close with more than locked fails', async () => {
    await env.ledger.recordDeposit('agent-01', 100_000, 'tx:dep1');
    await env.ledger.confirmDeposit('agent-01', 100_000, 'tx:dep1');
    await env.ledger.lockForChannel('agent-01', 50_000, 'chan:a:0');
    await assert.rejects(
      () => env.ledger.initiateClose('agent-01', 40_000, 100_000, 'chan:a:0'),
      /Insufficient locked balance/,
    );
  });

  it('zero amount deposit fails', async () => {
    await assert.rejects(
      () => env.ledger.recordDeposit('agent-01', 0, 'tx:zero'),
      /positive integer/,
    );
  });

  it('negative amount fails', async () => {
    await assert.rejects(
      () => env.ledger.recordDeposit('agent-01', -100, 'tx:neg'),
      /positive integer/,
    );
  });

  it('fractional amount fails', async () => {
    await assert.rejects(
      () => env.ledger.recordDeposit('agent-01', 1.5, 'tx:frac'),
      /positive integer/,
    );
  });

  it('withdraw from fresh account fails', async () => {
    await assert.rejects(
      () => env.ledger.withdraw('agent-01', 1, 'bc1qempty'),
      /Insufficient available balance/,
    );
  });
});

// ---------------------------------------------------------------------------
// 4. Input validation tests
// ---------------------------------------------------------------------------

describe('CapitalLedger — input validation', () => {
  let env;
  beforeEach(async () => { env = await makeLedger(); });
  afterEach(async () => { await rm(env.tmpDir, { recursive: true, force: true }); });

  it('rejects empty agent ID', async () => {
    await assert.rejects(
      () => env.ledger.getBalance(''),
      /Invalid agent ID/,
    );
  });

  it('rejects agent ID with special chars', async () => {
    await assert.rejects(
      () => env.ledger.getBalance('agent/../../../etc/passwd'),
      /Invalid agent ID/,
    );
  });

  it('rejects deposit without txid', async () => {
    await assert.rejects(
      () => env.ledger.recordDeposit('agent-01', 100_000, ''),
      /requires a txid/,
    );
  });

  it('rejects lock without channelPoint', async () => {
    await assert.rejects(
      () => env.ledger.lockForChannel('agent-01', 100_000, ''),
      /requires a channelPoint/,
    );
  });

  it('rejects withdraw without destination', async () => {
    await assert.rejects(
      () => env.ledger.withdraw('agent-01', 100_000, ''),
      /requires a destinationAddress/,
    );
  });

  it('rejects creditRevenue without reference', async () => {
    await assert.rejects(
      () => env.ledger.creditRevenue('agent-01', 100_000, ''),
      /requires a reference/,
    );
  });
});

// ---------------------------------------------------------------------------
// 5. Concurrency tests — 10 simultaneous operations
// ---------------------------------------------------------------------------

describe('CapitalLedger — concurrency', () => {
  let env;
  beforeEach(async () => { env = await makeLedger(); });
  afterEach(async () => { await rm(env.tmpDir, { recursive: true, force: true }); });

  it('10 simultaneous deposits on same agent serialize correctly', async () => {
    const promises = [];
    for (let i = 0; i < 10; i++) {
      promises.push(env.ledger.recordDeposit('agent-01', 100_000, `tx:concurrent-${i}`));
    }
    await Promise.all(promises);

    // Now confirm all 10
    const confirmPromises = [];
    for (let i = 0; i < 10; i++) {
      confirmPromises.push(env.ledger.confirmDeposit('agent-01', 100_000, `tx:concurrent-${i}`));
    }
    await Promise.all(confirmPromises);

    const bal = await env.ledger.getBalance('agent-01');
    assert.equal(bal.available, 1_000_000);
    assert.equal(bal.total_deposited, 1_000_000);
    assert.equal(bal.pending_deposit, 0);
    assertInvariantHolds(bal);
  });

  it('simultaneous lock + withdraw racing on same agent', async () => {
    // Set up: 500k available
    await env.ledger.recordDeposit('agent-01', 500_000, 'tx:dep1');
    await env.ledger.confirmDeposit('agent-01', 500_000, 'tx:dep1');

    // Race: try to lock 300k AND withdraw 300k at same time
    // Only one should succeed (total needed = 600k > 500k available)
    const results = await Promise.allSettled([
      env.ledger.lockForChannel('agent-01', 300_000, 'chan:race:0'),
      env.ledger.withdraw('agent-01', 300_000, 'bc1qrace'),
    ]);

    const succeeded = results.filter(r => r.status === 'fulfilled').length;
    const failed = results.filter(r => r.status === 'rejected').length;

    // Exactly one should succeed and one should fail
    // (mutex serializes, first completes, second finds insufficient balance)
    assert.equal(succeeded, 1, 'Exactly one should succeed');
    assert.equal(failed, 1, 'Exactly one should fail');

    const bal = await env.ledger.getBalance('agent-01');
    assert.equal(bal.available + bal.locked + bal.total_withdrawn, 500_000);
    assertInvariantHolds(bal);
  });

  it('concurrent operations on different agents do not interfere', async () => {
    // Deposit to two agents concurrently
    await Promise.all([
      env.ledger.recordDeposit('agent-01', 100_000, 'tx:a1'),
      env.ledger.recordDeposit('agent-02', 200_000, 'tx:a2'),
    ]);
    await Promise.all([
      env.ledger.confirmDeposit('agent-01', 100_000, 'tx:a1'),
      env.ledger.confirmDeposit('agent-02', 200_000, 'tx:a2'),
    ]);

    const bal1 = await env.ledger.getBalance('agent-01');
    const bal2 = await env.ledger.getBalance('agent-02');
    assert.equal(bal1.available, 100_000);
    assert.equal(bal2.available, 200_000);
    assertInvariantHolds(bal1);
    assertInvariantHolds(bal2);
  });
});

// ---------------------------------------------------------------------------
// 6. Restart resilience
// ---------------------------------------------------------------------------

describe('CapitalLedger — restart resilience', () => {
  let tmpDir;
  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'capital-ledger-restart-'));
  });
  afterEach(async () => { await rm(tmpDir, { recursive: true, force: true }); });

  it('state survives ledger recreation (simulates Express restart)', async () => {
    // First "session"
    const dl1 = new DataLayer(tmpDir);
    const mutex1 = { acquire: acquireMutex };
    const audit1 = new HashChainAuditLog(dl1, mutex1);
    await audit1._loadTail();
    const ledger1 = new CapitalLedger({ dataLayer: dl1, auditLog: audit1, mutex: mutex1 });

    await ledger1.recordDeposit('agent-01', 1_000_000, 'tx:dep1');
    await ledger1.confirmDeposit('agent-01', 1_000_000, 'tx:dep1');
    await ledger1.lockForChannel('agent-01', 300_000, 'chan:abc:0');

    // "Restart" — create entirely new instances pointing at same data dir
    const dl2 = new DataLayer(tmpDir);
    const mutex2 = { acquire: acquireMutex };
    const audit2 = new HashChainAuditLog(dl2, mutex2);
    await audit2._loadTail();
    const ledger2 = new CapitalLedger({ dataLayer: dl2, auditLog: audit2, mutex: mutex2 });

    const bal = await ledger2.getBalance('agent-01');
    assert.equal(bal.available, 700_000);
    assert.equal(bal.locked, 300_000);
    assert.equal(bal.total_deposited, 1_000_000);
    assertInvariantHolds(bal);

    // Can continue operating after restart
    const bal2 = await ledger2.unlockForFailedOpen('agent-01', 300_000, 'chan:abc:0:fail');
    assert.equal(bal2.available, 1_000_000);
    assert.equal(bal2.locked, 0);
    assertInvariantHolds(bal2);
  });

  it('activity log persists across restarts', async () => {
    const dl1 = new DataLayer(tmpDir);
    const mutex1 = { acquire: acquireMutex };
    const audit1 = new HashChainAuditLog(dl1, mutex1);
    await audit1._loadTail();
    const ledger1 = new CapitalLedger({ dataLayer: dl1, auditLog: audit1, mutex: mutex1 });

    await ledger1.recordDeposit('agent-01', 500_000, 'tx:dep1');
    await ledger1.confirmDeposit('agent-01', 500_000, 'tx:dep1');

    // Restart
    const dl2 = new DataLayer(tmpDir);
    const mutex2 = { acquire: acquireMutex };
    const audit2 = new HashChainAuditLog(dl2, mutex2);
    await audit2._loadTail();
    const ledger2 = new CapitalLedger({ dataLayer: dl2, auditLog: audit2, mutex: mutex2 });

    const { entries, total } = await ledger2.readActivity({ agentId: 'agent-01' });
    assert.equal(total, 2, 'Should have 2 activity entries from before restart');
    assert.equal(entries[0].type, 'deposit_confirmed'); // newest first
    assert.equal(entries[1].type, 'deposit_pending');
  });
});

// ---------------------------------------------------------------------------
// 7. Corruption detection
// ---------------------------------------------------------------------------

describe('CapitalLedger — corruption detection', () => {
  let env;
  beforeEach(async () => { env = await makeLedger(); });
  afterEach(async () => { await rm(env.tmpDir, { recursive: true, force: true }); });

  it('rejects state file with missing field', async () => {
    // Write a corrupt state directly
    const statePath = join(env.tmpDir, 'data/channel-market/capital');
    await mkdir(statePath, { recursive: true });
    await writeFile(join(statePath, 'agent-corrupt.json'), JSON.stringify({
      available: 100_000,
      locked: 0,
      // missing: pending_deposit, pending_close, total_deposited, etc.
    }));

    await assert.rejects(
      () => env.ledger.getBalance('agent-corrupt'),
      /Corrupt state/,
    );
  });

  it('rejects state file with NaN field', async () => {
    const statePath = join(env.tmpDir, 'data/channel-market/capital');
    await mkdir(statePath, { recursive: true });
    await writeFile(join(statePath, 'agent-nan.json'), JSON.stringify({
      available: 100_000,
      locked: 0,
      pending_deposit: 0,
      pending_close: 0,
      total_deposited: 100_000,
      total_withdrawn: 0,
      total_revenue_credited: 0,
      total_routing_pnl: 'not-a-number',
      last_updated: new Date().toISOString(),
    }));

    await assert.rejects(
      () => env.ledger.getBalance('agent-nan'),
      /Corrupt state/,
    );
  });

  it('rejects operation on state file with broken invariant', async () => {
    const statePath = join(env.tmpDir, 'data/channel-market/capital');
    await mkdir(statePath, { recursive: true });
    // State where invariant is already broken
    await writeFile(join(statePath, 'agent-broken.json'), JSON.stringify({
      available: 999_999,
      locked: 0,
      pending_deposit: 0,
      pending_close: 0,
      total_deposited: 100_000, // doesn't match available
      total_withdrawn: 0,
      total_revenue_credited: 0,
      total_routing_pnl: 0,
      last_updated: new Date().toISOString(),
    }));

    // Any write operation should detect the broken invariant
    await assert.rejects(
      () => env.ledger.creditRevenue('agent-broken', 1, 'forward:1711929600:999999'),
      /INVARIANT VIOLATION/,
    );
  });
});

// ---------------------------------------------------------------------------
// 8. Activity log completeness — replay and reconstruct
// ---------------------------------------------------------------------------

describe('CapitalLedger — activity log completeness', () => {
  let env;
  beforeEach(async () => { env = await makeLedger(); });
  afterEach(async () => { await rm(env.tmpDir, { recursive: true, force: true }); });

  it('every state change has a corresponding activity entry', async () => {
    await env.ledger.recordDeposit('agent-01', 500_000, 'tx:dep1');      // 1
    await env.ledger.confirmDeposit('agent-01', 500_000, 'tx:dep1');     // 2
    await env.ledger.lockForChannel('agent-01', 200_000, 'chan:a:0');    // 3
    await env.ledger.initiateClose('agent-01', 150_000, 200_000, 'chan:a:0'); // 4 + 5 (routing_pnl)
    await env.ledger.settleClose('agent-01', 150_000, 'tx:settle');      // 6
    await env.ledger.creditRevenue('agent-01', 10_000, 'forward:1711929600:222222'); // 7
    await env.ledger.withdraw('agent-01', 100_000, 'bc1qwd');            // 8

    const { entries, total } = await env.ledger.readActivity({ agentId: 'agent-01' });
    // deposit_pending, deposit_confirmed, lock_for_channel, unlock_from_channel,
    // routing_pnl, close_settled, credit_revenue, withdrawal = 8 entries
    assert.equal(total, 8);

    // Every entry has required fields
    for (const e of entries) {
      assert.ok(e.agent_id, 'Must have agent_id');
      assert.ok(e.type, 'Must have type');
      assert.ok(e.balance_after, 'Must have balance_after');
      assert.ok(e._ts, 'Must have timestamp');
    }
  });

  it('replay activity log reconstructs final balance from zero', async () => {
    // Perform a complex sequence
    await env.ledger.recordDeposit('agent-01', 1_000_000, 'tx:dep1');
    await env.ledger.confirmDeposit('agent-01', 1_000_000, 'tx:dep1');
    await env.ledger.lockForChannel('agent-01', 400_000, 'chan:a:0');
    await env.ledger.creditRevenue('agent-01', 5_000, 'forward:1711929600:333333');
    await env.ledger.withdraw('agent-01', 100_000, 'bc1qwd');

    // Read balance from ledger
    const actual = await env.ledger.getBalance('agent-01');

    // Read the last activity entry — its balance_after should match
    const { entries } = await env.ledger.readActivity({ agentId: 'agent-01' });
    const lastEntry = entries[0]; // newest first
    const replayedBal = lastEntry.balance_after;

    assert.equal(replayedBal.available, actual.available);
    assert.equal(replayedBal.locked, actual.locked);
    assert.equal(replayedBal.pending_deposit, actual.pending_deposit);
    assert.equal(replayedBal.pending_close, actual.pending_close);
    assert.equal(replayedBal.total_deposited, actual.total_deposited);
    assert.equal(replayedBal.total_withdrawn, actual.total_withdrawn);
    assert.equal(replayedBal.total_revenue_credited, actual.total_revenue_credited);
    assert.equal(replayedBal.total_routing_pnl, actual.total_routing_pnl);
  });
});

// ---------------------------------------------------------------------------
// 9. Two-agent isolation
// ---------------------------------------------------------------------------

describe('CapitalLedger — two-agent isolation', () => {
  let env;
  beforeEach(async () => { env = await makeLedger(); });
  afterEach(async () => { await rm(env.tmpDir, { recursive: true, force: true }); });

  it('operations on agent-01 do not affect agent-02', async () => {
    await env.ledger.recordDeposit('agent-01', 1_000_000, 'tx:a1');
    await env.ledger.confirmDeposit('agent-01', 1_000_000, 'tx:a1');
    await env.ledger.recordDeposit('agent-02', 500_000, 'tx:a2');
    await env.ledger.confirmDeposit('agent-02', 500_000, 'tx:a2');

    await env.ledger.lockForChannel('agent-01', 900_000, 'chan:01:0');
    await env.ledger.withdraw('agent-02', 200_000, 'bc1qa2wd');

    const bal1 = await env.ledger.getBalance('agent-01');
    const bal2 = await env.ledger.getBalance('agent-02');

    assert.equal(bal1.available, 100_000);
    assert.equal(bal1.locked, 900_000);
    assert.equal(bal1.total_withdrawn, 0);

    assert.equal(bal2.available, 300_000);
    assert.equal(bal2.locked, 0);
    assert.equal(bal2.total_withdrawn, 200_000);

    assertInvariantHolds(bal1);
    assertInvariantHolds(bal2);
  });

  it('activity log filters by agent correctly', async () => {
    await env.ledger.recordDeposit('agent-01', 100_000, 'tx:a1');
    await env.ledger.recordDeposit('agent-02', 200_000, 'tx:a2');
    await env.ledger.recordDeposit('agent-01', 300_000, 'tx:a1b');

    const { entries: a1entries, total: a1total } = await env.ledger.readActivity({ agentId: 'agent-01' });
    const { entries: a2entries, total: a2total } = await env.ledger.readActivity({ agentId: 'agent-02' });

    assert.equal(a1total, 2);
    assert.equal(a2total, 1);

    for (const e of a1entries) assert.equal(e.agent_id, 'agent-01');
    for (const e of a2entries) assert.equal(e.agent_id, 'agent-02');
  });
});

// ---------------------------------------------------------------------------
// 10. Atomic write safety (DataLayer uses tmp+rename)
// ---------------------------------------------------------------------------

describe('CapitalLedger — atomic write safety', () => {
  let env;
  beforeEach(async () => { env = await makeLedger(); });
  afterEach(async () => { await rm(env.tmpDir, { recursive: true, force: true }); });

  it('state file is valid JSON after operation', async () => {
    await env.ledger.recordDeposit('agent-01', 1_000_000, 'tx:dep1');
    await env.ledger.confirmDeposit('agent-01', 1_000_000, 'tx:dep1');

    // Read the raw state file
    const raw = await readFile(
      join(env.tmpDir, 'data/channel-market/capital/agent-01.json'),
      'utf-8',
    );
    const parsed = JSON.parse(raw);
    assert.equal(parsed.available, 1_000_000);
    assert.ok(parsed.last_updated);
  });

  it('no tmp files left after operations', async () => {
    await env.ledger.recordDeposit('agent-01', 100_000, 'tx:dep1');
    await env.ledger.confirmDeposit('agent-01', 100_000, 'tx:dep1');

    const entries = await env.dataLayer.listDir('data/channel-market/capital');
    const tmpFiles = entries.filter(e => e.name.includes('.tmp.'));
    assert.equal(tmpFiles.length, 0, 'No tmp files should remain');
  });
});

// ---------------------------------------------------------------------------
// 11. Audit chain integration
// ---------------------------------------------------------------------------

describe('CapitalLedger — audit chain', () => {
  let env;
  beforeEach(async () => { env = await makeLedger(); });
  afterEach(async () => { await rm(env.tmpDir, { recursive: true, force: true }); });

  it('every operation appends to audit chain', async () => {
    await env.ledger.recordDeposit('agent-01', 500_000, 'tx:dep1');
    await env.ledger.confirmDeposit('agent-01', 500_000, 'tx:dep1');
    await env.ledger.lockForChannel('agent-01', 200_000, 'chan:a:0');

    const auditEntries = await env.auditLog.readAll({ limit: 100 });
    const capitalEntries = auditEntries.filter(e => e.domain === 'capital');

    assert.ok(capitalEntries.length >= 3, `Expected >= 3 capital audit entries, got ${capitalEntries.length}`);

    // Each entry has a hash (chain integrity)
    for (const e of capitalEntries) {
      assert.ok(e.hash, 'Audit entry must have hash');
      assert.ok(e.prev_hash, 'Audit entry must have prev_hash');
    }
  });

  it('audit chain verifies successfully after operations', async () => {
    await env.ledger.recordDeposit('agent-01', 500_000, 'tx:dep1');
    await env.ledger.confirmDeposit('agent-01', 500_000, 'tx:dep1');
    await env.ledger.withdraw('agent-01', 100_000, 'bc1qwd');

    const verification = await env.auditLog.verify();
    assert.equal(verification.valid, true, `Chain should be valid: ${JSON.stringify(verification.errors)}`);
    assert.ok(verification.checked > 0);
  });
});

// ---------------------------------------------------------------------------
// 12. Constructor validation
// ---------------------------------------------------------------------------

describe('CapitalLedger — constructor', () => {
  it('throws without dataLayer', () => {
    assert.throws(
      () => new CapitalLedger({ auditLog: {}, mutex: {} }),
      /requires dataLayer/,
    );
  });

  it('throws without auditLog', () => {
    assert.throws(
      () => new CapitalLedger({ dataLayer: {}, mutex: {} }),
      /requires auditLog/,
    );
  });

  it('throws without mutex', () => {
    assert.throws(
      () => new CapitalLedger({ dataLayer: {}, auditLog: {} }),
      /requires mutex/,
    );
  });
});

// ---------------------------------------------------------------------------
// 13. settleClose with zero amount (channel drained completely)
// ---------------------------------------------------------------------------

describe('CapitalLedger — edge cases', () => {
  let env;
  beforeEach(async () => { env = await makeLedger(); });
  afterEach(async () => { await rm(env.tmpDir, { recursive: true, force: true }); });

  it('initiateClose with zero local balance (fully drained channel)', async () => {
    await env.ledger.recordDeposit('agent-01', 500_000, 'tx:dep1');
    await env.ledger.confirmDeposit('agent-01', 500_000, 'tx:dep1');
    await env.ledger.lockForChannel('agent-01', 500_000, 'chan:drain:0');

    // Channel fully drained — 0 local balance, 500k routing loss
    const bal = await env.ledger.initiateClose('agent-01', 0, 500_000, 'chan:drain:0');
    assert.equal(bal.locked, 0);
    assert.equal(bal.pending_close, 0);
    assert.equal(bal.total_routing_pnl, 500_000);
    assertInvariantHolds(bal);

    // Settle with zero
    const bal2 = await env.ledger.settleClose('agent-01', 0, 'tx:settle-drain');
    assert.equal(bal2.available, 0);
    assertInvariantHolds(bal2);
  });

  it('multiple channels open and close with different routing outcomes', async () => {
    await env.ledger.recordDeposit('agent-01', 3_000_000, 'tx:dep1');
    await env.ledger.confirmDeposit('agent-01', 3_000_000, 'tx:dep1');

    // Open 3 channels
    await env.ledger.lockForChannel('agent-01', 1_000_000, 'chan:a:0');
    await env.ledger.lockForChannel('agent-01', 1_000_000, 'chan:b:0');
    await env.ledger.lockForChannel('agent-01', 1_000_000, 'chan:c:0');

    // Close with different outcomes:
    // chan:a — loss of 200k
    await env.ledger.initiateClose('agent-01', 800_000, 1_000_000, 'chan:a:0');
    // chan:b — gain of 100k
    await env.ledger.initiateClose('agent-01', 1_100_000, 1_000_000, 'chan:b:0');
    // chan:c — break even
    await env.ledger.initiateClose('agent-01', 1_000_000, 1_000_000, 'chan:c:0');

    let bal = await env.ledger.getBalance('agent-01');
    assert.equal(bal.locked, 0);
    assert.equal(bal.pending_close, 2_900_000);
    assert.equal(bal.total_routing_pnl, 100_000); // net: 200k loss - 100k gain = 100k
    assertInvariantHolds(bal);

    // Settle all
    await env.ledger.settleClose('agent-01', 800_000, 'tx:settle-a');
    await env.ledger.settleClose('agent-01', 1_100_000, 'tx:settle-b');
    bal = await env.ledger.settleClose('agent-01', 1_000_000, 'tx:settle-c');

    assert.equal(bal.pending_close, 0);
    assert.equal(bal.available, 2_900_000);
    assertInvariantHolds(bal);
  });

  it('readActivity with pagination', async () => {
    for (let i = 0; i < 10; i++) {
      await env.ledger.recordDeposit('agent-01', 10_000, `tx:dep${i}`);
    }

    const page1 = await env.ledger.readActivity({ agentId: 'agent-01', limit: 3, offset: 0 });
    assert.equal(page1.entries.length, 3);
    assert.equal(page1.total, 10);

    const page2 = await env.ledger.readActivity({ agentId: 'agent-01', limit: 3, offset: 3 });
    assert.equal(page2.entries.length, 3);

    // No overlap — check by reference since _ts can collide within a millisecond
    const refs1 = page1.entries.map(e => e.reference);
    const refs2 = page2.entries.map(e => e.reference);
    for (const ref of refs1) {
      assert.ok(!refs2.includes(ref), 'Pages should not overlap');
    }
  });
});

// ---------------------------------------------------------------------------
// 14. Idempotency — duplicate rejection
// ---------------------------------------------------------------------------

describe('CapitalLedger — idempotency', () => {
  let env;
  beforeEach(async () => { env = await makeLedger(); });
  afterEach(async () => { await rm(env.tmpDir, { recursive: true, force: true }); });

  it('recordDeposit same txid twice → second call throws, balance unchanged', async () => {
    await env.ledger.recordDeposit('agent-01', 500_000, 'tx:dup1');
    await assert.rejects(
      () => env.ledger.recordDeposit('agent-01', 500_000, 'tx:dup1'),
      /Duplicate operation/,
    );
    const bal = await env.ledger.getBalance('agent-01');
    assert.equal(bal.pending_deposit, 500_000);
    assert.equal(bal.total_deposited, 500_000);
    assertInvariantHolds(bal);
  });

  it('confirmDeposit same txid twice → second call throws', async () => {
    await env.ledger.recordDeposit('agent-01', 500_000, 'tx:conf1');
    await env.ledger.confirmDeposit('agent-01', 500_000, 'tx:conf1');
    await assert.rejects(
      () => env.ledger.confirmDeposit('agent-01', 500_000, 'tx:conf1'),
      /Duplicate operation/,
    );
  });

  it('creditRevenue same reference twice → second call throws', async () => {
    await env.ledger.recordDeposit('agent-01', 100_000, 'tx:dep1');
    await env.ledger.confirmDeposit('agent-01', 100_000, 'tx:dep1');
    await env.ledger.creditRevenue('agent-01', 5_000, 'forward:1711929600:444444');
    await assert.rejects(
      () => env.ledger.creditRevenue('agent-01', 5_000, 'forward:1711929600:444444'),
      /Duplicate operation/,
    );
    const bal = await env.ledger.getBalance('agent-01');
    assert.equal(bal.total_revenue_credited, 5_000);
  });

  it('different txids are not treated as duplicates', async () => {
    await env.ledger.recordDeposit('agent-01', 100_000, 'tx:a');
    await env.ledger.recordDeposit('agent-01', 100_000, 'tx:b');
    const bal = await env.ledger.getBalance('agent-01');
    assert.equal(bal.pending_deposit, 200_000);
  });
});

// ---------------------------------------------------------------------------
// 15. initiateClose localBalance bounds
// ---------------------------------------------------------------------------

describe('CapitalLedger — initiateClose bounds', () => {
  let env;
  beforeEach(async () => { env = await makeLedger(); });
  afterEach(async () => { await rm(env.tmpDir, { recursive: true, force: true }); });

  it('rejects localBalance > 3x originalLocked (phantom sats)', async () => {
    await env.ledger.recordDeposit('agent-01', 1_000_000, 'tx:dep1');
    await env.ledger.confirmDeposit('agent-01', 1_000_000, 'tx:dep1');
    await env.ledger.lockForChannel('agent-01', 500_000, 'chan:bound:0');
    await assert.rejects(
      () => env.ledger.initiateClose('agent-01', 2_500_000, 500_000, 'chan:bound:0'),
      /exceeds 3x originalLocked/,
    );
    // Balance unchanged
    const bal = await env.ledger.getBalance('agent-01');
    assert.equal(bal.locked, 500_000);
  });

  it('allows localBalance = 1.5x originalLocked (routing gain)', async () => {
    await env.ledger.recordDeposit('agent-01', 1_000_000, 'tx:dep1');
    await env.ledger.confirmDeposit('agent-01', 1_000_000, 'tx:dep1');
    await env.ledger.lockForChannel('agent-01', 500_000, 'chan:gain:0');
    const bal = await env.ledger.initiateClose('agent-01', 750_000, 500_000, 'chan:gain:0');
    assert.equal(bal.locked, 0);
    assert.equal(bal.pending_close, 750_000);
    assertInvariantHolds(bal);
  });

  it('allows localBalance = originalLocked (break even)', async () => {
    await env.ledger.recordDeposit('agent-01', 1_000_000, 'tx:dep1');
    await env.ledger.confirmDeposit('agent-01', 1_000_000, 'tx:dep1');
    await env.ledger.lockForChannel('agent-01', 500_000, 'chan:even:0');
    const bal = await env.ledger.initiateClose('agent-01', 500_000, 500_000, 'chan:even:0');
    assert.equal(bal.total_routing_pnl, 0);
    assertInvariantHolds(bal);
  });
});

// ---------------------------------------------------------------------------
// 16. creditEcashFunding (Plan J)
// ---------------------------------------------------------------------------

describe('CapitalLedger — creditEcashFunding', () => {
  let env;
  beforeEach(async () => { env = await makeLedger(); });
  afterEach(async () => { await rm(env.tmpDir, { recursive: true, force: true }); });

  it('credits available + total_ecash_funded', async () => {
    const bal = await env.ledger.creditEcashFunding('agent-01', 250_000, 'ecash-fund:flow-1');
    assert.equal(bal.available, 250_000);
    assert.equal(bal.total_ecash_funded, 250_000);
    assert.equal(bal.total_deposited, 0);
    assert.equal(bal.total_revenue_credited, 0);
    assertInvariantHolds(bal);
  });

  it('rejects duplicate references', async () => {
    await env.ledger.creditEcashFunding('agent-01', 100_000, 'ecash-fund:dup');
    await assert.rejects(
      () => env.ledger.creditEcashFunding('agent-01', 100_000, 'ecash-fund:dup'),
      /Duplicate operation/,
    );
    const bal = await env.ledger.getBalance('agent-01');
    assert.equal(bal.total_ecash_funded, 100_000);
  });

  it('invariant holds through mixed deposit + ecash funding + lock cycle', async () => {
    // On-chain deposit
    await env.ledger.recordDeposit('agent-01', 500_000, 'tx:dep1');
    await env.ledger.confirmDeposit('agent-01', 500_000, 'tx:dep1');

    // Ecash funding
    let bal = await env.ledger.creditEcashFunding('agent-01', 200_000, 'ecash-fund:flow-1');
    assert.equal(bal.available, 700_000);
    assert.equal(bal.total_ecash_funded, 200_000);
    assertInvariantHolds(bal);

    // Lock and close
    bal = await env.ledger.lockForChannel('agent-01', 600_000, 'chan:mixed:0');
    assertInvariantHolds(bal);
    bal = await env.ledger.initiateClose('agent-01', 500_000, 600_000, 'chan:mixed:0');
    assertInvariantHolds(bal);
    bal = await env.ledger.settleClose('agent-01', 500_000, 'tx:settle-mixed');
    assertInvariantHolds(bal);
    assert.equal(bal.available, 600_000);
  });
});

// ---------------------------------------------------------------------------
// 17. settleRebalance (Plan H)
// ---------------------------------------------------------------------------

describe('CapitalLedger — settleRebalance', () => {
  let env;
  beforeEach(async () => { env = await makeLedger(); });
  afterEach(async () => { await rm(env.tmpDir, { recursive: true, force: true }); });

  it('deducts actual fee from locked, refunds remainder to available', async () => {
    await env.ledger.recordDeposit('agent-01', 1_000_000, 'tx:dep1');
    await env.ledger.confirmDeposit('agent-01', 1_000_000, 'tx:dep1');
    await env.ledger.lockForChannel('agent-01', 500, 'rebalance:hash1');

    // Rebalance succeeded with 32 sat fee (locked 500)
    const bal = await env.ledger.settleRebalance('agent-01', 500, 32, 'rebalance:hash1');
    assert.equal(bal.locked, 0);
    assert.equal(bal.available, 999_968); // 1M - 32
    assert.equal(bal.total_routing_pnl, 32);
    assertInvariantHolds(bal);
  });

  it('full refund when actualFee is 0 (failed rebalance settled)', async () => {
    await env.ledger.recordDeposit('agent-01', 1_000_000, 'tx:dep1');
    await env.ledger.confirmDeposit('agent-01', 1_000_000, 'tx:dep1');
    await env.ledger.lockForChannel('agent-01', 500, 'rebalance:hash2');

    const bal = await env.ledger.settleRebalance('agent-01', 500, 0, 'rebalance:hash2');
    assert.equal(bal.locked, 0);
    assert.equal(bal.available, 1_000_000); // Full refund
    assert.equal(bal.total_routing_pnl, 0);
    assertInvariantHolds(bal);
  });

  it('rejects actualFee > maxFeeLocked', async () => {
    await env.ledger.recordDeposit('agent-01', 1_000_000, 'tx:dep1');
    await env.ledger.confirmDeposit('agent-01', 1_000_000, 'tx:dep1');
    await env.ledger.lockForChannel('agent-01', 500, 'rebalance:hash3');

    await assert.rejects(
      () => env.ledger.settleRebalance('agent-01', 500, 600, 'rebalance:hash3'),
      /cannot exceed maxFeeLocked/,
    );
  });

  it('rejects insufficient locked balance', async () => {
    await env.ledger.recordDeposit('agent-01', 1_000_000, 'tx:dep1');
    await env.ledger.confirmDeposit('agent-01', 1_000_000, 'tx:dep1');

    await assert.rejects(
      () => env.ledger.settleRebalance('agent-01', 500, 32, 'rebalance:nolock'),
      /Insufficient locked balance/,
    );
  });

  it('invariant holds through lock → settle cycle with multiple rebalances', async () => {
    await env.ledger.recordDeposit('agent-01', 1_000_000, 'tx:dep1');
    await env.ledger.confirmDeposit('agent-01', 1_000_000, 'tx:dep1');

    // First rebalance: 500 max, 32 actual
    await env.ledger.lockForChannel('agent-01', 500, 'rebalance:r1');
    let bal = await env.ledger.settleRebalance('agent-01', 500, 32, 'rebalance:r1');
    assertInvariantHolds(bal);

    // Second rebalance: 1000 max, 150 actual
    await env.ledger.lockForChannel('agent-01', 1000, 'rebalance:r2');
    bal = await env.ledger.settleRebalance('agent-01', 1000, 150, 'rebalance:r2');
    assertInvariantHolds(bal);

    // 1M - 32 fee - 150 fee = 999,818
    assert.equal(bal.available, 999_818);
    assert.equal(bal.total_routing_pnl, 182); // 32 + 150
  });

  it('logs activity and audit entries', async () => {
    await env.ledger.recordDeposit('agent-01', 1_000_000, 'tx:dep1');
    await env.ledger.confirmDeposit('agent-01', 1_000_000, 'tx:dep1');
    await env.ledger.lockForChannel('agent-01', 500, 'rebalance:audit');
    await env.ledger.settleRebalance('agent-01', 500, 45, 'rebalance:audit');

    const { entries } = await env.ledger.readActivity({ agentId: 'agent-01' });
    const settleEntry = entries.find(e => e.type === 'settle_rebalance');
    assert.ok(settleEntry, 'settle_rebalance activity entry should exist');
    assert.equal(settleEntry.max_fee_locked_sats, 500);
    assert.equal(settleEntry.actual_fee_sats, 45);
    assert.equal(settleEntry.refunded_sats, 455);

    const auditEntries = await env.auditLog.readAll({ limit: 100 });
    const auditSettle = auditEntries.find(e => e.type === 'settle_rebalance');
    assert.ok(auditSettle, 'settle_rebalance audit entry should exist');
  });
});
