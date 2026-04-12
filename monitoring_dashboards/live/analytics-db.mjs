/**
 * DuckDB analytical event store for the journey dashboard.
 *
 * Ingests audit events into a local DuckDB file for fast analytical
 * queries.  The real-time SSE path stays in LiveJourneyState — this
 * layer is for aggregations only.
 */

import { Database } from 'duckdb-async';
import path from 'node:path';
import fs from 'node:fs';
import { classifyDomain } from './classify-domain.mjs';

/** Convert BigInt values in DuckDB result rows to Number for JSON serialisation. */
function deBigInt(rows) {
  return rows.map(row => {
    const out = {};
    for (const [k, v] of Object.entries(row)) {
      out[k] = typeof v === 'bigint' ? Number(v) : v;
    }
    return out;
  });
}

function parseExtra(extra) {
  if (!extra) return {};
  if (typeof extra === 'object') return extra;
  try {
    return JSON.parse(extra);
  } catch {
    return {};
  }
}

export function normalizeReadOnlySql(sql) {
  if (typeof sql !== 'string') {
    throw new Error('sql must be a string');
  }
  const trimmed = sql.trim();
  const normalized = trimmed.endsWith(';') ? trimmed.slice(0, -1).trim() : trimmed;
  if (!/^SELECT\b/i.test(normalized)) {
    throw new Error('Only SELECT queries are allowed');
  }
  if (normalized.includes(';')) {
    throw new Error('Only a single SELECT statement is allowed');
  }
  if (/\b(ALTER|ATTACH|CALL|COPY|CREATE|DELETE|DETACH|DROP|EXPORT|IMPORT|INSERT|INSTALL|LOAD|PRAGMA|RESET|SET|UPDATE)\b/i.test(normalized)) {
    throw new Error('Only read-only SELECT queries are allowed');
  }
  return normalized;
}

function decodeEventRow(row) {
  return {
    ts: typeof row.ts === 'bigint' ? Number(row.ts) : row.ts,
    _ts: typeof row.ts === 'bigint' ? Number(row.ts) : row.ts,
    event: row.event,
    method: row.method || null,
    path: row.path || null,
    status: row.status == null ? null : Number(row.status),
    duration_ms: row.duration_ms == null ? null : Number(row.duration_ms),
    agent_id: row.agent_id || null,
    ip: row.ip || null,
    domain: row.domain || null,
    doc_kind: row.doc_kind || null,
    ...parseExtra(row.extra),
  };
}

const DEFAULT_DB_PATH = path.resolve(
  import.meta.dirname || path.dirname(new URL(import.meta.url).pathname),
  '../../data/journey-analytics.duckdb',
);

// ── Schema ──────────────────────────────────────────────────────

const SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS events (
    ts          BIGINT   NOT NULL,
    event       VARCHAR  NOT NULL,
    method      VARCHAR,
    path        VARCHAR,
    status      SMALLINT,
    duration_ms INTEGER,
    agent_id    VARCHAR,
    ip          VARCHAR,
    domain      VARCHAR,
    doc_kind    VARCHAR,
    extra       JSON
  );

  CREATE INDEX IF NOT EXISTS idx_events_ts       ON events (ts);
  CREATE INDEX IF NOT EXISTS idx_events_agent    ON events (agent_id);
  CREATE INDEX IF NOT EXISTS idx_events_domain   ON events (domain);
  CREATE INDEX IF NOT EXISTS idx_events_event    ON events (event);

  CREATE TABLE IF NOT EXISTS mcp_tool_events (
    ts                    BIGINT   NOT NULL,
    session_id            VARCHAR,
    mcp_call_id           VARCHAR  NOT NULL,
    mcp_request_id        VARCHAR,
    agent_id              VARCHAR,
    ip                    VARCHAR,
    tool_name             VARCHAR  NOT NULL,
    tool_group            VARCHAR  NOT NULL,
    workflow_stage        VARCHAR  NOT NULL,
    risk_level            VARCHAR  NOT NULL,
    agent_lifecycle_stage VARCHAR,
    financial_milestone   VARCHAR,
    intent_type           VARCHAR,
    outcome_type          VARCHAR,
    status                SMALLINT,
    success               BOOLEAN,
    duration_ms           INTEGER,
    input_summary         JSON,
    saved_values          JSON,
    result_summary        JSON,
    error_code            VARCHAR,
    error_message         VARCHAR,
    capital_snapshot      JSON,
    channel_snapshot      JSON,
    revenue_snapshot      JSON,
    extra                 JSON
  );

  CREATE INDEX IF NOT EXISTS idx_mcp_tool_events_ts      ON mcp_tool_events (ts);
  CREATE INDEX IF NOT EXISTS idx_mcp_tool_events_session ON mcp_tool_events (session_id);
  CREATE INDEX IF NOT EXISTS idx_mcp_tool_events_agent   ON mcp_tool_events (agent_id);
  CREATE INDEX IF NOT EXISTS idx_mcp_tool_events_tool    ON mcp_tool_events (tool_name);
  CREATE INDEX IF NOT EXISTS idx_mcp_tool_events_stage   ON mcp_tool_events (workflow_stage);
  CREATE INDEX IF NOT EXISTS idx_mcp_tool_events_request ON mcp_tool_events (mcp_request_id);

  CREATE OR REPLACE VIEW mcp_backend_requests AS
  SELECT
    ts,
    agent_id,
    method,
    path,
    status,
    duration_ms,
    json_extract_string(extra, '$.mcp_tool_name') AS tool_name,
    json_extract_string(extra, '$.mcp_request_id') AS mcp_request_id,
    extra
  FROM events
  WHERE event = 'api_request'
    AND json_extract_string(extra, '$.mcp_request_id') IS NOT NULL;
`;

const EVENT_INDEX_SQL = `
  CREATE INDEX IF NOT EXISTS idx_events_ts       ON events (ts);
  CREATE INDEX IF NOT EXISTS idx_events_agent    ON events (agent_id);
  CREATE INDEX IF NOT EXISTS idx_events_domain   ON events (domain);
  CREATE INDEX IF NOT EXISTS idx_events_event    ON events (event);
`;

// ── Normalise raw audit event into flat row ─────────────────────

function normalizeEvent(raw) {
  const ts = raw._ts || raw.ts || Date.now();
  const event = raw.event || 'unknown';
  const method = raw.method || null;
  const p = raw.path || raw.endpoint || null;
  const status = Number.isInteger(raw.status) ? raw.status
    : Number.isInteger(raw.status_code) ? raw.status_code
      : null;
  const duration = Number.isFinite(raw.duration_ms) ? Math.round(raw.duration_ms) : null;
  const agentId = raw.agent_id || null;
  const ip = raw.ip || null;
  const domain = raw.domain || classifyDomain(p);
  const docKind = raw.doc_kind || null;

  const knownKeys = new Set([
    '_ts',
    'ts',
    'event',
    'method',
    'path',
    'endpoint',
    'status',
    'status_code',
    'duration_ms',
    'agent_id',
    'ip',
    'domain',
    'doc_kind',
  ]);
  const extra = {};
  for (const [key, value] of Object.entries(raw)) {
    if (knownKeys.has(key) || value === undefined) continue;
    extra[key] = value;
  }
  const extraJson = Object.keys(extra).length > 0 ? JSON.stringify(extra) : null;

  return [ts, event, method, p, status, duration, agentId, ip, domain, docKind, extraJson];
}

const SECRET_KEY_PATTERN = /(api[_-]?key|authorization|bearer|token|proof|seed|private|signature|signing[_-]?payload|ecash|secret|macaroon)/i;

function jsonOrNull(value) {
  if (value == null) return null;
  try {
    return JSON.stringify(redactSecrets(value));
  } catch {
    return null;
  }
}

function cleanString(value, max = 500) {
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, max) : null;
}

function redactSecrets(value, depth = 0) {
  if (value == null) return value;
  if (depth > 6) return '[truncated]';
  if (Array.isArray(value)) return value.slice(0, 50).map((item) => redactSecrets(item, depth + 1));
  if (typeof value === 'string') return cleanString(value);
  if (typeof value !== 'object') return value;

  const clean = {};
  for (const [key, item] of Object.entries(value).slice(0, 100)) {
    if (SECRET_KEY_PATTERN.test(key)) continue;
    if (item === undefined) continue;
    clean[key] = redactSecrets(item, depth + 1);
  }
  return clean;
}

function firstString(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim().slice(0, 500);
  }
  return null;
}

function deriveAgentId(raw, fallbackAgentId = null) {
  return firstString(
    raw.agent_id,
    raw.saved_values?.agent_id,
    raw.result_summary?.agent_id,
    raw.input_summary?.agent_id,
    fallbackAgentId,
  );
}

function normalizeMcpToolEvent(raw, fallbackAgentId = null) {
  const ts = raw._ts || raw.ts || Date.now();
  const status = Number.isInteger(raw.status) ? raw.status
    : Number.isInteger(raw.status_code) ? raw.status_code
      : null;
  const duration = Number.isFinite(raw.duration_ms) ? Math.round(raw.duration_ms) : null;
  const toolName = firstString(raw.tool_name, raw.mcp_tool_name, `${raw.path || ''}`.replace(/^mcp:/, ''));
  if (!toolName) return null;

  const success = typeof raw.success === 'boolean'
    ? raw.success
    : status == null
      ? null
      : status < 400;

  const knownKeys = new Set([
    '_ts',
    'ts',
    'event',
    'method',
    'path',
    'endpoint',
    'status',
    'status_code',
    'success',
    'duration_ms',
    'session_id',
    'mcp_call_id',
    'mcp_request_id',
    'agent_id',
    'ip',
    'tool_name',
    'mcp_tool_name',
    'tool_group',
    'workflow_stage',
    'risk_level',
    'agent_lifecycle_stage',
    'financial_milestone',
    'intent_type',
    'outcome_type',
    'input_summary',
    'saved_values',
    'result_summary',
    'error_code',
    'error_message',
    'capital_snapshot',
    'channel_snapshot',
    'revenue_snapshot',
  ]);
  const extra = {};
  for (const [key, value] of Object.entries(raw)) {
    if (knownKeys.has(key) || value === undefined) continue;
    extra[key] = value;
  }

  return [
    ts,
    firstString(raw.session_id),
    firstString(raw.mcp_call_id) || `${ts}:${toolName}`,
    firstString(raw.mcp_request_id),
    deriveAgentId(raw, fallbackAgentId),
    firstString(raw.ip),
    toolName,
    firstString(raw.tool_group) || 'uncategorized',
    firstString(raw.workflow_stage) || 'unknown',
    firstString(raw.risk_level) || 'unknown',
    firstString(raw.agent_lifecycle_stage),
    success === false ? null : firstString(raw.financial_milestone),
    firstString(raw.intent_type),
    success === false ? 'failed' : firstString(raw.outcome_type),
    status,
    success,
    duration,
    jsonOrNull(raw.input_summary),
    jsonOrNull(raw.saved_values),
    jsonOrNull(raw.result_summary),
    firstString(raw.error_code),
    cleanString(firstString(raw.error_message, raw.message, raw.error), 500),
    jsonOrNull(raw.capital_snapshot),
    jsonOrNull(raw.channel_snapshot),
    jsonOrNull(raw.revenue_snapshot),
    Object.keys(extra).length > 0 ? jsonOrNull(extra) : null,
  ];
}

function extractMcpAgentBinding(raw) {
  const mcpRequestId = firstString(raw.mcp_request_id);
  const agentId = firstString(raw.agent_id);
  if (!mcpRequestId || !agentId) return null;
  return { mcpRequestId, agentId };
}

function extractMcpSessionAgentBinding(raw, fallbackAgentId = null) {
  const sessionId = firstString(raw.session_id);
  const agentId = deriveAgentId(raw, fallbackAgentId);
  if (!sessionId || !agentId) return null;
  return { sessionId, agentId };
}

function decodeMcpToolRow(row) {
  return {
    ts: typeof row.ts === 'bigint' ? Number(row.ts) : row.ts,
    _ts: typeof row.ts === 'bigint' ? Number(row.ts) : row.ts,
    event: 'mcp_tool_call',
    method: 'MCP',
    path: `mcp:${row.tool_name}`,
    session_id: row.session_id || null,
    mcp_call_id: row.mcp_call_id || null,
    mcp_request_id: row.mcp_request_id || null,
    agent_id: row.agent_id || null,
    ip: row.ip || null,
    mcp_tool_name: row.tool_name,
    tool_name: row.tool_name,
    tool_group: row.tool_group,
    workflow_stage: row.workflow_stage,
    risk_level: row.risk_level,
    agent_lifecycle_stage: row.agent_lifecycle_stage || null,
    financial_milestone: row.financial_milestone || null,
    intent_type: row.intent_type || null,
    outcome_type: row.outcome_type || null,
    status: row.status == null ? null : Number(row.status),
    success: row.success == null ? null : Boolean(row.success),
    duration_ms: row.duration_ms == null ? null : Number(row.duration_ms),
    input_summary: parseExtra(row.input_summary),
    saved_values: parseExtra(row.saved_values),
    result_summary: parseExtra(row.result_summary),
    error_code: row.error_code || null,
    error_message: row.error_message || null,
    capital_snapshot: parseExtra(row.capital_snapshot),
    channel_snapshot: parseExtra(row.channel_snapshot),
    revenue_snapshot: parseExtra(row.revenue_snapshot),
    extra: parseExtra(row.extra),
  };
}

// ── AnalyticsDB class ───────────────────────────────────────────

export class AnalyticsDB {
  constructor(dbPath) {
    this.dbPath = dbPath || DEFAULT_DB_PATH;
    this.db = null;
    this._insertStmt = null;
    this._batch = [];
    this._mcpBatch = [];
    this._mcpAgentBindings = new Map();
    this._mcpAgentBindingBatch = [];
    this._mcpSessionAgentBindings = new Map();
    this._mcpSessionAgentBindingBatch = [];
    this._flushTimer = null;
    this._flushPromise = null;
    this._flushMs = 500;
    this._maxBatch = 1000;
  }

  async open() {
    // Ensure data directory exists
    const dir = path.dirname(this.dbPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    this.db = await Database.create(this.dbPath);
    await this.db.exec(SCHEMA_SQL);
    await this._runMigrations();
    return this;
  }

  async _runMigrations() {
    if (!this.db) return;
    try {
      const rows = await this.db.all(`PRAGMA table_info('events')`);
      const durationRow = Array.isArray(rows)
        ? rows.find((row) => `${row?.name || ''}`.toLowerCase() === 'duration_ms')
        : null;
      const durationType = `${durationRow?.type || ''}`.toUpperCase();
      if (durationRow && durationType === 'SMALLINT') {
        await this.db.exec('DROP VIEW IF EXISTS mcp_backend_requests');
        await this.db.exec('DROP TABLE IF EXISTS events__duration_migration');
        await this.db.exec(`
          CREATE TABLE events__duration_migration AS
          SELECT
            ts,
            event,
            method,
            path,
            status,
            CAST(duration_ms AS INTEGER) AS duration_ms,
            agent_id,
            ip,
            domain,
            doc_kind,
            extra
          FROM events
        `);
        await this.db.exec('DROP TABLE events');
        await this.db.exec('ALTER TABLE events__duration_migration RENAME TO events');
        await this.db.exec(EVENT_INDEX_SQL);
        await this.db.exec(SCHEMA_SQL);
      }
    } catch (error) {
      console.warn(`[AnalyticsDB] Schema migration skipped: ${error.message}`);
    }
  }

  async close() {
    this._flushSync();
    if (this.db) {
      await this._flushBatch();
      await this.db.close();
      this.db = null;
    }
  }

  // ── Ingest ──

  ingest(rawEvent) {
    if (!this.db) return;
    const binding = extractMcpAgentBinding(rawEvent);
    if (binding) {
      this._mcpAgentBindings.set(binding.mcpRequestId, binding.agentId);
      this._mcpAgentBindingBatch.push(binding);
    }
    const sessionBinding = extractMcpSessionAgentBinding(rawEvent, binding?.agentId || null);
    if (sessionBinding) {
      this._mcpSessionAgentBindings.set(sessionBinding.sessionId, sessionBinding.agentId);
      this._mcpSessionAgentBindingBatch.push(sessionBinding);
    }

    if (rawEvent?.event === 'mcp_tool_call') {
      const mcpRow = normalizeMcpToolEvent(
        rawEvent,
        (rawEvent?.mcp_request_id ? this._mcpAgentBindings.get(rawEvent.mcp_request_id) : null)
          || (rawEvent?.session_id ? this._mcpSessionAgentBindings.get(rawEvent.session_id) : null),
      );
      if (mcpRow) this._mcpBatch.push(mcpRow);
    } else {
      this._batch.push(normalizeEvent(rawEvent));
    }

    if ((this._batch.length + this._mcpBatch.length + this._mcpAgentBindingBatch.length + this._mcpSessionAgentBindingBatch.length) >= this._maxBatch) {
      void this._flushBatch().catch((error) => {
        console.warn(`[AnalyticsDB] Batch flush failed: ${error.message}`);
      });
    } else if (!this._flushTimer) {
      this._flushTimer = setTimeout(() => {
        this._flushTimer = null;
        void this._flushBatch().catch((error) => {
          console.warn(`[AnalyticsDB] Timed flush failed: ${error.message}`);
        });
      }, this._flushMs);
      this._flushTimer.unref?.();
    }
  }

  async _flushBatch() {
    if (this._flushPromise) return this._flushPromise;
    if (!this.db || (
      this._batch.length === 0
      && this._mcpBatch.length === 0
      && this._mcpAgentBindingBatch.length === 0
      && this._mcpSessionAgentBindingBatch.length === 0
    )) return;
    const rows = this._batch.splice(0);
    const mcpRows = this._mcpBatch.splice(0);
    const mcpBindings = this._mcpAgentBindingBatch.splice(0);
    const mcpSessionBindings = this._mcpSessionAgentBindingBatch.splice(0);
    if (this._flushTimer) { clearTimeout(this._flushTimer); this._flushTimer = null; }
    this._flushPromise = (async () => {
      try {
        let pending = rows;
        let pendingMcp = mcpRows;
        let pendingBindings = mcpBindings;
        let pendingSessionBindings = mcpSessionBindings;
        while (this.db && (
          pending.length > 0
          || pendingMcp.length > 0
          || pendingBindings.length > 0
          || pendingSessionBindings.length > 0
        )) {
          if (pending.length > 0) {
            const chunk = pending.splice(0, this._maxBatch);
            await this._insertRows(chunk);
          }
          if (pendingMcp.length > 0) {
            const chunk = pendingMcp.splice(0, this._maxBatch);
            await this._insertMcpToolRows(chunk);
          }
          if (pendingBindings.length > 0) {
            const chunk = pendingBindings.splice(0, this._maxBatch);
            await this._applyMcpAgentBindings(chunk);
          }
          if (pendingSessionBindings.length > 0) {
            const chunk = pendingSessionBindings.splice(0, this._maxBatch);
            await this._applyMcpSessionAgentBindings(chunk);
          }
          if (pending.length === 0 && this._batch.length > 0) {
            pending = this._batch.splice(0);
          }
          if (pendingMcp.length === 0 && this._mcpBatch.length > 0) {
            pendingMcp = this._mcpBatch.splice(0);
          }
          if (pendingBindings.length === 0 && this._mcpAgentBindingBatch.length > 0) {
            pendingBindings = this._mcpAgentBindingBatch.splice(0);
          }
          if (pendingSessionBindings.length === 0 && this._mcpSessionAgentBindingBatch.length > 0) {
            pendingSessionBindings = this._mcpSessionAgentBindingBatch.splice(0);
          }
        }
      } finally {
        this._flushPromise = null;
        if (this.db && (
          this._batch.length > 0
          || this._mcpBatch.length > 0
          || this._mcpAgentBindingBatch.length > 0
          || this._mcpSessionAgentBindingBatch.length > 0
        )) {
          await this._flushBatch();
        }
      }
    })();
    return this._flushPromise;
  }

  _flushSync() {
    if (this._flushTimer) { clearTimeout(this._flushTimer); this._flushTimer = null; }
  }

  async _insertRows(rows) {
    if (rows.length === 0) return;
    const placeholders = rows.map(() => '(?,?,?,?,?,?,?,?,?,?,?)').join(',');
    const params = rows.flat();
    await this.db.run(
      `INSERT INTO events (ts, event, method, path, status, duration_ms, agent_id, ip, domain, doc_kind, extra)
       VALUES ${placeholders}`,
      ...params,
    );
  }

  async _insertMcpToolRows(rows) {
    if (rows.length === 0) return;
    const placeholders = rows.map(() => '(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').join(',');
    const params = rows.flat();
    await this.db.run(
      `INSERT INTO mcp_tool_events (
        ts,
        session_id,
        mcp_call_id,
        mcp_request_id,
        agent_id,
        ip,
        tool_name,
        tool_group,
        workflow_stage,
        risk_level,
        agent_lifecycle_stage,
        financial_milestone,
        intent_type,
        outcome_type,
        status,
        success,
        duration_ms,
        input_summary,
        saved_values,
        result_summary,
        error_code,
        error_message,
        capital_snapshot,
        channel_snapshot,
        revenue_snapshot,
        extra
      ) VALUES ${placeholders}`,
      ...params,
    );
  }

  async _applyMcpAgentBindings(bindings) {
    if (bindings.length === 0) return;
    for (const binding of bindings) {
      await this.db.run(
        `UPDATE mcp_tool_events
         SET agent_id = COALESCE(agent_id, ?)
         WHERE mcp_request_id = ?
           AND agent_id IS NULL`,
        binding.agentId,
        binding.mcpRequestId,
      );
    }
  }

  async _applyMcpSessionAgentBindings(bindings) {
    if (bindings.length === 0) return;
    for (const binding of bindings) {
      await this.db.run(
        `UPDATE mcp_tool_events
         SET agent_id = COALESCE(agent_id, ?)
         WHERE session_id = ?
           AND agent_id IS NULL`,
        binding.agentId,
        binding.sessionId,
      );
    }
  }

  /** Check if DuckDB needs initial data import (empty table). */
  async needsImport() {
    if (!this.db) return false;
    const [{ cnt }] = await this.db.all('SELECT COUNT(*) as cnt FROM events');
    return cnt === 0 || cnt === 0n;
  }

  /** Force-flush any pending batched events to DuckDB. */
  async flush() {
    return this._flushBatch();
  }

  // ── Analytical queries ──

  /** Event counts bucketed by time interval */
  async eventsByInterval({ intervalMinutes = 60, since, until, domain, agentId } = {}) {
    const where = ['event = ?'];
    const params = [];
    params.push('api_request');
    if (since) { where.push('ts >= ?'); params.push(since); }
    if (until) { where.push('ts <= ?'); params.push(until); }
    if (domain) { where.push('domain = ?'); params.push(domain); }
    if (agentId) { where.push('agent_id = ?'); params.push(agentId); }
    const whereClause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
    const intervalMs = Math.max(1, Math.floor(intervalMinutes * 60 * 1000));

    return deBigInt(await this.db.all(`
      SELECT
        (ts / ${intervalMs})::BIGINT * ${intervalMs} AS bucket,
        COUNT(*)                              AS count,
        COUNT(DISTINCT agent_id)              AS unique_agents,
        AVG(duration_ms)                      AS avg_duration_ms,
        SUM(CASE WHEN status >= 200 AND status < 300 THEN 1 ELSE 0 END) AS ok,
        SUM(CASE WHEN status >= 400 AND status < 500 THEN 1 ELSE 0 END) AS client_err,
        SUM(CASE WHEN status >= 500 THEN 1 ELSE 0 END)                  AS server_err
      FROM events
      ${whereClause}
      GROUP BY bucket
      ORDER BY bucket
    `, ...params));
  }

  /** Top routes by request count */
  async topRoutes({ limit = 20, since, domain } = {}) {
    const where = ['event = ?', 'method IS NOT NULL', 'path IS NOT NULL'];
    const params = [];
    params.push('api_request');
    if (since) { where.push('ts >= ?'); params.push(since); }
    if (domain) { where.push('domain = ?'); params.push(domain); }

    return deBigInt(await this.db.all(`
      SELECT
        method,
        path,
        domain,
        COUNT(*)             AS hits,
        AVG(duration_ms)     AS avg_ms,
        MAX(duration_ms)     AS max_ms,
        SUM(CASE WHEN status >= 400 THEN 1 ELSE 0 END) AS errors
      FROM events
      WHERE ${where.join(' AND ')}
      GROUP BY method, path, domain
      ORDER BY hits DESC
      LIMIT ?
    `, ...params, limit));
  }

  /** Per-agent activity summary */
  async agentActivity({ limit = 50, since } = {}) {
    const where = ['event = ?', 'agent_id IS NOT NULL'];
    const params = [];
    params.push('api_request');
    if (since) { where.push('ts >= ?'); params.push(since); }

    return deBigInt(await this.db.all(`
      SELECT
        agent_id,
        COUNT(*)                  AS requests,
        COUNT(DISTINCT domain)    AS domains_visited,
        COUNT(DISTINCT path)      AS unique_routes,
        MIN(ts)                   AS first_seen,
        MAX(ts)                   AS last_seen,
        AVG(duration_ms)          AS avg_ms,
        SUM(CASE WHEN status >= 400 THEN 1 ELSE 0 END) AS errors
      FROM events
      WHERE ${where.join(' AND ')}
      GROUP BY agent_id
      ORDER BY requests DESC
      LIMIT ?
    `, ...params, limit));
  }

  /** Domain breakdown */
  async domainBreakdown({ since } = {}) {
    const where = ['event = ?', 'domain IS NOT NULL'];
    const params = [];
    params.push('api_request');
    if (since) { where.push('ts >= ?'); params.push(since); }

    return deBigInt(await this.db.all(`
      SELECT
        domain,
        COUNT(*)                  AS requests,
        COUNT(DISTINCT agent_id)  AS unique_agents,
        COUNT(DISTINCT path)      AS unique_routes,
        AVG(duration_ms)          AS avg_ms,
        SUM(CASE WHEN status >= 200 AND status < 300 THEN 1 ELSE 0 END) AS ok,
        SUM(CASE WHEN status >= 400 THEN 1 ELSE 0 END) AS errors
      FROM events
      WHERE ${where.join(' AND ')}
      GROUP BY domain
      ORDER BY requests DESC
    `, ...params));
  }

  /** Error breakdown */
  async errorBreakdown({ since, limit = 20 } = {}) {
    const where = ['event = ?', 'status >= 400'];
    const params = [];
    params.push('api_request');
    if (since) { where.push('ts >= ?'); params.push(since); }

    return deBigInt(await this.db.all(`
      SELECT
        event,
        method,
        path,
        status,
        domain,
        COUNT(*) AS count
      FROM events
      WHERE ${where.join(' AND ')}
      GROUP BY event, method, path, status, domain
      ORDER BY count DESC
      LIMIT ?
    `, ...params, limit));
  }

  /** Agent journey — ordered route sequence for one agent */
  async agentJourney(agentId) {
    return deBigInt(await this.db.all(`
      SELECT ts, event, method, path, status, duration_ms, domain
      FROM events
      WHERE event = 'api_request' AND agent_id = ?
      ORDER BY ts
    `, agentId));
  }

  async eventSchema() {
    const columns = deBigInt(await this.db.all(`PRAGMA table_info('events')`));
    const mcpColumns = deBigInt(await this.db.all(`PRAGMA table_info('mcp_tool_events')`));
    const shape = (tableColumns) => tableColumns.map((column) => ({
      name: column.name,
      type: column.type,
      nullable: column.notnull === 0,
      default: column.dflt_value ?? null,
      primary_key: column.pk === 1,
    }));
    return {
      table: 'events',
      columns: shape(columns),
      tables: {
        events: shape(columns),
        mcp_tool_events: shape(mcpColumns),
      },
    };
  }

  async latestEvents({ limit = 100 } = {}) {
    return this.listEvents({
      limit: Math.min(Math.max(Number(limit) || 100, 1), 500),
      order: 'DESC',
    });
  }

  async mcpToolActivity({ limit = 100, since, agentId } = {}) {
    const where = [];
    const params = [];
    if (since) {
      where.push('ts >= ?');
      params.push(since);
    }
    if (agentId) {
      where.push('agent_id = ?');
      params.push(agentId);
    }
    const whereClause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
    params.push(Math.min(Math.max(Number(limit) || 100, 1), 500));

    const rows = await this.db.all(`
      SELECT *
      FROM mcp_tool_events
      ${whereClause}
      ORDER BY ts DESC
      LIMIT ?
    `, ...params);

    return rows.map(decodeMcpToolRow);
  }

  async mcpActivity(options = {}) {
    return this.mcpToolActivity(options);
  }

  async listMcpToolEvents({
    since,
    until,
    agentId,
    limit,
    order = 'ASC',
  } = {}) {
    const where = [];
    const params = [];
    if (since) { where.push('ts >= ?'); params.push(since); }
    if (until) { where.push('ts <= ?'); params.push(until); }
    if (agentId) { where.push('agent_id = ?'); params.push(agentId); }
    const whereClause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
    const normalizedOrder = `${order}`.toUpperCase() === 'DESC' ? 'DESC' : 'ASC';
    const limitClause = Number.isFinite(limit) && limit > 0 ? ' LIMIT ?' : '';
    if (limitClause) params.push(limit);

    const rows = await this.db.all(`
      SELECT *
      FROM mcp_tool_events
      ${whereClause}
      ORDER BY ts ${normalizedOrder}${limitClause}
    `, ...params);

    return rows.map(decodeMcpToolRow);
  }

  async mcpAgentJourney(agentId) {
    const rows = await this.db.all(`
      SELECT *
      FROM mcp_tool_events
      WHERE agent_id = ?
      ORDER BY ts ASC
    `, agentId);
    return rows.map(decodeMcpToolRow);
  }

  async mcpBackendRequests({ mcpRequestId, agentId, limit = 100 } = {}) {
    const where = [];
    const params = [];
    if (mcpRequestId) {
      where.push('mcp_request_id = ?');
      params.push(mcpRequestId);
    }
    if (agentId) {
      where.push('agent_id = ?');
      params.push(agentId);
    }
    const whereClause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
    params.push(Math.min(Math.max(Number(limit) || 100, 1), 500));
    return deBigInt(await this.db.all(`
      SELECT *
      FROM mcp_backend_requests
      ${whereClause}
      ORDER BY ts DESC
      LIMIT ?
    `, ...params));
  }

  async mcpAgentSummary({ limit = 50, since } = {}) {
    const where = ['agent_id IS NOT NULL'];
    const params = [];
    if (since) {
      where.push('ts >= ?');
      params.push(since);
    }
    params.push(Math.min(Math.max(Number(limit) || 50, 1), 500));
    return deBigInt(await this.db.all(`
      WITH ranked AS (
        SELECT
          *,
          ROW_NUMBER() OVER (PARTITION BY agent_id ORDER BY ts DESC) AS last_rank,
          ROW_NUMBER() OVER (
            PARTITION BY agent_id
            ORDER BY CASE WHEN success = false OR status >= 400 THEN ts ELSE NULL END DESC NULLS LAST
          ) AS error_rank,
          CASE financial_milestone
            WHEN 'registered' THEN 1
            WHEN 'funding_started' THEN 2
            WHEN 'wallet_funded' THEN 3
            WHEN 'funding_checked' THEN 3
            WHEN 'channel_prepared' THEN 4
            WHEN 'channel_funding_started' THEN 4
            WHEN 'channel_executed' THEN 5
            WHEN 'revenue_configured' THEN 6
            WHEN 'revenue_monitored' THEN 7
            WHEN 'performance_monitored' THEN 7
            ELSE 0
          END AS milestone_rank
        FROM mcp_tool_events
        WHERE ${where.join(' AND ')}
      )
      SELECT
        agent_id,
        MIN(ts) AS first_seen,
        MAX(ts) AS last_seen,
        COUNT(*) AS tool_calls,
        COUNT(DISTINCT session_id) AS sessions,
        COUNT(DISTINCT tool_name) AS unique_tools,
        SUM(CASE WHEN success THEN 1 ELSE 0 END) AS successful_calls,
        SUM(CASE WHEN success = false OR status >= 400 THEN 1 ELSE 0 END) AS failed_calls,
        MAX(CASE WHEN last_rank = 1 THEN tool_name END) AS last_tool,
        MAX(CASE WHEN last_rank = 1 THEN workflow_stage END) AS last_workflow_stage,
        MAX(CASE WHEN last_rank = 1 THEN agent_lifecycle_stage END) AS last_lifecycle_stage,
        MAX(milestone_rank) AS highest_financial_milestone_rank,
        CASE MAX(milestone_rank)
          WHEN 1 THEN 'registered'
          WHEN 2 THEN 'funding_started'
          WHEN 3 THEN 'funded'
          WHEN 4 THEN 'channel_prepared'
          WHEN 5 THEN 'channel_executed'
          WHEN 6 THEN 'revenue_configured'
          WHEN 7 THEN 'revenue_or_performance_monitored'
          ELSE NULL
        END AS highest_financial_milestone,
        MAX(CASE WHEN error_rank = 1 THEN error_code END) AS last_error_code,
        MAX(CASE WHEN error_rank = 1 THEN error_message END) AS last_error_message
      FROM ranked
      GROUP BY agent_id
      ORDER BY last_seen DESC
      LIMIT ?
    `, ...params));
  }

  async mcpToolBreakdown({ since } = {}) {
    const where = [];
    const params = [];
    if (since) {
      where.push('ts >= ?');
      params.push(since);
    }
    const whereClause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
    return deBigInt(await this.db.all(`
      SELECT
        tool_name,
        tool_group,
        workflow_stage,
        risk_level,
        COUNT(*) AS calls,
        COUNT(DISTINCT agent_id) AS agents,
        AVG(duration_ms) AS avg_duration_ms,
        SUM(CASE WHEN success = false OR status >= 400 THEN 1 ELSE 0 END) AS failures
      FROM mcp_tool_events
      ${whereClause}
      GROUP BY tool_name, tool_group, workflow_stage, risk_level
      ORDER BY calls DESC
    `, ...params));
  }

  async mcpLifecycleFunnel({ since } = {}) {
    const where = ['agent_id IS NOT NULL'];
    const params = [];
    if (since) {
      where.push('ts >= ?');
      params.push(since);
    }
    return deBigInt(await this.db.all(`
      SELECT
        workflow_stage,
        MIN(ts) AS first_seen,
        COUNT(*) AS tool_calls,
        COUNT(DISTINCT agent_id) AS agents
      FROM mcp_tool_events
      WHERE ${where.join(' AND ')}
      GROUP BY workflow_stage
      ORDER BY CASE workflow_stage
        WHEN 'discovery' THEN 1
        WHEN 'identity' THEN 2
        WHEN 'funding' THEN 3
        WHEN 'market_research' THEN 4
        WHEN 'channel_action' THEN 5
        WHEN 'revenue_monitoring' THEN 6
        WHEN 'coordination' THEN 7
        ELSE 99
      END
    `, ...params));
  }

  async mcpStageDropoffs({ since } = {}) {
    const where = ['agent_id IS NOT NULL'];
    const params = [];
    if (since) {
      where.push('ts >= ?');
      params.push(since);
    }
    return deBigInt(await this.db.all(`
      WITH last_stage AS (
        SELECT
          agent_id,
          workflow_stage,
          tool_name,
          status,
          success,
          error_code,
          error_message,
          ROW_NUMBER() OVER (PARTITION BY agent_id ORDER BY ts DESC) AS rn
        FROM mcp_tool_events
        WHERE ${where.join(' AND ')}
      )
      SELECT
        workflow_stage,
        COUNT(*) AS agents_stopped_here,
        SUM(CASE WHEN success = false OR status >= 400 THEN 1 ELSE 0 END) AS stopped_on_failure,
        COUNT(DISTINCT tool_name) AS distinct_last_tools,
        MAX(error_code) AS sample_error_code,
        MAX(error_message) AS sample_error_message
      FROM last_stage
      WHERE rn = 1
      GROUP BY workflow_stage
      ORDER BY agents_stopped_here DESC
    `, ...params));
  }

  async mcpRetentionSignals({ since } = {}) {
    const where = ['agent_id IS NOT NULL'];
    const params = [];
    if (since) {
      where.push('ts >= ?');
      params.push(since);
    }
    return deBigInt(await this.db.all(`
      SELECT
        agent_id,
        MIN(ts) AS first_seen,
        MAX(ts) AS last_seen,
        COUNT(*) AS tool_calls,
        COUNT(DISTINCT session_id) AS sessions,
        COUNT(DISTINCT CAST(to_timestamp(ts / 1000) AS DATE)) AS active_days,
        COUNT(DISTINCT workflow_stage) AS workflow_stages,
        SUM(CASE WHEN workflow_stage IN ('channel_action', 'revenue_monitoring', 'liquidity_operations') THEN 1 ELSE 0 END) AS deep_financial_calls
      FROM mcp_tool_events
      WHERE ${where.join(' AND ')}
      GROUP BY agent_id
      ORDER BY last_seen DESC
    `, ...params));
  }

  async mcpFinancialMilestones({ since } = {}) {
    const where = ['agent_id IS NOT NULL', 'financial_milestone IS NOT NULL'];
    const params = [];
    if (since) {
      where.push('ts >= ?');
      params.push(since);
    }
    return deBigInt(await this.db.all(`
      SELECT
        financial_milestone,
        MIN(ts) AS first_seen,
        MAX(ts) AS last_seen,
        COUNT(*) AS events,
        COUNT(DISTINCT agent_id) AS agents
      FROM mcp_tool_events
      WHERE ${where.join(' AND ')}
      GROUP BY financial_milestone
      ORDER BY CASE financial_milestone
        WHEN 'registered' THEN 1
        WHEN 'funding_started' THEN 2
        WHEN 'wallet_funded' THEN 3
        WHEN 'funding_checked' THEN 4
        WHEN 'channel_prepared' THEN 5
        WHEN 'channel_funding_started' THEN 6
        WHEN 'channel_executed' THEN 7
        WHEN 'revenue_configured' THEN 8
        WHEN 'revenue_monitored' THEN 9
        WHEN 'performance_monitored' THEN 10
        ELSE 99
      END
    `, ...params));
  }

  /** Raw stored events for rebuilding live state or custom audit views. */
  async listEvents({
    since,
    until,
    agentId,
    eventTypes,
    limit,
    order = 'ASC',
  } = {}) {
    const where = [];
    const params = [];
    if (since) { where.push('ts >= ?'); params.push(since); }
    if (until) { where.push('ts <= ?'); params.push(until); }
    if (agentId) { where.push('agent_id = ?'); params.push(agentId); }
    if (Array.isArray(eventTypes) && eventTypes.length > 0) {
      where.push(`event IN (${eventTypes.map(() => '?').join(',')})`);
      params.push(...eventTypes);
    }
    const whereClause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
    const normalizedOrder = `${order}`.toUpperCase() === 'DESC' ? 'DESC' : 'ASC';
    const limitClause = Number.isFinite(limit) && limit > 0 ? ' LIMIT ?' : '';
    if (limitClause) params.push(limit);

    const rows = await this.db.all(`
      SELECT ts, event, method, path, status, duration_ms, agent_id, ip, domain, doc_kind, extra
      FROM events
      ${whereClause}
      ORDER BY ts ${normalizedOrder}${limitClause}
    `, ...params);

    return rows.map(decodeEventRow);
  }

  /** Summary stats */
  async summary() {
    const rows = deBigInt(await this.db.all(`
      WITH combined AS (
        SELECT ts, agent_id, path, domain, duration_ms FROM events
        UNION ALL
        SELECT ts, agent_id, ('mcp:' || tool_name) AS path, 'mcp' AS domain, duration_ms FROM mcp_tool_events
      )
      SELECT
        COUNT(*)                  AS total_events,
        COUNT(DISTINCT agent_id)  AS unique_agents,
        COUNT(DISTINCT path)      AS unique_routes,
        COUNT(DISTINCT domain)    AS domains,
        MIN(ts)                   AS first_event,
        MAX(ts)                   AS last_event,
        AVG(duration_ms)          AS avg_duration_ms
      FROM combined
    `));
    return rows[0];
  }

  /** Raw SQL for custom queries from the dashboard */
  async query(sql, params = []) {
    return deBigInt(await this.db.all(normalizeReadOnlySql(sql), ...params));
  }
}
