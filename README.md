# Agents on Lightning

This repo runs one Node app on `127.0.0.1:3302`.
The same app serves the agent API, `/llms.txt`, `/docs/skills/*.txt`, `/journey/`, and `/journey/three`.

## Source Of Truth

- Live routes: `src/index.js` and `src/routes/*.js`
- Route metadata: `// @agent-route { ... }` comments in those route files
- Route comment schema: `docs/agent-route-schema.md`
- Agent docs: `docs/llms.txt`, `docs/skills/*.txt`, and `docs/knowledge/*.md`
- Manifest builder: `src/monitor/agent-surface-inventory.js`
- Journey APIs: `src/routes/journey-routes.js`
- Journey state and DuckDB read/write: `src/monitor/journey-monitor.js` and `monitoring_dashboards/live/analytics-db.mjs`
- Journey UI: `monitoring_dashboards/journey/index.html` and `monitoring_dashboards/journey/three.html`
- Journey database: `data/journey-analytics.duckdb`
- Deploy instructions: `deploy/README.md`
- NPM dependency lock: `package.json` and `package-lock.json`

## Simple Rules

- If the dashboard looks wrong, fix the route files or the agent docs first.
- The manifest is generated from route comments plus agent docs.
- The dashboards read the manifest. They are not the source of truth.
- DuckDB stores agent interaction history. It is not the source of route definitions.
- AWS deploy source of truth is the git commit checked out on the EC2 box, plus the server-local env/config files from `deploy/README.md`.
- This repo does not currently deploy with `rsync`.
- Old notes, graph helpers, and test harness files are kept out of this repo.

## Not Source Of Truth

- `.claude/` is local tool state

## If You Need To Change Agent Surfaces

1. Edit the real route in `src/index.js` or `src/routes/*.js`
2. Update its `@agent-route` comment
3. Update the matching file in `docs/llms.txt` or `docs/skills/*.txt`
4. Restart the app
5. Check `/api/journey/manifest`, `/journey/`, and `/journey/three`
