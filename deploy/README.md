# EC2 Deploy Runbook

This repo does **not** have an AWS push script.
It does **not** use an SSH key plus `rsync` from this repo.
The current deploy path is: SSH into the EC2 box, `git clone` or `git pull`, then restart the app.

## What you are deploying

- One Node app process on `127.0.0.1:3302`
- One public NGINX front door on `80` and `443`
- One dashboard path on the same app: `/journey/` and `/journey/three`
- Canonical docs at `/llms.txt` and `/docs/skills/*.txt`

## 1. Install packages

```bash
sudo apt update
sudo apt install -y nginx certbot curl ca-certificates gnupg python3 python3-pip apache2-utils
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs
node -v
```

Use Node `>=20`.

## 2. Put the repo on the box

```bash
sudo mkdir -p /opt/agents_on_lightning
git clone YOUR_REPO_URL /opt/agents_on_lightning
cd /opt/agents_on_lightning
npm ci --omit=dev
```

## 3. Create directories and service user

```bash
sudo mkdir -p /var/www/certbot
sudo mkdir -p /etc/agents-on-lightning
sudo mkdir -p /var/lib/agents-on-lightning
sudo useradd --system --home /opt/agents_on_lightning --shell /usr/sbin/nologin agentsonlightning || true
sudo chown -R agentsonlightning:agentsonlightning /opt/agents_on_lightning
sudo chown -R agentsonlightning:agentsonlightning /var/lib/agents-on-lightning
```

## 4. Write the env file

Create `/etc/agents-on-lightning/agents-on-lightning.env`:

```dotenv
NODE_ENV=production
AOL_SERVER_ROLE=prod
AOL_CONFIG_PATH=/etc/agents-on-lightning/config.yaml
AOL_DATA_DIR=/var/lib/agents-on-lightning
HOST=127.0.0.1
PORT=3302
TRUST_PROXY=1
PYTHON3=/usr/bin/python3
# AOL_ANALYTICS_SCRIPT_DIR=/opt/ln_research/analytics_api

# Add real secrets below.
# ANTHROPIC_API_KEY=...
# OPERATOR_API_SECRET=...
# CORS_ORIGINS=https://agentsonlightning.com,https://agentsonbitcoin.com
# CHANNEL_OPEN_PEER_ALLOWLIST=...
# CHANNEL_OPEN_REQUIRE_PEER_ALLOWLIST=1
```

```bash
sudo chmod 640 /etc/agents-on-lightning/agents-on-lightning.env
```

## 5. Write the app config

Create `/etc/agents-on-lightning/config.yaml`:

```yaml
web:
  port: 3302

nodes:
  alpha:
    host: 127.0.0.1
    restPort: 8080
    lndDir: /var/lib/lnd
    macaroonPath: /var/lib/lnd/data/chain/bitcoin/mainnet/agents-on-lightning.macaroon
    tlsCertPath: /var/lib/lnd/tls.cert

cashu:
  port: 3338
  mintUrl: http://127.0.0.1:3338
  seedPath: /var/lib/agents-on-lightning/cashu-master-seed.hex
```

```bash
sudo chmod 640 /etc/agents-on-lightning/config.yaml
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
User=agentsonlightning
Group=agentsonlightning
WorkingDirectory=/opt/agents_on_lightning
EnvironmentFile=/etc/agents-on-lightning/agents-on-lightning.env
ExecStart=/usr/bin/node /opt/agents_on_lightning/src/index.js
Restart=on-failure
RestartSec=5
NoNewPrivileges=true
PrivateTmp=true
PrivateDevices=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=/var/lib/agents-on-lightning /opt/agents_on_lightning/data
RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX
RestrictRealtime=true
LockPersonality=true
UMask=0077

[Install]
WantedBy=multi-user.target
```

Start it:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now agents-on-lightning
sudo systemctl status agents-on-lightning
```

## 7. Local smoke test

```bash
curl http://127.0.0.1:3302/health
curl http://127.0.0.1:3302/llms.txt
curl http://127.0.0.1:3302/api/v1/
curl http://127.0.0.1:3302/journey/
curl http://127.0.0.1:3302/journey/three
```

## 8. Create dashboard basic auth

```bash
sudo htpasswd -c /etc/nginx/.htpasswd-agents-on-lightning-dashboard YOUR_USERNAME
sudo chmod 640 /etc/nginx/.htpasswd-agents-on-lightning-dashboard
sudo chown root:www-data /etc/nginx/.htpasswd-agents-on-lightning-dashboard
```

## 9. Bootstrap NGINX and get certs

Create `/etc/nginx/sites-available/agents-on-lightning.conf`:

```nginx
server {
    listen 80;
    listen [::]:80;
    server_name agentsonlightning.com www.agentsonlightning.com agentsonbitcoin.com www.agentsonbitcoin.com;

    server_tokens off;

    location /.well-known/acme-challenge/ {
        root /var/www/certbot;
    }

    location / {
        return 301 https://$host$request_uri;
    }
}
```

Enable it and get the cert:

```bash
sudo ln -sf /etc/nginx/sites-available/agents-on-lightning.conf /etc/nginx/sites-enabled/agents-on-lightning.conf
sudo nginx -t
sudo systemctl reload nginx

sudo certbot certonly --webroot -w /var/www/certbot \
  -d agentsonlightning.com \
  -d www.agentsonlightning.com \
  -d agentsonbitcoin.com \
  -d www.agentsonbitcoin.com
```

The cert path below uses the first domain name from that certbot command.

## 10. Replace NGINX with the final config

Replace `/etc/nginx/sites-available/agents-on-lightning.conf` with:

```nginx
upstream agents_on_lightning_app {
    server 127.0.0.1:3302;
    keepalive 32;
}

limit_req_zone $binary_remote_addr zone=aol_docs:10m rate=30r/m;
limit_req_zone $binary_remote_addr zone=aol_api:10m rate=120r/m;
limit_req_zone $binary_remote_addr zone=aol_danger:10m rate=20r/m;
limit_conn_zone $binary_remote_addr zone=aol_conn:10m;

server {
    listen 80;
    listen [::]:80;
    server_name agentsonlightning.com www.agentsonlightning.com agentsonbitcoin.com www.agentsonbitcoin.com;

    server_tokens off;

    location /.well-known/acme-challenge/ {
        root /var/www/certbot;
    }

    location / {
        return 301 https://$host$request_uri;
    }
}

server {
    listen 443 ssl http2;
    listen [::]:443 ssl http2;
    server_name agentsonlightning.com agentsonbitcoin.com;

    server_tokens off;
    client_max_body_size 16k;
    keepalive_timeout 15s;
    send_timeout 15s;

    ssl_certificate /etc/letsencrypt/live/agentsonlightning.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/agentsonlightning.com/privkey.pem;
    ssl_session_timeout 1d;
    ssl_session_cache shared:SSL:10m;
    ssl_session_tickets off;
    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_prefer_server_ciphers on;
    ssl_ciphers ECDHE-ECDSA-AES256-GCM-SHA384:ECDHE-RSA-AES256-GCM-SHA384:ECDHE-ECDSA-CHACHA20-POLY1305:ECDHE-RSA-CHACHA20-POLY1305:ECDHE-ECDSA-AES128-GCM-SHA256:ECDHE-RSA-AES128-GCM-SHA256;

    add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;
    add_header X-Content-Type-Options "nosniff" always;
    add_header X-Frame-Options "DENY" always;
    add_header Referrer-Policy "no-referrer" always;

    limit_conn aol_conn 20;

    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header Connection "";
    proxy_connect_timeout 5s;
    proxy_send_timeout 30s;
    proxy_read_timeout 30s;

    location = /llms.txt {
        limit_req zone=aol_docs burst=20 nodelay;
        proxy_pass http://agents_on_lightning_app;
    }

    location ^~ /docs/ {
        limit_req zone=aol_docs burst=20 nodelay;
        proxy_pass http://agents_on_lightning_app;
    }

    location ~ ^/(journey|api/journey) {
        auth_basic "Agents on Lightning Monitor";
        auth_basic_user_file /etc/nginx/.htpasswd-agents-on-lightning-dashboard;
        proxy_pass http://agents_on_lightning_app;
    }

    location ~ ^/api/v1/(analysis|market|channels|capital|node)/ {
        limit_req zone=aol_danger burst=10 nodelay;
        proxy_pass http://agents_on_lightning_app;
    }

    location = /api/v1/help {
        limit_req zone=aol_danger burst=10 nodelay;
        proxy_pass http://agents_on_lightning_app;
    }

    location ^~ /api/ {
        limit_req zone=aol_api burst=30 nodelay;
        proxy_pass http://agents_on_lightning_app;
    }

    location / {
        limit_req zone=aol_api burst=40 nodelay;
        proxy_pass http://agents_on_lightning_app;
    }
}

server {
    listen 443 ssl http2;
    listen [::]:443 ssl http2;
    server_name www.agentsonlightning.com www.agentsonbitcoin.com;

    ssl_certificate /etc/letsencrypt/live/agentsonlightning.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/agentsonlightning.com/privkey.pem;
    return 301 https://$host$request_uri;
}
```

Reload NGINX:

```bash
sudo nginx -t
sudo systemctl reload nginx
sudo certbot renew --dry-run
```

## 11. Public smoke test

```bash
curl -I http://agentsonlightning.com
curl -I https://agentsonlightning.com
curl https://agentsonlightning.com/health
curl https://agentsonlightning.com/llms.txt
curl -u YOUR_USERNAME https://agentsonlightning.com/journey/
curl -u YOUR_USERNAME https://agentsonlightning.com/journey/three
curl https://agentsonbitcoin.com/health
```

## 12. Security group

Open only:

- `80/tcp`
- `443/tcp`
- `22/tcp` from your admin IPs

Do not expose `3302`.
