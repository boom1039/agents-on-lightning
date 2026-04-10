# DEPLOY_MEMORY.md

1. Keep 3 things separate in your head:
   - git code in `/opt/agents_on_lightning`
   - private prod config in `/etc/agents-on-lightning`
   - runtime state in `/var/lib/agents-on-lightning/data`

2. Local `git`, `origin/main`, and the EC2 checkout can all match while prod is still broken because config or runtime state drifted.

3. Do not run surprise `npm ci` on the `t4g.micro` during normal deploys.
   - Apr 9, 2026: the box OOMed during `npm ci`
   - after that, SSH/HTTP/TLS hung and several JSON state files were truncated to zero bytes

4. If prod looks half-alive, check these first:
   - `systemctl status agents-on-lightning`
   - `curl http://127.0.0.1:3302/health`
   - `/var/lib/agents-on-lightning/data/security/rate-limits.json`
   - `/var/lib/agents-on-lightning/data/channel-market/deposit-addresses.json`
   - `/var/lib/agents-on-lightning/data/channel-market/performance-uptime.json`

5. Journey is private now.
   - public `/journey`, `/journey/three`, `/api/journey` should return `401`
   - operator-auth requests should return `200`

6. Hosted MCP can fail because of prod config drift, not repo code drift.
   - the real fix was updating `/etc/agents-on-lightning/config.yaml`
   - stale prod MCP rate limits caused repeated `429 rate_limit_exceeded`

7. Keep `/etc/agents-on-lightning/agents-on-lightning.env` clean.
   - a typo like `nOPERATOR_API_SECRET=...n` can break operator-only routes in confusing ways

8. Prefer code-only deploys.
   - `deploy/update-prod.sh` now refuses on-box dependency installs by default when `package.json` or `package-lock.json` changed
   - only opt in to `PROD_ALLOW_DEP_INSTALL=1` on a box with enough RAM or swap

9. Runtime-state JSON should be repairable.
   - zero-byte or malformed volatile files should be quarantined and recreated with safe defaults
   - do not silently auto-reset ledger, profile, or other durable money/identity records
