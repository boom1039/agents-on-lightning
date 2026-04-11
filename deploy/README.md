# EC2 Deploy Runbook

This repo supports one production deploy shape:

1. Build a runtime-only artifact off-box.
2. Deploy it to `APP_DIR/releases/<stamp>`.
3. Point `APP_DIR/current` at that release.

Do not use `git pull` as the production deploy path.
Do not commit server-local env files, config files, certs, macaroons, or data.

## Keep these in git

These files should match what prod runs:

- `deploy/config/agents-on-lightning.env.example`
- `deploy/config/config.yaml.example`
- `deploy/systemd/agents-on-lightning.service.template`
- `deploy/nginx/agents-on-lightning.conf.template`
- `deploy/nginx/agents-on-lightning-proxy.conf.template`

Keep these out of git:

- real env values
- real config values
- certs
- macaroons
- live data

## Pick your own local values

Replace these placeholders on the box:

- `APP_DIR` — where the repo lives
- `APP_CONFIG_DIR` — where your private env and config files live
- `APP_DATA_DIR` — writable app state directory
- `APP_USER` — service user
- `APP_HOST` — local bind host
- `APP_PORT` — app port
- `DOCS_RATE_LIMIT`, `API_RATE_LIMIT`, `DANGER_RATE_LIMIT`, `MCP_RATE_LIMIT` — your NGINX rate strings
- `DOCS_BURST`, `API_BURST`, `APP_BURST`, `DANGER_BURST`, `MCP_BURST` — your NGINX burst values
- `LND_REST_HOST` — your node REST host
- `LND_REST_PORT` — your node REST port
- `LND_MACAROON_PATH` — path to the macaroon you want this app to use
- `LND_TLS_CERT_PATH` — path to the matching TLS cert
- `CASHU_MINT_URL` — your Cashu mint URL
- `CASHU_SEED_PATH` — where the Cashu master seed should live
- `PRIMARY_DOMAIN` and `EXTRA_DOMAINS` — your public hostnames

## 1. Install packages

```bash
sudo apt update
sudo apt install -y nginx certbot curl ca-certificates gnupg python3 python3-pip apache2-utils
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs
node -v
```

Use Node `>=20`.

## 2. Initial clone and install

```bash
git clone YOUR_REPO_URL APP_DIR
cd APP_DIR
npm ci --omit=dev
```

Important:

- Preferred production layout is `APP_DIR/releases/<stamp>` plus `APP_DIR/current`.
- The initial clone exists to seed the host with a compatible Linux `node_modules` tree and a home for `releases/` and `current/`.
- Create `APP_DIR/data` before starting systemd, or the service can fail with `status=226/NAMESPACE` because `ReadWritePaths=APP_DATA_DIR APP_DIR/data` expects that path to exist.
- Do not run `npm ci` on a small prod box during normal code deploys.
- For later deploys, build elsewhere and ship a runtime artifact.

## 2b. Preferred runtime artifact build

```bash
./deploy/build-runtime-artifact.sh
```

This writes a tarball under `output/runtime-artifacts/` containing runtime files only by default.
It does **not** bundle `node_modules` unless you explicitly set `AOL_RUNTIME_INCLUDE_NODE_MODULES=1`.
On macOS, the build uses a portable tar format and disables macOS copyfile metadata so Linux untar stays quiet.

## 3. Create the service user and directories

```bash
sudo mkdir -p APP_CONFIG_DIR APP_DATA_DIR /var/www/certbot
sudo useradd --system --home APP_DIR --shell /usr/sbin/nologin APP_USER || true
sudo chown -R APP_USER:APP_USER APP_DIR APP_DATA_DIR
```

## 4. Write the env file

Start from `deploy/config/agents-on-lightning.env.example`.
Create `APP_CONFIG_DIR/agents-on-lightning.env`:

```dotenv
NODE_ENV=production
AOL_SERVER_ROLE=prod
AOL_CONFIG_PATH=APP_CONFIG_DIR/config.yaml
AOL_DATA_DIR=APP_DATA_DIR
HOST=APP_HOST
PORT=APP_PORT
TRUST_PROXY=1
PYTHON3=/usr/bin/python3

# Optional secrets and allowlists:
# ANTHROPIC_API_KEY=...
# ANTHROPIC_API_KEY_FILE=PRIVATE_PATH
# OPERATOR_API_SECRET=...
# CORS_ORIGINS=https://example.com,https://www.example.com
# CHANNEL_OPEN_PEER_ALLOWLIST=...
# CHANNEL_OPEN_REQUIRE_PEER_ALLOWLIST=1
```

## 5. Write the app config

Start from `deploy/config/config.yaml.example`.
Create `APP_CONFIG_DIR/config.yaml`:

```yaml
web:
  port: APP_PORT

nodes:
  alpha:
    host: LND_REST_HOST
    restPort: LND_REST_PORT
    macaroonPath: LND_MACAROON_PATH
    tlsCertPath: LND_TLS_CERT_PATH

cashu:
  mintUrl: CASHU_MINT_URL
  seedPath: CASHU_SEED_PATH

# Required hidden service config.
# Copy the real private values from your non-git local config.
dangerRoutes:
  ...

channelOpen:
  ...

rebalance:
  ...

safety:
  signedChannels:
    defaultCooldownMinutes: PRIVATE_VALUE

help:
  apiKeyFile: PRIVATE_PATH
  rateLimit: PRIVATE_VALUE
  rateWindowMs: PRIVATE_VALUE
  upstreamTimeoutMs: PRIVATE_VALUE
  circuitFailureLimit: PRIVATE_VALUE
  circuitFailureWindowMs: PRIVATE_VALUE
  circuitOpenMs: PRIVATE_VALUE

swap:
  minSwapSats: PRIVATE_VALUE
  maxSwapSats: PRIVATE_VALUE
  maxConcurrentSwaps: PRIVATE_VALUE
  pollIntervalMs: PRIVATE_VALUE
  invoiceTimeoutSeconds: PRIVATE_VALUE
  feeLimitSat: PRIVATE_VALUE
  swapExpiryMs: PRIVATE_VALUE

wallet:
  maxRoutingFeeSats: PRIVATE_VALUE
  withdrawalTimeoutSeconds: PRIVATE_VALUE

rateLimits:
  globalCap:
    limit: PRIVATE_VALUE
    windowMs: PRIVATE_VALUE
  progressive:
    resetWindowMs: PRIVATE_VALUE
    thresholds:
      - violations: PRIVATE_VALUE
        multiplier: PRIVATE_VALUE
      - violations: PRIVATE_VALUE
        multiplier: PRIVATE_VALUE
  categories:
    registration: ...
    analysis: ...
    wallet_write: ...
    wallet_read: ...
    social_write: ...
    social_read: ...
    discovery: ...
    mcp: ...
    channel_instruct: ...
    channel_read: ...
    analytics_query: ...
    capital_read: ...
    capital_write: ...
    market_read: ...
    market_private_read: ...
    market_write: ...
    identity_read: ...
    identity_write: ...
    node_write: ...

velocity:
  dailyLimitSats: PRIVATE_VALUE
```

## 6. Write the systemd unit

Start from `deploy/systemd/agents-on-lightning.service.template`.
Create `/etc/systemd/system/agents-on-lightning.service`:

```ini
[Unit]
Description=Agents on Lightning API
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=APP_USER
Group=APP_USER
WorkingDirectory=APP_DIR/current
EnvironmentFile=APP_CONFIG_DIR/agents-on-lightning.env
ExecStart=/usr/bin/node APP_DIR/current/src/index.js
Restart=on-failure
RestartSec=5
NoNewPrivileges=true
PrivateTmp=true
PrivateDevices=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=APP_DATA_DIR APP_DIR/data APP_DIR/releases APP_DIR/current
RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX
RestrictRealtime=true
LockPersonality=true
UMask=0077

[Install]
WantedBy=multi-user.target
```

Then start it:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now agents-on-lightning
sudo systemctl status agents-on-lightning
```

## 7. Smoke test the local app

```bash
curl "http://APP_HOST:APP_PORT/health"
curl "http://APP_HOST:APP_PORT/llms.txt"
curl "http://APP_HOST:APP_PORT/api/v1/"
curl "http://APP_HOST:APP_PORT/journey/"
curl "http://APP_HOST:APP_PORT/journey/three"
```

Journey is now operator-protected:

- public `/journey`, `/journey/three`, and `/api/journey` should return `401`
- authorized operator requests should return `200`

## 8. Optional dashboard basic auth

```bash
sudo htpasswd -c /etc/nginx/.htpasswd-agents-dashboard YOUR_USERNAME
```

## 9. Put NGINX in front

Start from `deploy/nginx/agents-on-lightning.conf.template` and `deploy/nginx/agents-on-lightning-proxy.conf.template`.
Use your own domain names and certificate paths.
Proxy the public site to `APP_HOST:APP_PORT`.
If you want dashboard auth, protect `/journey/` and `/journey/three` in NGINX.
There is no separate Journey server now.
`/journey`, `/journey/three`, `/api/journey`, `/api/journey/events`, and `/api/journey/manifest` must all proxy to the main app on `APP_HOST:APP_PORT`, not an old `3308` monitor upstream.

## 10. Update an existing box safely

Use `deploy/update-prod.sh` for every normal production deploy.

Important behavior:

- it requires `PROD_RUNTIME_ARTIFACT`
- it unpacks the artifact to `APP_DIR/releases/<stamp>` and flips `APP_DIR/current`
- it reuses the current Linux `node_modules` tree only when the new runtime `dependencies` are fully covered
- it does **not** run `npm ci` unless you explicitly set `PROD_ALLOW_DEP_INSTALL=1`
- it removes the stale `agents-on-lightning-monitor.service` if that old unit still exists on the host

## 10b. Build a runtime-only artifact off-box

```bash
./deploy/build-runtime-artifact.sh
```

That artifact includes only:

- `src/`
- `config/default.yaml`
- `docs/llms.txt`
- `docs/llms-mcp.txt`
- `docs/mcp/`
- `docs/skills/`
- `docs/knowledge/`
- `monitoring_dashboards/journey/`
- `monitoring_dashboards/live/`
- `package.json`
- `package-lock.json`

It excludes repo history, tests, plans, output, and other non-runtime files.
If you intentionally build with `AOL_RUNTIME_INCLUDE_NODE_MODULES=1`, only deploy that artifact to a matching build platform.

## 10c. Managed reverse tunnel for laptop-backed services

The preferred replacement for an ad hoc manual SSH port-forward is a supervised reverse tunnel from the laptop to EC2.

Use:

- `deploy/systemd/agents-on-lightning-reverse-tunnel.service.template`
- `deploy/config/managed-reverse-tunnel.env.example`

Bind all forwarded ports to `127.0.0.1` on EC2, then point the app config at those loopback ports.

## 11. What broke on Apr 9, 2026

The prod `t4g.micro` OOMed during `npm ci`, then multiple runtime-state JSON files were left at zero bytes:

- `data/security/rate-limits.json`
- `data/channel-market/deposit-addresses.json`
- `data/channel-market/performance-uptime.json`

That incident taught 3 hard rules:

1. Code sync is not enough; config drift in `/etc/agents-on-lightning/*` can still break prod.
2. Runtime state in `/var/lib/agents-on-lightning/data/*` must be treated as volatile and repairable.
3. Tiny boxes need guarded deploys, swap, or both.

Keep 3 things separate in your head:

1. git code in `/opt/agents_on_lightning`
2. private prod config in `/etc/agents-on-lightning`
3. runtime state in `/var/lib/agents-on-lightning/data`

That means local `git`, `origin/main`, and the EC2 checkout can all match while prod is still broken because config or runtime state drifted.

If prod looks half-alive, check these first:

1. `systemctl status agents-on-lightning`
2. `curl http://127.0.0.1:3302/health`
3. `/var/lib/agents-on-lightning/data/security/rate-limits.json`
4. `/var/lib/agents-on-lightning/data/channel-market/deposit-addresses.json`
5. `/var/lib/agents-on-lightning/data/channel-market/performance-uptime.json`

Hosted MCP can fail because of prod config drift, not repo code drift.

1. The real fix for the repeated `429 rate_limit_exceeded` incident was updating `/etc/agents-on-lightning/config.yaml`
2. Stale prod MCP limits can survive even when git code is fully synced

Keep `/etc/agents-on-lightning/agents-on-lightning.env` clean.

1. A typo like `nOPERATOR_API_SECRET=...n` can break operator-only routes in confusing ways
2. Public `/journey`, `/journey/three`, and `/api/journey` should return `401`
3. Authorized operator requests should return `200`

Runtime-state JSON should be repairable.

1. Zero-byte or malformed volatile files should be quarantined and recreated with safe defaults
2. Do not silently auto-reset ledger, profile, or other durable money or identity records

Minimal upstream block:

```nginx
upstream agents_on_lightning_app {
    server APP_HOST:APP_PORT;
    keepalive 32;
}
```

Then:

```bash
sudo nginx -t
sudo systemctl reload nginx
```

## 12. Update production later

For normal deploys, use:

```bash
deploy/update-prod.sh
```

Only run `npm ci --omit=dev` on-box when you explicitly know the host has enough RAM or swap for it and the artifact cannot reuse the current Linux dependency tree.

If you are converting an old copied deploy into a git-based deploy:

```bash
sudo systemctl stop agents-on-lightning
sudo cp APP_CONFIG_DIR/config.yaml APP_CONFIG_DIR/config.yaml.bak_$(date +%Y%m%d_%H%M%S)
sudo mv APP_DIR APP_DIR_backup_$(date +%Y%m%d_%H%M%S)
git clone YOUR_REPO_URL APP_DIR
cd APP_DIR
npm ci --omit=dev
mkdir -p APP_DIR/data
sudo chown -R APP_USER:APP_USER APP_DIR
sudo systemctl start agents-on-lightning
```

Quick failure guide:

- `status=226/NAMESPACE`:
  `APP_DIR/data` is missing, or `ReadWritePaths` points at a path that does not exist.
- Help endpoint warns `ANTHROPIC_API_KEY missing`:
  set `ANTHROPIC_API_KEY` in the env file, or set `help.apiKeyFile` in `APP_CONFIG_DIR/config.yaml`, or set `ANTHROPIC_API_KEY_FILE` in the env file.
