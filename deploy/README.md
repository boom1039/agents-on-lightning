# EC2 Deploy Runbook

This repo deploys by git on the server.
Do not commit server-local env files, config files, certs, macaroons, or data.

## Pick your own local values

Replace these placeholders on the box:

- `APP_DIR` — where the repo lives
- `APP_CONFIG_DIR` — where your private env and config files live
- `APP_DATA_DIR` — writable app state directory
- `APP_USER` — service user
- `APP_HOST` — local bind host
- `APP_PORT` — app port
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

## 2. Clone and install

```bash
git clone YOUR_REPO_URL APP_DIR
cd APP_DIR
npm ci --omit=dev
```

## 3. Create the service user and directories

```bash
sudo mkdir -p APP_CONFIG_DIR APP_DATA_DIR /var/www/certbot
sudo useradd --system --home APP_DIR --shell /usr/sbin/nologin APP_USER || true
sudo chown -R APP_USER:APP_USER APP_DIR APP_DATA_DIR
```

## 4. Write the env file

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
# OPERATOR_API_SECRET=...
# CORS_ORIGINS=https://example.com,https://www.example.com
# CHANNEL_OPEN_PEER_ALLOWLIST=...
# CHANNEL_OPEN_REQUIRE_PEER_ALLOWLIST=1
```

## 5. Write the app config

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
WorkingDirectory=APP_DIR
EnvironmentFile=APP_CONFIG_DIR/agents-on-lightning.env
ExecStart=/usr/bin/node APP_DIR/src/index.js
Restart=on-failure
RestartSec=5
NoNewPrivileges=true
PrivateTmp=true
PrivateDevices=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=APP_DATA_DIR APP_DIR/data
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

## 8. Optional dashboard basic auth

```bash
sudo htpasswd -c /etc/nginx/.htpasswd-agents-dashboard YOUR_USERNAME
```

## 9. Put NGINX in front

Use your own domain names and certificate paths.
Proxy the public site to `APP_HOST:APP_PORT`.
If you want dashboard auth, protect `/journey/` and `/journey/three` in NGINX.

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

## 10. Update production later

```bash
cd APP_DIR
git pull --ff-only
npm ci --omit=dev
sudo systemctl restart agents-on-lightning
```
