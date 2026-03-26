# Alex Bosworth's Run-LND Guide — Condensed Reference

Source: [`alex_bosworth_writings/run-lnd-guide.md`](alex_bosworth_writings/run-lnd-guide.md) (18KB)
Author: Alex Bosworth (creator of Balance of Satoshis, prolific Lightning routing node operator)

This guide is a practical setup reference for running LND on a cloud instance (EC2/Ubuntu). Most of the content is installation commands (Bitcoin Core, Go, LND, Tor, `bos`). The highest-value content for our use case is the **recommended LND configuration** — a production-ready `lnd.conf` from an experienced routing node operator, with commentary explaining each choice.

---

## Infrastructure Requirements

- **Instance**: EC2 T4 Micro or better
- **Ports**: 9735 (P2P), 10009 (gRPC)
- **Disk**: 25 GB+ for LND; 900 GB for full Bitcoin Core with txindex (use gp3 on AWS)
- **File descriptors**: Increase to `fs.file-max=512000` for public instances
- **Network hardening**: SYN flood protection via iptables rate limiting (1/s burst 3)

## Recommended LND Configuration (Production Routing Node)

This is the core high-value content — a field-tested `lnd.conf` with operator reasoning. Our node (`boom`) can compare against these settings.

### Application Options

| Flag | Value | Why |
|------|-------|-----|
| `accept-keysend` | 1 | Accept push payments (spontaneous sends without invoice) |
| `allow-circular-route` | 1 | Required for rebalancing — allows payments that route through your own node |
| `coop-close-target-confs` | 1000 | Low-priority fee for cooperative closes (saves on-chain fees, ~1 week confirm target) |
| `debuglevel` | CNCT=debug,CRTR=debug,HSWC=debug,NTFN=debug,RPCS=debug | Verbose logging for connection, channel router, HTLC switch, chain notifications, RPC |
| `gc-canceled-invoices-on-the-fly` | 1 | Auto-delete unpayable canceled invoices (reduces DB bloat) |
| `ignore-historical-gossip-filters` | 1 | Skip syncing old gossip data on startup (faster startup, less bandwidth) |
| `max-channel-fee-allocation` | 1.0 | Allow 100% of channel value for commitment fees (prevents force-close failures on fee spikes) |
| `max-cltv-expiry` | 5000 | Maximum timeout blocks for payments (~35 days). Limits exposure to stuck HTLCs |
| `max-commit-fee-rate-anchors` | 100 | Allow high commitment fee rates on anchor channels (prevents force-close failures) |
| `maxpendingchannels` | 10 | Allow up to 10 channels opening simultaneously |
| `minchansize` | 5000000 | Reject inbound channels smaller than 5M sats (~$2,500). Prevents dust channels |
| `no-backup-archive` | true | Don't archive old channel backups (saves disk) |
| `stagger-initial-reconnect` | 1 | Spread out peer reconnections on startup (avoids thundering herd) |
| `tlsautorefresh` | 1 | Auto-regenerate TLS cert when it expires or details change |
| `tlsdisableautofill` | 1 | Don't include IPs in TLS cert (privacy, avoids cert changes when IP rotates) |

### Bitcoin Options

| Flag | Value | Why |
|------|-------|-----|
| `bitcoin.defaultchanconfs` | 2 | Only 2 confirmations to consider a channel open (faster than default 3) |
| `bitcoin.feerate` | 1000 | Default forwarding fee rate: 1000 ppm (0.1%). Starting point for routing fees |
| `bitcoin.minhtlc` | 1 | Minimum HTLC size: 1 msat. Accept all payment sizes |
| `bitcoin.timelockdelta` | 144 | CLTV delta: 144 blocks (~1 day). Time to claim HTLCs before upstream timeout |

### Database Options

| Flag | Value | Why |
|------|-------|-----|
| `db.bolt.auto-compact` | true | Compact the database on restart (prevents DB growth over time) |
| `db.no-rev-log-amt-data` | true | Don't store revocation log amount data (saves space, only needed for watchtowers) |

### Gossip Options

| Flag | Value | Why |
|------|-------|-----|
| `gossip.msg-rate-bytes` | 1024000 | Rate limit gossip to ~1 MB/s (prevents bandwidth abuse) |
| `gossip.msg-burst-bytes` | 2048000 | Allow burst up to ~2 MB/s |

### Protocol Options

| Flag | Value | Why |
|------|-------|-----|
| `protocol.wumbo-channels` | 1 | Enable large channels (>16M sats). Required for serious routing |
| `protocol.option-scid-alias` | true | Hide real channel IDs from forwarded payments (privacy) |

### Router Options (Mission Control Tuning)

These control how LND's pathfinding evaluates routes. Critical for routing node performance.

| Flag | Value | Why |
|------|-------|-----|
| `routerrpc.apriori.hopprob` | 0.5 | Default 50% chance a hop succeeds (before any data). Conservative starting estimate |
| `routerrpc.apriori.weight` | 0.75 | Weight of historical failures — at 0.75, nodes with many failures get deprioritized. Set to 1.0 to disable learning |
| `routerrpc.attemptcost` | 10 | Fixed cost (in sats) assigned to each payment attempt. Higher = prefer fewer attempts over cheaper routes |
| `routerrpc.attemptcostppm` | 10 | Variable cost per attempt (in ppm). Same tradeoff as above, scaled by payment size |
| `routerrpc.maxmchistory` | 10000 | Store up to 10K routing history records for mission control |
| `routerrpc.minrtprob` | 0.005 | Minimum 0.5% success probability to even try a route. Lower = more aggressive exploration |
| `routerrpc.apriori.penaltyhalflife` | 6h | Forget half of a routing failure's penalty after 6 hours. Balances memory with forgiveness |

### Routing Options

| Flag | Value | Why |
|------|-------|-----|
| `routing.strictgraphpruning` | 1 | Remove channels where one side hasn't announced. Cleans zombie/abandoned channels from graph |

### Tor Options

| Flag | Value | Why |
|------|-------|-----|
| `tor.active` | 1 | Enable Tor |
| `tor.v3` | 1 | Use v3 onion addresses (longer, more secure) |
| `listen` | localhost | Only listen on localhost when using Tor (no clearnet exposure) |

## Operational Patterns

### Wallet Password Management
- Generate random password: `openssl rand -hex 21 > ~/.lnd/wallet_password`
- Auto-unlock on boot via `wallet-unlock-password-file` config flag (add after wallet creation)

### Service Management
- Uses `nohup` + crontab `@reboot` for auto-start (alternative: systemd)
- Separate error log: `~/.lnd/err.log`
- Symlink log files to home directory for easy access

### Bitcoin Core Configuration for LND Backend
- `txindex=1` required for LND (transaction lookup)
- ZMQ publishing on ports 28332 (blocks) and 28333 (transactions)
- `disablewallet=1` since LND manages its own wallet
- `listen=0` if not serving other Bitcoin peers
- `dbcache=3000` (~50% of available RAM for faster IBD)

### Bootstrapping a New Node
- Connect to known peers first: `lncli connect <pubkey>@<ip>:<port>`
- Open initial channel to bootstrap network connectivity
- Minimum recommended first channel: 5M sats (mainnet)
- Fund wallet via `bos chain-deposit`

## Key Takeaways for Agent Decision-Making

1. **`minchansize=5000000`** — Reject tiny inbound channels. Our agents should consider this threshold when evaluating channel open proposals.
2. **`bitcoin.feerate=1000`** — Default 1000 ppm is just a starting point. Agents should adjust per-channel based on demand.
3. **`coop-close-target-confs=1000`** — Cooperative closes can use very low fees. Agents should prefer cooperative over force close when possible.
4. **`max-channel-fee-allocation=1.0`** and **`max-commit-fee-rate-anchors=100`** — These prevent force-close failures during fee spikes. Safety-critical settings.
5. **Mission control tuning** — The `routerrpc.apriori.*` settings directly affect routing success rates. Agents analyzing forwarding failures should understand these parameters.
6. **`routing.strictgraphpruning=1`** — Means the graph data our visualization renders is cleaner (no zombie channels with one-sided announcements).
7. **`ignore-historical-gossip-filters=1`** — Our node doesn't sync old gossip, so the graph snapshot may miss very old announcements. Agents should be aware of this when analyzing network age data.
