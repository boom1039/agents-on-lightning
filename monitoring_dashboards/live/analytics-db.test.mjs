import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { AnalyticsDB } from './analytics-db.mjs';

const TEST_DB = path.resolve(import.meta.dirname, '../../data/test-analytics.duckdb');

describe('AnalyticsDB', () => {
  let db;

  before(async () => {
    if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
    db = new AnalyticsDB(TEST_DB);
    await db.open();
  });

  after(async () => {
    await db.close();
    if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
  });

  it('ingests and queries events', async () => {
    const now = Date.now();
    const events = [
      { event: 'api_request', method: 'GET', path: '/api/v1/strategies', status: 200, duration_ms: 5, agent_id: 'agent-1', ip: '127.0.0.1', _ts: now - 60000 },
      { event: 'api_request', method: 'POST', path: '/api/v1/agents/register', status: 201, duration_ms: 12, agent_id: 'agent-1', ip: '127.0.0.1', _ts: now - 50000 },
      { event: 'api_request', method: 'GET', path: '/api/v1/wallet/balance', status: 200, duration_ms: 3, agent_id: 'agent-2', ip: '127.0.0.1', _ts: now - 40000 },
      { event: 'validation_failure', path: '/api/v1/agents/register', _ts: now - 30000 },
      { event: 'api_request', method: 'GET', path: '/api/v1/market/overview', status: 404, duration_ms: 1, agent_id: 'agent-1', ip: '127.0.0.1', _ts: now - 20000 },
    ];

    for (const evt of events) db.ingest(evt);
    await db._flushBatch();

    const summary = await db.summary();
    assert.equal(Number(summary.total_events), 5);
    assert.equal(Number(summary.unique_agents), 2);

    const domains = await db.domainBreakdown();
    assert.ok(domains.length > 0);
    const disc = domains.find(d => d.domain === 'discovery');
    assert.ok(disc, 'should have discovery domain');
    assert.equal(Number(disc.requests), 1);

    const topRoutes = await db.topRoutes({ limit: 5 });
    assert.ok(topRoutes.length > 0);

    const agents = await db.agentActivity();
    assert.equal(agents.length, 2);
    assert.equal(agents[0].agent_id, 'agent-1');
    assert.equal(Number(agents[0].requests), 3);

    const journey = await db.agentJourney('agent-1');
    assert.equal(journey.length, 3);
    assert.ok(journey[0].ts <= journey[1].ts, 'should be ordered by time');

    const errors = await db.errorBreakdown();
    assert.equal(errors.length, 1);
    assert.equal(errors[0].status, 404);

    const timeseries = await db.eventsByInterval({ intervalMinutes: 1 });
    assert.ok(timeseries.length > 0);
  });

  it('rejects non-SELECT queries', async () => {
    await assert.rejects(
      () => db.query('DROP TABLE events'),
      /Only SELECT queries/,
    );
  });

  it('allows custom SELECT queries', async () => {
    const rows = await db.query('SELECT COUNT(*) as cnt FROM events');
    assert.ok(rows[0].cnt >= 0);
  });
});
