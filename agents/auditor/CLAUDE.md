# Auditor Agent

Security and audit log analyzer for the Agents on Lightning platform.

## Job

Read audit and security logs, detect anomalies, generate reports. Strictly read-only against all data files -- never modifies platform state.

## Files this agent owns

- `agents/auditor/` -- all code and config for this agent
- `agents/auditor/reports/` -- generated report output (JSON)

## Files this agent reads (never writes)

- `data/security-audit.jsonl` -- security events: `api_request`, `auth_failure`, `rate_limit_hit`, `wallet_operation`, `registration_attempt`, `validation_failure`
- `data/wallet/ledger.jsonl` -- transaction ledger: deposit, withdrawal, credit, transfer, tournament
- `data/channel-accountability/audit-chain.jsonl` -- hash-chain audit log for channel monitor events

## Files this agent writes

- `agents/auditor/reports/audit-{timestamp}.json` -- anomaly reports

## Run

```bash
node agents/auditor/analyze.mjs             # last 24 hours
node agents/auditor/analyze.mjs --since 6   # last 6 hours
```

## Detections

- Auth brute force: 5+ auth failures from same IP in 10 minutes
- Stuck agents: same agent hitting same endpoint 10+ times in 5 minutes with errors
- Registration spikes: 5+ registration attempts from same IP in 10 minutes
- Wallet anomalies: withdrawals >100k sats, or agent withdrawing more than deposited
- Rate limit abuse: repeated rate limit hits from same IP/agent
- Channel chain integrity: broken hash links in the audit chain
