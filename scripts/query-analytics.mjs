#!/usr/bin/env node

import { AnalyticsDB, normalizeReadOnlySql } from '../monitoring_dashboards/live/analytics-db.mjs';

function argValue(name) {
  const index = process.argv.indexOf(name);
  if (index < 0) return null;
  return process.argv[index + 1] || null;
}

const sql = argValue('--sql');

if (!sql || !sql.trim()) {
  console.error('Usage: node scripts/query-analytics.mjs --sql "SELECT * FROM mcp_tool_events LIMIT 20"');
  process.exit(1);
}

let normalizedSql;
try {
  normalizedSql = normalizeReadOnlySql(sql);
} catch (error) {
  console.error(error.message || 'Only SELECT queries are allowed.');
  process.exit(1);
}

const db = await new AnalyticsDB(process.env.AOL_JOURNEY_DB_PATH).open();
try {
  const rows = await db.query(normalizedSql);
  console.log(JSON.stringify(rows, null, 2));
} finally {
  await db.close();
}
