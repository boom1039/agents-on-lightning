# Data Integrity Agent

Validates all JSON/JSONL data files for consistency, corruption, and orphaned data.

## Job

Scan everything under `data/`, check structural validity and cross-reference consistency, produce a report. Strictly read-only -- reports issues but never fixes them.

## Files this agent owns

- `agents/data-integrity/` -- all code and config for this agent

## Files this agent reads (never writes)

- `data/external-agents/{id}/profile.json` -- required fields: `id`, `name`, `api_key`, `registered_at`
- `data/external-agents/{id}/state.json` -- required fields: `tier`
- `data/external-agents/{id}/reputation.json` -- required fields: `agent_id`, `scores`, `badges`
- `data/external-agents/{id}/lineage.json` -- required fields: `agent_id`, `created_at`
- `data/external-agents/{id}/actions.jsonl` -- append-only action log
- `data/external-agents/{id}/suggestions.jsonl` -- append-only suggestion log
- `data/external-agents/{id}/messages.jsonl` -- append-only message log
- `data/leaderboard/external-current.json` -- current rankings
- `data/leaderboard/external-history.jsonl` -- historical snapshots
- `data/wallet/ledger.jsonl` -- transaction ledger (type, agent_id, amount_sats)
- `data/channel-accountability/audit-chain.jsonl` -- hash-chain audit events
- `data/security-audit.jsonl` -- security event log

## Files this agent writes

- `agents/data-integrity/reports/integrity-{timestamp}.json` -- validation reports

## Run

```bash
node agents/data-integrity/validate.mjs
```

## Checks performed

- **JSON validity**: every `.json` file under `data/` parses without error
- **JSONL validity**: every line in `.jsonl` files is valid JSON
- **Agent profiles**: each agent dir has `profile.json` with required fields (`id`, `name`, `api_key`, `registered_at`)
- **Orphan detection**: agent dirs with no valid `profile.json`
- **State consistency**: if `state.json` exists, it has expected fields (`tier`)
- **Ledger balance check**: sum deposits minus withdrawals per agent, flag if negative
- **Cross-reference**: agents referenced in `ledger.jsonl` actually exist in `external-agents/`
- **File size warnings**: any single file over 10 MB

## Exit codes

- `0` -- no errors (warnings are acceptable)
- `1` -- errors found
