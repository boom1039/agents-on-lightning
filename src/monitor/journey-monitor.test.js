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

const LEGACY_SECRET_FIELD = ['api', 'key'].join('_');

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
      path: '/api/v1/mcp-docs',
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
      tool_group: 'discovery',
      workflow_stage: 'discovery',
      risk_level: 'read_only',
      agent_lifecycle_stage: 'discovered',
      intent_type: 'read_context',
      outcome_type: 'platform_context',
      saved_values: {
        agent_id: 'agent-mcp',
        [LEGACY_SECRET_FIELD]: 'secret-key',
      },
      input_summary: {
        secret_input_present: true,
      },
      ts: Date.now(),
    });
    await recordJourneyEvent({
      event: 'api_request',
      method: 'GET',
      path: '/api/v1/',
      status: 200,
      agent_id: 'agent-mcp',
      mcp_tool_name: 'aol_get_api_root',
      mcp_request_id: 'request-1',
      ts: Date.now(),
    });
    await monitor.analyticsDb.flush();

    const schema = await monitor.eventSchema();
    assert(schema.columns.some((column) => column.name === 'extra'));
    assert(schema.tables.mcp_tool_events.some((column) => column.name === 'tool_name'));

    const latest = await monitor.latestEvents({ limit: 2 });
    assert.equal(latest.length, 1);

    const mcpActivity = await monitor.mcpActivity({ limit: 10 });
    assert.equal(mcpActivity.length, 1);
    assert.equal(mcpActivity[0].mcp_tool_name, 'aol_get_api_root');
    assert.equal(mcpActivity[0].agent_id, 'agent-mcp');
    assert.equal(mcpActivity[0].tool_group, 'discovery');
    assert.equal(mcpActivity[0].saved_values.agent_id, 'agent-mcp');
    assert.equal(mcpActivity[0].saved_values[LEGACY_SECRET_FIELD], undefined);
    assert.equal(JSON.stringify(mcpActivity[0]).includes(LEGACY_SECRET_FIELD), false);
    assert.equal(JSON.stringify(mcpActivity[0]).includes('secret-key'), false);

    const backend = await monitor.mcpBackendRequests({ mcpRequestId: 'request-1' });
    assert.equal(backend.length, 1);
    assert.equal(backend[0].agent_id, 'agent-mcp');

    const queryRows = await monitor.query('SELECT COUNT(*) AS count FROM mcp_tool_events;');
    assert.equal(queryRows[0].count, 1);
    await assert.rejects(
      () => monitor.query('SELECT COUNT(*) FROM mcp_tool_events; DROP TABLE mcp_tool_events'),
      /single SELECT/,
    );
  } finally {
    await stopJourneyMonitor();
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('Journey monitor answers MCP lifecycle, milestone, and agent summary queries', async () => {
  const tempDir = await mkdtemp(join(tmpdir(), 'aol-journey-'));
  try {
    const monitor = await startJourneyMonitor({
      dbPath: join(tempDir, 'journey.duckdb'),
      idleShutdownMs: 50,
    });
    const now = Date.now();

    for (const [index, event] of [
      {
        mcp_tool_name: 'aol_get_llms',
        tool_group: 'discovery',
        workflow_stage: 'discovery',
        risk_level: 'read_only',
        agent_lifecycle_stage: 'discovered',
        intent_type: 'read_context',
        outcome_type: 'read_operating_manual',
      },
      {
        mcp_tool_name: 'aol_register_agent',
        tool_group: 'identity',
        workflow_stage: 'identity',
        risk_level: 'private_state',
        agent_lifecycle_stage: 'registered',
        financial_milestone: 'registered',
        intent_type: 'manage_identity',
        outcome_type: 'registered',
        saved_values: { agent_id: 'agent-life', [LEGACY_SECRET_FIELD]: 'secret' },
      },
      {
        mcp_tool_name: 'aol_preview_open_channel',
        tool_group: 'signed-channel-work',
        workflow_stage: 'channel_action',
        risk_level: 'safety_sensitive',
        agent_lifecycle_stage: 'channel_ready',
        financial_milestone: 'channel_prepared',
        intent_type: 'prepare_or_execute_channel',
        outcome_type: 'open_previewed',
        input_summary: { agent_id: 'agent-life', channel_id: 'chan-1' },
      },
      {
        mcp_tool_name: 'aol_send_message',
        tool_group: 'social',
        workflow_stage: 'coordination',
        risk_level: 'coordination',
        agent_lifecycle_stage: 'coordinating',
        intent_type: 'coordinate_agents',
        outcome_type: 'message_sent',
        input_summary: { agent_id: 'agent-life' },
      },
    ].entries()) {
      await recordJourneyEvent({
        event: 'mcp_tool_call',
        method: 'MCP',
        path: `mcp:${event.mcp_tool_name}`,
        status: 200,
        success: true,
        mcp_call_id: `call-${index}`,
        mcp_request_id: `request-${index}`,
        session_id: 'session-life',
        duration_ms: 10 + index,
        ts: now + index,
        ...event,
      });
    }
    await monitor.analyticsDb.flush();

    const summary = await monitor.mcpAgentSummary({ limit: 10 });
    assert.equal(summary.length, 1);
    assert.equal(summary[0].agent_id, 'agent-life');
    assert.equal(summary[0].tool_calls, 4);
    assert.equal(summary[0].last_tool, 'aol_send_message');
    assert.equal(summary[0].highest_financial_milestone, 'channel_prepared');

    const journey = await monitor.mcpAgentJourney('agent-life');
    assert.deepEqual(journey.map((event) => event.mcp_tool_name), [
      'aol_get_llms',
      'aol_register_agent',
      'aol_preview_open_channel',
      'aol_send_message',
    ]);

    const funnel = await monitor.mcpLifecycleFunnel({});
    assert(funnel.some((row) => row.workflow_stage === 'discovery'));
    assert(funnel.some((row) => row.workflow_stage === 'identity'));
    assert(funnel.some((row) => row.workflow_stage === 'channel_action'));

    const milestones = await monitor.mcpFinancialMilestones({});
    assert(milestones.some((row) => row.financial_milestone === 'registered'));
    assert(milestones.some((row) => row.financial_milestone === 'channel_prepared'));

    const retention = await monitor.mcpRetentionSignals({});
    assert.equal(retention[0].agent_id, 'agent-life');
    assert.equal(retention[0].sessions, 1);
  } finally {
    await stopJourneyMonitor();
    await rm(tempDir, { recursive: true, force: true });
  }
});
