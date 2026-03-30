# EC2 deployment with NGINX in front of Express

This repo is set up to run behind NGINX on one EC2 box.

## Chosen defaults

- App process: plain Node + `systemd`
- Internal bind: `127.0.0.1:3302`
- Public entry point: NGINX on `80` and `443`
- Public domains:
  - `agentsonlightning.com`
  - `www.agentsonlightning.com` -> redirect to apex
  - `agentsonbitcoin.com`
  - `www.agentsonbitcoin.com` -> redirect to apex

## 1. Install runtime packages

Ubuntu example:

```bash
sudo apt update
sudo apt install -y nginx certbot curl ca-certificates gnupg python3 python3-pip rsync
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs
node -v
sudo mkdir -p /var/www/certbot /etc/agents-on-lightning
sudo mkdir -p /var/lib/agents-on-lightning
```

Do not continue unless `node -v` is `>=20`.

## 2. Put the app on the box

```bash
sudo mkdir -p /opt/agents_on_lightning
git clone YOUR_REPO_URL /opt/agents_on_lightning
cd /opt/agents_on_lightning
npm ci --omit=dev
```

Use a clean checkout.
Do not deploy by copying a dirty local working tree with live `data/`.

## 3. Create the service user and env file

```bash
sudo useradd --system --home /opt/agents_on_lightning --shell /usr/sbin/nologin agentsonlightning || true
sudo chown -R agentsonlightning:agentsonlightning /opt/agents_on_lightning
sudo chown -R agentsonlightning:agentsonlightning /var/lib/agents-on-lightning
sudo cp deploy/systemd/agents-on-lightning.env.example /etc/agents-on-lightning/agents-on-lightning.env
sudo cp deploy/config/agents-on-lightning.example.yaml /etc/agents-on-lightning/config.yaml
sudo chmod 640 /etc/agents-on-lightning/agents-on-lightning.env
sudo chmod 640 /etc/agents-on-lightning/config.yaml
```

Fill in the real secrets in `/etc/agents-on-lightning/agents-on-lightning.env`.
Fill in the real LND and Cashu settings in `/etc/agents-on-lightning/config.yaml`.
If analytics are enabled, also install or mount the real `ln_research/analytics_api` tree and set `AOL_ANALYTICS_SCRIPT_DIR`.

## 4. Install and start the app service

```bash
sudo cp deploy/systemd/agents-on-lightning.service /etc/systemd/system/agents-on-lightning.service
sudo systemctl daemon-reload
sudo systemctl enable --now agents-on-lightning
sudo systemctl status agents-on-lightning
curl http://127.0.0.1:3302/health
curl http://127.0.0.1:3302/api/v1/analysis/network-health
```

Do not accept a false-green `/health`.
Verify the returned JSON is not `degraded`, and also smoke one auth route and one Python-backed route before public cutover.

## 5. Install the bootstrap NGINX config

```bash
sudo cp deploy/nginx/agents-on-lightning-bootstrap.conf /etc/nginx/sites-available/agents-on-lightning.conf
sudo ln -sf /etc/nginx/sites-available/agents-on-lightning.conf /etc/nginx/sites-enabled/agents-on-lightning.conf
sudo mkdir -p /etc/nginx/snippets
sudo cp deploy/nginx/agents-on-lightning-proxy.conf /etc/nginx/snippets/agents-on-lightning-proxy.conf
sudo nginx -t
sudo systemctl reload nginx
```

## 6. Issue certificates

Use webroot mode after the DNS for all four hostnames points at this EC2 box:

```bash
sudo certbot certonly --webroot -w /var/www/certbot \
  -d agentsonlightning.com \
  -d www.agentsonlightning.com \
  -d agentsonbitcoin.com \
  -d www.agentsonbitcoin.com
```

Then verify renewal:

```bash
sudo certbot renew --dry-run
```

## 7. Switch to the full HTTPS config

```bash
sudo cp deploy/nginx/agents-on-lightning.conf /etc/nginx/sites-available/agents-on-lightning.conf
sudo nginx -t
sudo systemctl reload nginx
```

## 8. Lock down the EC2 security group

Open only:

- `80/tcp`
- `443/tcp`
- `22/tcp` from your admin IPs only

Do not expose `3302`.

## 9. Verify the public setup

```bash
curl -I http://agentsonlightning.com
curl -I https://agentsonlightning.com
curl https://agentsonlightning.com/health
curl https://agentsonlightning.com/llms.txt
curl https://agentsonbitcoin.com/health
```

Also confirm:

- `3302` is not reachable from outside
- `TRUST_PROXY=1` is set only because NGINX is in front
- dashboard/help behavior matches the secrets you actually configured
- NGINX reload after renewal is handled, for example with a deploy hook or system timer

## Notes

- This keeps Express private behind NGINX.
- Set `TRUST_PROXY=1` only when NGINX really is in front.
- The app still enforces the real business safety rules; NGINX is just the first shield.
