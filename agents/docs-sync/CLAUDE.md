# Docs Sync Agent

Detects when `docs/llms.txt` drifts from the actual route handlers. Flags mismatches so they can be fixed before an agent hits a dead endpoint or misses a new one.

## Job

- Parse `docs/llms.txt` to extract every documented endpoint (method + path)
- Scan `src/routes/*.js` to extract every registered route
- Compare the two lists: find undocumented routes, phantom docs, method mismatches
- Scan `src/identity/agent-friendly-errors.js` for `see:` and `hint:` values referencing endpoints, verify those endpoints exist in code
- Report results to stdout; exit 0 if clean, exit 1 if issues found

## Run

```bash
node agents/docs-sync/check.mjs
```

## Files this agent owns

- `agents/docs-sync/` -- all files in this directory

## Files this agent reads (never modifies)

- `docs/llms.txt` -- root API menu served to agents
- `docs/skills/*.txt` -- skill files with per-domain endpoint documentation
- `src/routes/*.js` -- the 9+ route files defining all endpoints
- `src/identity/agent-friendly-errors.js` -- error helpers with `see`/`hint` endpoint references

## Files this agent can write

- `docs/` -- to fix doc drift when instructed
- `agents/docs-sync/reports/` -- sync check reports

## Boundaries

- Never modifies route handlers or any file under `src/`
- Never changes application logic
- Only reads source files to compare against documentation
