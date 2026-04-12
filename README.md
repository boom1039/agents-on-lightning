# Agents on Lightning

This repo runs one Node app.
That same app serves the hosted MCP interface, internal agent API routes, `/llms.txt`, MCP docs, `/journey/`, and `/journey/three`.

## Source Of Truth

- Live routes: `src/index.js` and `src/routes/*.js`
- Route metadata: `// @agent-route { ... }` comments in those route files
- Route comment schema: `docs/agent-route-schema.md`
- Agent docs: `docs/llms.txt` and `docs/mcp/*.txt`
- Manifest builder: `src/monitor/agent-surface-inventory.js`
- Journey APIs: `src/routes/journey-routes.js`
- Journey state and DuckDB read/write: `src/monitor/journey-monitor.js` and `monitoring_dashboards/live/analytics-db.mjs`
- Journey UI: `monitoring_dashboards/journey/index.html` and `monitoring_dashboards/journey/three.html`
- Local journey database: `data/journey-analytics.duckdb`
- Production journey database: `/var/lib/agents-on-lightning/data/journey-analytics.duckdb`
- Production deploy source of truth: `deploy/README.md`
- NPM dependency lock: `package.json` and `package-lock.json`

## Simple Rules

- External agents use `/mcp`; `/api/v1/*` routes are internal implementation routes in production.
- Legacy skill docs stay in the repo but are not the public agent interface.
- If the dashboard looks wrong, fix the route files or MCP docs first.
- The manifest is generated from route comments plus agent docs.
- The dashboards read the manifest. They are not the source of truth.
- DuckDB stores agent interaction history. It is not the source of route definitions.
- Production deploys use one command: `npm run prod:deploy`.
- Production runtime is the release behind `/opt/agents_on_lightning/current`, deployed from a runtime tarball.
- Do not deploy production with `git pull`, `rsync`, manual `scp`, or on-box `npm ci`.
- Old notes, graph helpers, and test harness files are kept out of this repo.
- Real node hosts, cert paths, and server-local config stay out of git.

## Not Source Of Truth

- `.claude/` is local tool state
- `plans/` contains historical research and implementation plans, not current deploy instructions

## If You Need To Change Agent Surfaces

1. Edit the real route in `src/index.js` or `src/routes/*.js`
2. Update its `@agent-route` comment
3. Update the matching file in `docs/llms.txt` or `docs/mcp/*.txt`
4. Restart the app
5. Check `/api/journey/manifest`, `/journey/`, and `/journey/three`
