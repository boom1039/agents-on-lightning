import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Database } from 'duckdb-async';

import {
  getJourneyMonitor,
  listStoredJourneyEvents,
  recordJourneyEvent,
  startJourneyMonitor,
  stopJourneyMonitor,
} from './journey-monitor.js';

test('Journey monitor keeps DuckDB ingest on while live runtime stays lazy and idles down', async () => {
  const tempDir = await mkdtemp(join(tmpdir(), 'aol-journey-'));
  try {
    const monitor = await startJourneyMonitor({
      dbPath: join(tempDir, 'journey.duckdb'),
      idleShutdownMs: 50,
    });

    assert.equal(monitor.liveRuntimeReady, false);

    await recordJourneyEvent({
      event: 'request_start',
      path: '/api/v1/skills',
      method: 'GET',
      ts: Date.now(),
      agent_id: 'agent-1',
    });
    await monitor.analyticsDb.flush();

    const stored = await listStoredJourneyEvents({ limit: 10, order: 'DESC' });
    assert.equal(stored.length, 1);
    assert.equal(monitor.liveRuntimeReady, false);

    await monitor.buildSnapshot();
    assert.equal(monitor.liveRuntimeReady, true);

    monitor.noteJourneyAccess();
    await new Promise((resolve) => setTimeout(resolve, 120));
    assert.equal(getJourneyMonitor().liveRuntimeReady, false);
  } finally {
    await stopJourneyMonitor();
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('Journey monitor persists long request durations without DuckDB overflow', async () => {
  const tempDir = await mkdtemp(join(tmpdir(), 'aol-journey-'));
  try {
    const dbPath = join(tempDir, 'journey.duckdb');
    const db = await Database.create(dbPath);
    await db.exec(`
      CREATE TABLE IF NOT EXISTS events (
        ts BIGINT NOT NULL,
        event VARCHAR NOT NULL,
        method VARCHAR,
        path VARCHAR,
        status SMALLINT,
        duration_ms SMALLINT,
        agent_id VARCHAR,
        ip VARCHAR,
        domain VARCHAR,
        doc_kind VARCHAR,
        extra JSON
      );
    `);
    await db.close();

    const monitor = await startJourneyMonitor({
      dbPath,
      idleShutdownMs: 50,
    });

    await recordJourneyEvent({
      event: 'api_request',
      path: '/api/v1/node/test-connection',
      method: 'POST',
      status: 400,
      duration_ms: 123568,
      ts: Date.now(),
      agent_id: 'agent-long',
    });
    await monitor.analyticsDb.flush();

    const stored = await listStoredJourneyEvents({ limit: 10, order: 'DESC' });
    assert.equal(stored.length, 1);
    assert.equal(stored[0].duration_ms, 123568);
  } finally {
    await stopJourneyMonitor();
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('Journey monitor exposes safe schema, latest event, and MCP activity views', async () => {
  const tempDir = await mkdtemp(join(tmpdir(), 'aol-journey-'));
  try {
    const monitor = await startJourneyMonitor({
      dbPath: join(tempDir, 'journey.duckdb'),
      idleShutdownMs: 50,
    });

    await recordJourneyEvent({
      event: 'mcp_tool_call',
      method: 'MCP',
      path: 'mcp:aol_get_api_root',
      status: 200,
      mcp_tool_name: 'aol_get_api_root',
      mcp_request_id: 'request-1',
      ts: Date.now(),
    });
    await recordJourneyEvent({
      event: 'api_request',
      method: 'GET',
      path: '/api/v1/',
      status: 200,
      mcp_tool_name: 'aol_get_api_root',
      mcp_request_id: 'request-1',
      ts: Date.now(),
    });
    await monitor.analyticsDb.flush();

    const schema = await monitor.eventSchema();
    assert(schema.columns.some((column) => column.name === 'extra'));

    const latest = await monitor.latestEvents({ limit: 2 });
    assert.equal(latest.length, 2);

    const mcpActivity = await monitor.mcpActivity({ limit: 10 });
    assert.equal(mcpActivity.length, 2);
    assert(mcpActivity.every((event) => event.mcp_tool_name === 'aol_get_api_root'));
  } finally {
    await stopJourneyMonitor();
    await rm(tempDir, { recursive: true, force: true });
  }
});
