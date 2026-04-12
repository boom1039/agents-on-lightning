# EC2 Deploy

Production has one normal deploy command:

```bash
npm run prod:deploy
```

That command owns the full deploy shape:

1. Build a runtime-only tarball locally.
2. Upload it to EC2.
3. Extract it to `APP_DIR/releases/<stamp>`.
4. Point `APP_DIR/current` at that release.
5. Restart systemd.
6. Prove prod is healthy.

Do not use `git pull`, manual `scp`, or direct lower-level scripts as the normal prod deploy path.
Do not commit real env files, config files, certs, macaroons, keys, or live data.
Production external agent access is MCP-only: public clients use `/mcp`; `/api/v1/*` is an internal route layer.

## Canonical Deploy

Create a private deploy env first:

```bash
cp deploy/config/prod-deploy.env.example deploy/prod.env
```

Then deploy:

```bash
npm run prod:deploy
```

What `prod-deploy.sh` does:

1. Runs `npm run proof:hardening` with a short deploy load proof.
2. Builds a runtime artifact with `deploy/build-runtime-artifact.sh`.
3. Deploys it with `deploy/prod-update.sh`.
4. Runs `deploy/prod-check.sh`.
5. Runs hosted MCP and public-surface checks.

Useful knobs:

```bash
AOL_DEPLOY_PROOF_REQUESTS=150000 npm run prod:deploy
AOL_DEPLOY_SKIP_PROOF=1 npm run prod:deploy
AOL_DEPLOY_ENV_FILE=/private/path/prod.env npm run prod:deploy
```

These are still the same deploy flow; they only tune proof size or env-file location.

## One-Time EC2 Setup

Install basics:

```bash
sudo apt update
sudo apt install -y nginx certbot curl ca-certificates gnupg python3 python3-pip apache2-utils
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs
node -v
```

Use Node `>=20`.

Create directories and user:

```bash
sudo mkdir -p /opt/agents_on_lightning /etc/agents-on-lightning /var/lib/agents-on-lightning /var/www/certbot
sudo useradd --system --home /opt/agents_on_lightning --shell /usr/sbin/nologin agentsonlightning || true
sudo chown -R agentsonlightning:agentsonlightning /opt/agents_on_lightning /var/lib/agents-on-lightning
```

Seed Linux dependencies once during host bootstrap:

```bash
git clone YOUR_REPO_URL /opt/agents_on_lightning
cd /opt/agents_on_lightning
npm ci --omit=dev
mkdir -p /opt/agents_on_lightning/data /opt/agents_on_lightning/releases
sudo chown -R agentsonlightning:agentsonlightning /opt/agents_on_lightning
```

Normal deploys must use `npm run prod:deploy`, not on-box `npm ci`.

## Prod Runtime Files

Private env file on EC2:

```dotenv
NODE_ENV=production
AOL_SERVER_ROLE=prod
AOL_CONFIG_PATH=/etc/agents-on-lightning/config.yaml
AOL_DATA_DIR=/var/lib/agents-on-lightning
AOL_JOURNEY_DB_PATH=/var/lib/agents-on-lightning/data/journey-analytics.duckdb
AOL_INTERNAL_BASE_URL=http://127.0.0.1:3302
HOST=127.0.0.1
PORT=3302
TRUST_PROXY=1
PYTHON3=/usr/bin/python3
ANTHROPIC_API_KEY_FILE=/etc/agents-on-lightning/anthropic_api_key
OPERATOR_API_SECRET=PRIVATE_VALUE
# ENABLE_OPERATOR_ROUTES stays unset or 0 unless doing a temporary local operator SQL investigation.
```

Private config file on EC2:

```text
/etc/agents-on-lightning/config.yaml
```

Start from:

```text
deploy/config/config.yaml.example
```

Systemd unit on EC2:

```text
/etc/systemd/system/agents-on-lightning.service
```

Start from:

```text
deploy/systemd/agents-on-lightning.service.template
```

Important systemd state paths:

```text
ReadWritePaths=/var/lib/agents-on-lightning /opt/agents_on_lightning/releases /opt/agents_on_lightning/current /opt/agents_on_lightning/data
```

## Runtime State Rules

Keep these separate:

1. Code releases: `/opt/agents_on_lightning/releases/<stamp>`.
2. Current symlink: `/opt/agents_on_lightning/current`.
3. Private config: `/etc/agents-on-lightning`.
4. Runtime state: `/var/lib/agents-on-lightning/data`.

Journey analytics must live here:

```text
/var/lib/agents-on-lightning/data/journey-analytics.duckdb
```

It must not live here:

```text
/opt/agents_on_lightning/current/data/journey-analytics.duckdb
```

`deploy/prod-check.sh` fails if that drift happens again.

## Artifact Contents

`npm run prod:deploy` builds the artifact through `deploy/build-runtime-artifact.sh`.
Do not use the artifact builder as a separate deploy path.

Default artifact includes:

1. `src/`
2. `config/default.yaml`
3. `docs/llms.txt`
4. `docs/mcp/`
6. `docs/skills/`
7. `docs/knowledge/`
8. `monitoring_dashboards/journey/`
9. `monitoring_dashboards/live/`
10. `package.json`
11. `package-lock.json`

It excludes `.git`, `plans`, `output`, tests, scratch scripts, and other non-runtime files.
`docs/skills/` remains packaged for local/internal compatibility, but public prod access hides it in MCP-only mode.
Leave `AOL_RUNTIME_INCLUDE_NODE_MODULES` unset for macOS-to-Linux prod deploys.

## Laptop LND Tunnel

If EC2 reaches LND through a laptop reverse tunnel, keep it managed by systemd instead of a manual terminal.

Use:

1. `deploy/systemd/agents-on-lightning-reverse-tunnel.service.template`
2. `deploy/config/managed-reverse-tunnel.env.example`

Forward only loopback ports on EC2, then point `config.yaml` at those EC2 loopback ports:

```yaml
nodes:
  alpha:
    host: 127.0.0.1
    restPort: 8080
```

The app should never need direct public access to your laptop LND.

## Verification

Run prod checks only:

```bash
npm run prod:check
```

Run hosted MCP only:

```bash
npm run test:mcp:prod
```

Run public-surface audit only:

```bash
npm run test:surface:prod
```

Run local hardening proof:

```bash
npm run proof:hardening
```

Run local proof plus prod checks:

```bash
npm run proof:hardening:prod
```

## Emergency Rollback

List releases:

```bash
ssh -i KEY ec2-user@HOST 'ls -1 /opt/agents_on_lightning/releases | tail -20'
```

Rollback:

```bash
ssh -i KEY ec2-user@HOST '
set -e
sudo ln -sfn /opt/agents_on_lightning/releases/RELEASE_ID /opt/agents_on_lightning/current
sudo chown -h agentsonlightning:agentsonlightning /opt/agents_on_lightning/current
sudo systemctl restart agents-on-lightning
systemctl is-active agents-on-lightning
curl -fsS http://127.0.0.1:3302/health
'
```

Then run:

```bash
npm run prod:check
```

## NGINX

Use these templates:

```text
deploy/nginx/agents-on-lightning.conf.template
deploy/nginx/agents-on-lightning-proxy.conf.template
```

All journey routes must proxy to the main app on port `3302`.
There is no separate journey monitor service.

These should hit the main app:

1. `/journey`
2. `/journey/three`
3. `/api/journey`
4. `/api/journey/events`
5. `/api/journey/manifest`
6. `/api/analytics/*`

## Troubleshooting

Fast checks:

```bash
systemctl status agents-on-lightning
curl http://127.0.0.1:3302/health
ps -C node -o pid=,rss=,pcpu=,pmem=,cmd=
```

State files to inspect first:

1. `/var/lib/agents-on-lightning/data/security/rate-limits.json`
2. `/var/lib/agents-on-lightning/data/channel-market/deposit-addresses.json`
3. `/var/lib/agents-on-lightning/data/channel-market/performance-uptime.json`
4. `/var/lib/agents-on-lightning/data/journey-analytics.duckdb`

Common failures:

1. `status=226/NAMESPACE`: a `ReadWritePaths` directory is missing.
2. Hosted MCP returns too many `429`s: prod rate-limit config drifted.
3. Journey analytics looks stale: check `AOL_JOURNEY_DB_PATH`.
4. Help endpoint warns about Anthropic: set `ANTHROPIC_API_KEY_FILE` or `ANTHROPIC_API_KEY`.

## Apr 2026 Incident Lessons

On a `t4g.micro`, `npm ci` OOMed the box and corrupted zero-byte runtime JSON files.

Rules from that incident:

1. Build artifacts off-box.
2. Do not run normal deploys through `git pull` plus `npm ci`.
3. Keep runtime state in `/var/lib/agents-on-lightning/data`.
4. Keep deploy checks versioned.
5. Treat config drift as seriously as code drift.
