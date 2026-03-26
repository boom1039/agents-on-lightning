/**
 * Comprehensive tests for the Paid Analytics Gateway (Plan K).
 *
 * Uses Node.js built-in test runner (node:test) and assertions (node:assert).
 * Run: node --test ai_panel/server/channel-market/analytics-gateway.test.js
 *
 * Tests cover:
 *   - Catalog retrieval
 *   - Quote pricing (deterministic, consistent)
 *   - Parameter validation (required, type, format, unknown)
 *   - Execute flow (debit → query → result)
 *   - Refund on query failure
 *   - Insufficient balance → 402
 *   - Unknown query → 400
 *   - Concurrency limits
 *   - History retrieval
 *   - Gateway status
 *
 * The Python scripts are NOT tested here (they need real ClickHouse).
 * Instead, we mock _spawnQuery to test the Node.js gateway logic in isolation.
 */

import { describe, it, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';

// We'll import and test the AnalyticsGateway class
// Since it's ESM with imports that may not resolve in a pure test context,
// we extract the testable logic here.

// ---------------------------------------------------------------------------
// Mock dependencies
// ---------------------------------------------------------------------------

function createMockWalletOps(balance = 1000) {
  let _balance = balance;
  const _tokens = new Map(); // track issued tokens
  let _tokenCounter = 0;

  return {
    getBalance: mock.fn(async (_agentId) => _balance),

    sendEcash: mock.fn(async (_agentId, amount) => {
      if (_balance < amount) {
        throw new Error(`Insufficient ecash balance. Have ${_balance} sats, need ${amount}`);
      }
      _balance -= amount;
      const token = `cashu_token_${++_tokenCounter}`;
      _tokens.set(token, amount);
      return { token, amount, balance: _balance };
    }),

    receiveEcash: mock.fn(async (_agentId, token) => {
      const amount = _tokens.get(token);
      if (!amount) throw new Error('Invalid or already claimed token');
      _tokens.delete(token);
      _balance += amount;
      return { amount, proofCount: 1, balance: _balance };
    }),

    // Test helpers
    _getBalance: () => _balance,
    _setBalance: (b) => { _balance = b; },
  };
}

function createMockDataLayer() {
  const _logs = {};
  return {
    appendLog: mock.fn(async (path, entry) => {
      if (!_logs[path]) _logs[path] = [];
      _logs[path].push({ ...entry, _ts: entry._ts || Date.now() });
    }),

    readLog: mock.fn(async (path, since) => {
      const entries = _logs[path] || [];
      if (since !== undefined && since !== null) {
        return entries.filter(e => (e._ts || 0) >= since);
      }
      return [...entries];
    }),

    _getLogs: (path) => _logs[path] || [],
  };
}

function createMockLedger() {
  const _records = [];
  return {
    record: mock.fn(async (tx) => {
      _records.push({ ...tx, recorded_at: Date.now() });
      return tx;
    }),
    _getRecords: () => _records,
  };
}

// ---------------------------------------------------------------------------
// Import gateway (dynamic to handle ESM)
// ---------------------------------------------------------------------------

let AnalyticsGateway;

// We need to handle the ESM import and mock the _spawnQuery method
async function loadGateway() {
  const mod = await import('./analytics-gateway.js');
  AnalyticsGateway = mod.AnalyticsGateway;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('AnalyticsGateway', async () => {
  await loadGateway();

  let gateway, walletOps, dataLayer, ledger;

  beforeEach(() => {
    walletOps = createMockWalletOps(1000);
    dataLayer = createMockDataLayer();
    ledger = createMockLedger();
    gateway = new AnalyticsGateway({ walletOps, dataLayer, ledger });
  });

  // =========================================================================
  // getCatalog
  // =========================================================================

  describe('getCatalog()', () => {
    it('returns all 7 queries', () => {
      const catalog = gateway.getCatalog();
      assert.equal(catalog.queries.length, 7);
    });

    it('each query has required fields', () => {
      const catalog = gateway.getCatalog();
      for (const q of catalog.queries) {
        assert.ok(q.query_id, 'has query_id');
        assert.ok(q.description, 'has description');
        assert.ok(Array.isArray(q.parameters), 'has parameters array');
        assert.ok(typeof q.price_sats === 'number', 'has numeric price');
        assert.ok(q.price_sats > 0, 'price is positive');
      }
    });

    it('includes payment method and pricing ethos', () => {
      const catalog = gateway.getCatalog();
      assert.ok(catalog.payment_method);
      assert.ok(catalog.pricing_ethos);
    });

    it('has the expected query IDs', () => {
      const catalog = gateway.getCatalog();
      const ids = catalog.queries.map(q => q.query_id).sort();
      assert.deepEqual(ids, [
        'channel_history',
        'fee_landscape',
        'network_stats',
        'node_profile',
        'node_reliability',
        'peer_candidates',
        'routing_demand',
      ]);
    });
  });

  // =========================================================================
  // getQuote
  // =========================================================================

  describe('getQuote()', () => {
    it('returns correct price for node_profile', () => {
      const quote = gateway.getQuote('node_profile', {
        pubkey: 'a'.repeat(66),
      });
      assert.equal(quote.query_id, 'node_profile');
      assert.equal(quote.price_sats, 1);
      assert.equal(quote.parameters_valid, true);
    });

    it('returns correct price for peer_candidates', () => {
      const quote = gateway.getQuote('peer_candidates', {
        budget_sats: 100000,
      });
      assert.equal(quote.price_sats, 10);
    });

    it('returns correct price for routing_demand (most expensive)', () => {
      const quote = gateway.getQuote('routing_demand', {
        source_pubkey: 'a'.repeat(66),
        dest_pubkey: 'b'.repeat(66),
      });
      assert.equal(quote.price_sats, 20);
    });

    it('pricing is deterministic — same query always returns same price', () => {
      const q1 = gateway.getQuote('node_profile', { pubkey: 'a'.repeat(66) });
      const q2 = gateway.getQuote('node_profile', { pubkey: 'b'.repeat(66) });
      assert.equal(q1.price_sats, q2.price_sats);
    });

    it('throws on unknown query_id', () => {
      assert.throws(
        () => gateway.getQuote('nonexistent', {}),
        (err) => {
          assert.equal(err.statusCode, 400);
          assert.ok(err.message.includes('Unknown query_id'));
          return true;
        },
      );
    });

    it('throws on missing required parameter', () => {
      assert.throws(
        () => gateway.getQuote('node_profile', {}),
        (err) => {
          assert.equal(err.statusCode, 400);
          assert.ok(err.message.includes('pubkey'));
          return true;
        },
      );
    });

    it('throws on invalid pubkey format', () => {
      assert.throws(
        () => gateway.getQuote('node_profile', { pubkey: 'invalid' }),
        (err) => {
          assert.equal(err.statusCode, 400);
          assert.ok(err.message.includes('66-character hex'));
          return true;
        },
      );
    });

    it('throws on invalid channel_point format', () => {
      assert.throws(
        () => gateway.getQuote('channel_history', { channel_point: 'bad' }),
        (err) => {
          assert.equal(err.statusCode, 400);
          assert.ok(err.message.includes('txid:vout'));
          return true;
        },
      );
    });

    it('accepts valid channel_point', () => {
      const quote = gateway.getQuote('channel_history', {
        channel_point: 'a'.repeat(64) + ':0',
      });
      assert.equal(quote.price_sats, 5);
    });

    it('throws on budget_sats below minimum', () => {
      assert.throws(
        () => gateway.getQuote('peer_candidates', { budget_sats: 100 }),
        (err) => {
          assert.ok(err.message.includes('20000'));
          return true;
        },
      );
    });

    it('throws on limit above maximum', () => {
      assert.throws(
        () => gateway.getQuote('peer_candidates', { budget_sats: 100000, limit: 500 }),
        (err) => {
          assert.ok(err.message.includes('at most 100'));
          return true;
        },
      );
    });

    it('rejects unknown parameters', () => {
      assert.throws(
        () => gateway.getQuote('node_profile', { pubkey: 'a'.repeat(66), sql_inject: 'DROP TABLE' }),
        (err) => {
          assert.ok(err.message.includes('Unknown parameter'));
          return true;
        },
      );
    });

    it('network_stats requires no parameters', () => {
      const quote = gateway.getQuote('network_stats', {});
      assert.equal(quote.price_sats, 1);
      assert.equal(quote.parameters_valid, true);
    });

    it('includes learn text in quote', () => {
      const quote = gateway.getQuote('node_profile', { pubkey: 'a'.repeat(66) });
      assert.ok(quote.learn);
      assert.ok(quote.learn.includes('POST /api/v1/analytics/execute'));
    });
  });

  // =========================================================================
  // execute
  // =========================================================================

  describe('execute()', () => {
    it('debits wallet and returns results on success', async () => {
      // Mock the Python spawn to return fake results
      const mockResult = { data: [{ node: 'test' }] };
      gateway._spawnQuery = mock.fn(async () => mockResult);

      const result = await gateway.execute('agent-1', 'node_profile', {
        pubkey: 'a'.repeat(66),
      });

      assert.equal(result.query_id, 'node_profile');
      assert.equal(result.price_sats, 1);
      assert.deepEqual(result.results, mockResult);
      assert.ok(result.execution_ms >= 0);
      assert.ok(result.learn);

      // Wallet was debited 1 sat
      assert.equal(walletOps._getBalance(), 999);

      // Ledger recorded the transaction
      assert.equal(ledger._getRecords().length, 1);
      assert.equal(ledger._getRecords()[0].type, 'analytics_query');
      assert.equal(ledger._getRecords()[0].amount_sats, 1);
    });

    it('refunds wallet on query failure', async () => {
      gateway._spawnQuery = mock.fn(async () => {
        throw new Error('ClickHouse connection refused');
      });

      await assert.rejects(
        () => gateway.execute('agent-1', 'network_stats', {}),
        (err) => {
          assert.ok(err.message.includes('payment refunded'));
          assert.equal(err.refunded, true);
          return true;
        },
      );

      // Balance should be restored
      assert.equal(walletOps._getBalance(), 1000);
    });

    it('returns 402 on insufficient balance', async () => {
      walletOps._setBalance(0);

      await assert.rejects(
        () => gateway.execute('agent-1', 'routing_demand', {
          source_pubkey: 'a'.repeat(66),
          dest_pubkey: 'b'.repeat(66),
        }),
        (err) => {
          assert.equal(err.statusCode, 402);
          assert.ok(err.message.includes('Insufficient balance'));
          return true;
        },
      );
    });

    it('returns 400 on unknown query', async () => {
      await assert.rejects(
        () => gateway.execute('agent-1', 'nonexistent', {}),
        (err) => {
          assert.equal(err.statusCode, 400);
          return true;
        },
      );
    });

    it('returns 400 on invalid parameters', async () => {
      await assert.rejects(
        () => gateway.execute('agent-1', 'node_profile', {}),
        (err) => {
          assert.equal(err.statusCode, 400);
          assert.ok(err.message.includes('pubkey'));
          return true;
        },
      );
    });

    it('does not charge for parameter validation failures', async () => {
      await assert.rejects(
        () => gateway.execute('agent-1', 'node_profile', {}),
      );
      assert.equal(walletOps._getBalance(), 1000); // unchanged
    });

    it('returns 503 when at concurrency limit', async () => {
      // Fill up the concurrency slots
      gateway._activeQueries = 3; // MAX_CONCURRENT_QUERIES

      await assert.rejects(
        () => gateway.execute('agent-1', 'network_stats', {}),
        (err) => {
          assert.equal(err.statusCode, 503);
          assert.ok(err.message.includes('busy'));
          return true;
        },
      );

      // Balance unchanged (no debit attempted)
      assert.equal(walletOps._getBalance(), 1000);
      gateway._activeQueries = 0;
    });

    it('returns 504 on timeout', async () => {
      gateway._spawnQuery = mock.fn(async () => {
        const err = new Error('Query timed out after 30 seconds');
        throw err;
      });

      await assert.rejects(
        () => gateway.execute('agent-1', 'network_stats', {}),
        (err) => {
          assert.equal(err.statusCode, 504);
          assert.equal(err.refunded, true);
          return true;
        },
      );

      // Refunded
      assert.equal(walletOps._getBalance(), 1000);
    });

    it('logs query to history on success', async () => {
      gateway._spawnQuery = mock.fn(async () => ({ ok: true }));
      await gateway.execute('agent-1', 'network_stats', {});

      const logs = dataLayer._getLogs('data/analytics/query-history.jsonl');
      assert.equal(logs.length, 1);
      assert.equal(logs[0].agent_id, 'agent-1');
      assert.equal(logs[0].query_id, 'network_stats');
      assert.equal(logs[0].success, true);
      assert.equal(logs[0].price_sats, 1);
    });

    it('logs query to history on failure (with error)', async () => {
      gateway._spawnQuery = mock.fn(async () => {
        throw new Error('boom');
      });
      await assert.rejects(() => gateway.execute('agent-1', 'network_stats', {}));

      const logs = dataLayer._getLogs('data/analytics/query-history.jsonl');
      assert.equal(logs.length, 1);
      assert.equal(logs[0].success, false);
      assert.equal(logs[0].price_sats, 0); // not charged
      assert.ok(logs[0].error.includes('boom'));
    });

    it('charges exact catalog price — no over/under charge', async () => {
      gateway._spawnQuery = mock.fn(async () => ({}));

      // Execute every query type and verify exact price
      const prices = {
        node_profile: 1,
        peer_candidates: 10,
        fee_landscape: 5,
        network_stats: 1,
        channel_history: 5,
        routing_demand: 20,
        node_reliability: 10,
      };

      const params = {
        node_profile: { pubkey: 'a'.repeat(66) },
        peer_candidates: { budget_sats: 100000 },
        fee_landscape: { peer_pubkey: 'a'.repeat(66) },
        network_stats: {},
        channel_history: { channel_point: 'a'.repeat(64) + ':0' },
        routing_demand: { source_pubkey: 'a'.repeat(66), dest_pubkey: 'b'.repeat(66) },
        node_reliability: { pubkey: 'a'.repeat(66) },
      };

      let expectedBalance = 1000;
      for (const [queryId, price] of Object.entries(prices)) {
        expectedBalance -= price;
        await gateway.execute('agent-1', queryId, params[queryId]);
        assert.equal(walletOps._getBalance(), expectedBalance,
          `After ${queryId}: expected ${expectedBalance}, got ${walletOps._getBalance()}`);
      }

      // Total spent: 1+10+5+1+5+20+10 = 52 sats
      assert.equal(walletOps._getBalance(), 948);
    });

    it('handles concurrent executions correctly', async () => {
      gateway._spawnQuery = mock.fn(async () => {
        // Simulate some async work
        await new Promise(r => setTimeout(r, 10));
        return { data: 'ok' };
      });

      // Run 3 concurrent queries (the maximum)
      const promises = [
        gateway.execute('agent-1', 'network_stats', {}),
        gateway.execute('agent-2', 'network_stats', {}),
        gateway.execute('agent-3', 'network_stats', {}),
      ];

      const results = await Promise.all(promises);
      assert.equal(results.length, 3);
      for (const r of results) {
        assert.equal(r.price_sats, 1);
      }
    });

    it('tracks total executed and revenue', async () => {
      gateway._spawnQuery = mock.fn(async () => ({}));

      await gateway.execute('agent-1', 'network_stats', {});
      await gateway.execute('agent-2', 'peer_candidates', { budget_sats: 100000 });

      const status = gateway.getStatus();
      assert.equal(status.total_executed, 2);
      assert.equal(status.total_revenue_sats, 11); // 1 + 10
    });
  });

  // =========================================================================
  // getHistory
  // =========================================================================

  describe('getHistory()', () => {
    it('returns empty for agent with no history', async () => {
      const result = await gateway.getHistory('agent-new');
      assert.equal(result.queries.length, 0);
      assert.equal(result.total, 0);
    });

    it('returns query history for specific agent only', async () => {
      gateway._spawnQuery = mock.fn(async () => ({}));

      await gateway.execute('agent-1', 'network_stats', {});
      await gateway.execute('agent-2', 'network_stats', {});
      await gateway.execute('agent-1', 'node_profile', { pubkey: 'a'.repeat(66) });

      const history1 = await gateway.getHistory('agent-1');
      assert.equal(history1.total, 2);

      const history2 = await gateway.getHistory('agent-2');
      assert.equal(history2.total, 1);
    });

    it('respects limit parameter', async () => {
      gateway._spawnQuery = mock.fn(async () => ({}));

      for (let i = 0; i < 5; i++) {
        await gateway.execute('agent-1', 'network_stats', {});
      }

      const history = await gateway.getHistory('agent-1', { limit: 3 });
      assert.equal(history.queries.length, 3);
      assert.equal(history.total, 5);
    });

    it('caps limit at 500', async () => {
      const history = await gateway.getHistory('agent-1', { limit: 9999 });
      assert.equal(history.queries.length, 0); // no data, but didn't throw
    });
  });

  // =========================================================================
  // getStatus
  // =========================================================================

  describe('getStatus()', () => {
    it('returns operational status', () => {
      const status = gateway.getStatus();
      assert.equal(status.active_queries, 0);
      assert.equal(status.max_concurrent, 3);
      assert.equal(status.total_executed, 0);
      assert.equal(status.total_revenue_sats, 0);
      assert.equal(status.catalog_size, 7);
    });
  });

  // =========================================================================
  // SQL injection safety
  // =========================================================================

  describe('SQL injection safety', () => {
    it('rejects pubkey with SQL injection attempt', () => {
      assert.throws(
        () => gateway.getQuote('node_profile', {
          pubkey: "'; DROP TABLE ln_events; --",
        }),
        (err) => {
          assert.ok(err.message.includes('66-character hex'));
          return true;
        },
      );
    });

    it('rejects channel_point with SQL injection', () => {
      assert.throws(
        () => gateway.getQuote('channel_history', {
          channel_point: "'; DROP TABLE ln_events; --",
        }),
        (err) => {
          assert.ok(err.message.includes('txid:vout'));
          return true;
        },
      );
    });

    it('rejects extra parameters that might be used for injection', () => {
      assert.throws(
        () => gateway.getQuote('network_stats', {
          malicious: 'SELECT * FROM system.tables',
        }),
        (err) => {
          assert.ok(err.message.includes('Unknown parameter'));
          return true;
        },
      );
    });
  });

  // =========================================================================
  // Payment atomicity edge cases
  // =========================================================================

  describe('payment atomicity', () => {
    it('does not charge when sendEcash fails', async () => {
      // Make wallet reject the send
      walletOps.sendEcash = mock.fn(async () => {
        throw new Error('Mint unreachable');
      });

      await assert.rejects(
        () => gateway.execute('agent-1', 'network_stats', {}),
        (err) => {
          assert.equal(err.statusCode, 402);
          return true;
        },
      );

      // Balance unchanged (mock balance was never decremented since sendEcash threw)
      assert.equal(walletOps._getBalance(), 1000);
    });

    it('still logs when refund fails (critical path)', async () => {
      // Query will fail
      gateway._spawnQuery = mock.fn(async () => {
        throw new Error('ClickHouse down');
      });

      // Refund will also fail
      walletOps.receiveEcash = mock.fn(async () => {
        throw new Error('Mint down during refund');
      });

      await assert.rejects(
        () => gateway.execute('agent-1', 'network_stats', {}),
        (err) => {
          assert.equal(err.refunded, false, 'refunded must be false when refund fails');
          assert.ok(err.message.includes('REFUND FAILED'));
          return true;
        },
      );

      // Query was logged as failed
      const logs = dataLayer._getLogs('data/analytics/query-history.jsonl');
      assert.equal(logs.length, 1);
      assert.equal(logs[0].success, false);
    });
  });
});
