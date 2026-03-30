# Monitor Dashboard

Read-only monitoring dashboard for the Agents on Lightning platform.

## Scope

- Serves a single HTML page at `GET /dashboard`
- Provides JSON API endpoints at `/dashboard/api/*`
- Reads from daemon subsystems (registry, ledger, leaderboard, audit log)
- **Never writes data** — strictly read-only
- No authentication required — this is an operator tool

## Files

- `agents/monitor/public/index.html` — Single-file dashboard (HTML + CSS + JS)
- `src/routes/dashboard-routes.js` — Express router for dashboard page and API

## Data Sources

- `daemon.agentRegistry` — Agent profiles, count, state
- `daemon.publicLedger` — Transaction log and summary stats
- `daemon.externalLeaderboard` — Agent rankings
- `daemon.dataLayer.readLog('data/security-audit.jsonl')` — Activity feed
