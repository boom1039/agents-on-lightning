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
    duration_ms SMALLINT,
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
  const domain = classifyDomain(p);
  const docKind = raw.doc_kind || null;

  // Stash less-common fields in extra JSON
  const extra = {};
  if (raw.field) extra.field = raw.field;
  if (raw.value_snippet) extra.value_snippet = raw.value_snippet;
  if (raw.success !== undefined) extra.success = raw.success;
  if (raw.resource_id) extra.resource_id = raw.resource_id;
  if (raw.route) extra.route = raw.route;
  if (raw.reason) extra.reason = raw.reason;
  if (raw.operation) extra.operation = raw.operation;
  if (raw.amount_sats !== undefined) extra.amount_sats = raw.amount_sats;
  if (raw.trace_id) extra.trace_id = raw.trace_id;
  const extraJson = Object.keys(extra).length > 0 ? JSON.stringify(extra) : null;

  return [ts, event, method, p, status, duration, agentId, ip, domain, docKind, extraJson];
}

// ── AnalyticsDB class ───────────────────────────────────────────

export class AnalyticsDB {
  constructor(dbPath) {
    this.dbPath = dbPath || DEFAULT_DB_PATH;
    this.db = null;
    this._insertStmt = null;
    this._batch = [];
    this._flushTimer = null;
    this._flushMs = 500;
    this._maxBatch = 200;
  }

  async open() {
    // Ensure data directory exists
    const dir = path.dirname(this.dbPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    this.db = await Database.create(this.dbPath);
    await this.db.exec(SCHEMA_SQL);
    return this;
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
    this._batch.push(normalizeEvent(rawEvent));
    if (this._batch.length >= this._maxBatch) {
      this._flushBatch();
    } else if (!this._flushTimer) {
      this._flushTimer = setTimeout(() => {
        this._flushTimer = null;
        this._flushBatch();
      }, this._flushMs);
      this._flushTimer.unref?.();
    }
  }

  async _flushBatch() {
    if (!this.db || this._batch.length === 0) return;
    const rows = this._batch.splice(0);
    if (this._flushTimer) { clearTimeout(this._flushTimer); this._flushTimer = null; }
    await this._insertRows(rows);
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
    const where = [];
    const params = [];
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
    const where = ['method IS NOT NULL', 'path IS NOT NULL'];
    const params = [];
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
    const where = ['agent_id IS NOT NULL'];
    const params = [];
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
    const where = ['domain IS NOT NULL'];
    const params = [];
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
    const where = ['status >= 400'];
    const params = [];
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
      WHERE agent_id = ?
      ORDER BY ts
    `, agentId));
  }

  /** Summary stats */
  async summary() {
    const rows = deBigInt(await this.db.all(`
      SELECT
        COUNT(*)                  AS total_events,
        COUNT(DISTINCT agent_id)  AS unique_agents,
        COUNT(DISTINCT path)      AS unique_routes,
        COUNT(DISTINCT domain)    AS domains,
        MIN(ts)                   AS first_event,
        MAX(ts)                   AS last_event,
        AVG(duration_ms)          AS avg_duration_ms
      FROM events
    `));
    return rows[0];
  }

  /** Raw SQL for custom queries from the dashboard */
  async query(sql, params = []) {
    // Safety: only allow SELECT
    const trimmed = sql.trim().toUpperCase();
    if (!trimmed.startsWith('SELECT')) {
      throw new Error('Only SELECT queries are allowed');
    }
    return deBigInt(await this.db.all(sql, ...params));
  }
}
