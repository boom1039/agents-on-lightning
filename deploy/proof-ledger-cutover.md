# Proof Ledger Production Cutover

This runbook turns on the Proof Ledger as the canonical custody/accounting source of truth.

The point is simple: agents and humans need more than a dashboard number when real sats are held by the platform. The Proof Ledger writes signed, hash-linked proof rows so agents can retain evidence of what `agentsonlightning.com`, `agentsonbitcoin.com`, and `lightningobservatory.com` acknowledged about balances, liabilities, reserves, and money movement.

## Safety Rules

1. Do not enable Proof Ledger without a persistent signing key.
2. Do not let production auto-generate the signing key.
3. Do not delete old JSON/JSONL state during first cutover.
4. Do not publish Proof of Reserves unless the reserve snapshot evidence is real and public-safe.
5. Keep MCP telemetry and request logs separate from money proofs.
6. Roll back code by release symlink; do not edit the SQLite ledger by hand.

## Files And Env

Production app env file:

```text
/etc/agents-on-lightning/agents-on-lightning.env
```

Production Proof Ledger DB:

```text
/var/lib/agents-on-lightning/data/proof-ledger.sqlite
```

Production signing key:

```text
/etc/agents-on-lightning/proof-ledger-ed25519-private.pem
```

Required env:

```dotenv
AOL_PROOF_LEDGER_ENABLED=1
AOL_PROOF_LEDGER_DB_PATH=/var/lib/agents-on-lightning/data/proof-ledger.sqlite
AOL_PROOF_LEDGER_KEY_PATH=/etc/agents-on-lightning/proof-ledger-ed25519-private.pem
OPERATOR_API_SECRET=PRIVATE_VALUE
```

Only enable local operator proof-publishing routes while publishing checkpoints or reserve snapshots:

```dotenv
ENABLE_OPERATOR_ROUTES=1
```

Operator routes are still loopback-only and require `OPERATOR_API_SECRET`.

## SSH And Deploy Env

Use the existing deploy env file:

```bash
deploy/prod.env
```

It should define:

```dotenv
PROD_SSH_TARGET=...
PROD_SSH_KEY=...
PROD_APP_DIR=...
PROD_APP_USER=...
PROD_SERVICE=...
PROD_LOCAL_HOST=127.0.0.1
PROD_LOCAL_PORT=3302
PROD_PRIMARY_BASE_URL=https://agentsonlightning.com
```

The deploy scripts already load `PROD_SSH_KEY`; do not make a second SSH-key convention for Proof Ledger work.

## One-Time Key Provisioning

Run on the production host as root or through sudo:

```bash
sudo install -d -m 700 -o agentsonlightning -g agentsonlightning /etc/agents-on-lightning
sudo openssl genpkey -algorithm Ed25519 -out /etc/agents-on-lightning/proof-ledger-ed25519-private.pem
sudo chown agentsonlightning:agentsonlightning /etc/agents-on-lightning/proof-ledger-ed25519-private.pem
sudo chmod 600 /etc/agents-on-lightning/proof-ledger-ed25519-private.pem
```

Back this key up like a production secret. If it is lost, old proof signatures remain verifiable with the published public key but new rows need a key-rotation proof before a new key becomes authoritative.

## Predeploy Local Checks

Run:

```bash
npm run proof:ledger:smoke:core
node --test src/proof-ledger/proof-ledger.test.js src/proof-ledger/public-ledger-adapter.test.js src/routes/operator-control-routes.test.js
```

Expected:

```text
proof_ledger_smoke_ok=1
all tests pass
```

## Deploy

Deploy through the normal artifact path:

```bash
npm run prod:deploy
```

Do not use `git pull`, manual `scp`, or on-box `npm ci`.

## Enable Proof Ledger

SSH through the existing deploy env values:

```bash
source deploy/prod.env
ssh -i "$PROD_SSH_KEY" "$PROD_SSH_TARGET"
```

On the production host:

```bash
sudoedit /etc/agents-on-lightning/agents-on-lightning.env
sudo systemctl restart agents-on-lightning
systemctl is-active agents-on-lightning
curl -fsS http://127.0.0.1:3302/health
```

Confirm public key and genesis:

```bash
curl -fsS http://127.0.0.1:3302/.well-known/proof-ledger-public-key.json
curl -fsS http://127.0.0.1:3302/.well-known/proof-ledger.json
```

## Smoke Verification

From local machine against public prod:

```bash
npm run proof:ledger:smoke:prod
```

From the production host against loopback:

```bash
cd /opt/agents_on_lightning/current
AOL_PROOF_LEDGER_SMOKE_BASE_URL=http://127.0.0.1:3302 node scripts/proof-ledger-smoke.mjs
```

The smoke script always tests a temporary local Proof Ledger core first. Hosted checks then verify:

1. `/.well-known/proof-ledger-public-key.json`
2. `/.well-known/proof-ledger.json`
3. MCP proof tool registration
4. `aol_get_proof_of_liabilities`
5. `aol_get_proof_of_reserves`

## Publish Liability Checkpoint

Keep `ENABLE_OPERATOR_ROUTES=1` only as long as needed.

On the production host:

```bash
cd /opt/agents_on_lightning/current
OPERATOR_API_SECRET="$(sudo awk -F= '$1=="OPERATOR_API_SECRET"{print $2}' /etc/agents-on-lightning/agents-on-lightning.env)"
AOL_PROOF_LEDGER_SMOKE_BASE_URL=http://127.0.0.1:3302 \
AOL_PROOF_LEDGER_SMOKE_OPERATOR_WRITE=1 \
AOL_PROOF_LEDGER_SMOKE_OPERATOR_SECRET="$OPERATOR_API_SECRET" \
node scripts/proof-ledger-smoke.mjs
```

This creates or reuses a signed liability checkpoint derived from `proof_ledger`.

Manual equivalent:

```bash
curl -fsS \
  -H "content-type: application/json" \
  -H "x-operator-secret: $OPERATOR_API_SECRET" \
  -d '{}' \
  http://127.0.0.1:3302/api/operator/proof-ledger/liability-checkpoint
```

## Publish Reserve Snapshot

Only do this when the reserve evidence is real and safe to publish.

Example loopback command:

```bash
curl -fsS \
  -H "content-type: application/json" \
  -H "x-operator-secret: $OPERATOR_API_SECRET" \
  -d '{
    "reserve_totals_by_source": {
      "lnd_onchain": {
        "reserve_source_type": "lnd_onchain_wallet",
        "amount_sats": 0
      }
    },
    "reserve_evidence_refs": [
      {
        "evidence_type": "operator_attested"
      }
    ],
    "reserve_sufficient": false
  }' \
  http://127.0.0.1:3302/api/operator/proof-ledger/reserve-snapshot
```

Replace the example with real reserve values before claiming sufficiency.

Then reconcile:

```bash
curl -fsS \
  -H "content-type: application/json" \
  -H "x-operator-secret: $OPERATOR_API_SECRET" \
  -d '{
    "reconciliation_status": "reserve_snapshot_published",
    "reserve_sufficient": false
  }' \
  http://127.0.0.1:3302/api/operator/proof-ledger/reconciliation
```

## Public Checks

After checkpoint/snapshot publishing:

```bash
curl -fsS https://agentsonlightning.com/.well-known/proof-ledger.json
npm run test:mcp:prod
npm run test:surface:prod
```

The public copy must remain honest:

1. Proof of Liabilities is live when signed proof rows exist.
2. Proof of Reserves is only live when a reserve snapshot exists.
3. Reserve sufficiency is only true when the evidence supports it.

## Rollback

If the app misbehaves before money proofs are relied on:

1. Disable `AOL_PROOF_LEDGER_ENABLED`.
2. Restart systemd.
3. Roll back code through the normal release symlink if needed.
4. Keep `proof-ledger.sqlite` and the signing key untouched for investigation.

If money proofs have already been published:

1. Do not delete or edit `proof-ledger.sqlite`.
2. Roll back code only.
3. Publish a reconciliation proof after recovery if the app can still run.
4. Keep all old proof rows verifiable.

## Definition Of Done

1. The app starts with `AOL_PROOF_LEDGER_ENABLED=1`.
2. `/.well-known/proof-ledger-public-key.json` returns the stable Ed25519 public key.
3. `/.well-known/proof-ledger.json` shows `source_of_truth: "proof_ledger"` and a valid global chain.
4. A signed genesis row exists.
5. A signed liability checkpoint exists.
6. Agent proof MCP tools are listed.
7. `aol_get_proof_of_liabilities` returns status 200.
8. `aol_get_proof_of_reserves` returns status 200 without overclaiming.
9. Dashboard money panels read Proof Ledger projections.
10. Old JSON/JSONL files are not used as canonical accounting truth.
