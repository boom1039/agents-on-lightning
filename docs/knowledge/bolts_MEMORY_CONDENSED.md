# Lightning Protocol Essentials — What Agents Need to Know

The Lightning protocol (BOLTs) defines how channels work, payments flow, and the network communicates. This is the subset relevant to agents making decisions on the Lightning Observatory platform.

---

## Channel Lifecycle

### Opening a Channel

1. **Negotiation**: Both nodes exchange parameters (capacity, reserve, fees, HTLC limits)
2. **Funding**: Channel opener creates a 2-of-2 multisig transaction on-chain
3. **Confirmation**: After mining (typically 3-6 blocks), the channel becomes usable
4. **Announcement**: Both nodes sign a `channel_announcement` message → gossip propagates it to the network

**Key parameters negotiated at open:**
- `funding_satoshis`: Total channel capacity
- `channel_reserve_satoshis`: Minimum balance each side must keep (~1% of capacity)
- `to_self_delay`: Timelock on your funds if you force-close (typically 144-2016 blocks)
- `max_htlc_value_in_flight_msat`: Maximum total value of pending HTLCs
- `max_accepted_htlcs`: Maximum concurrent HTLCs (protocol max: 483)
- `dust_limit_satoshis`: Below this, outputs aren't created on-chain

**Zero-conf channels**: Usable before mining confirmation. Requires trust — the funder could double-spend. Only used between trusted parties.

### Closing a Channel

**Cooperative close** (preferred):
- Both parties negotiate a closing transaction
- Funds immediately available (no timelock)
- Lower on-chain fees
- Can negotiate fee rate

**Force close** (unilateral):
- One party broadcasts their commitment transaction
- Broadcaster's funds locked for `to_self_delay` blocks (1-2 weeks typical)
- Non-broadcaster gets funds immediately
- Any pending HTLCs resolve on-chain (expensive)
- Higher fees due to larger transaction

**Breach close** (cheating detected):
- Partner broadcasts an OLD commitment transaction
- Honest party detects it and claims ALL channel funds via penalty transaction
- Cheater loses everything

### Channel States

| State | Meaning |
|-------|---------|
| `active` | Online, operational, can route payments |
| `inactive` | Peer disconnected but channel still open |
| `pending_open` | Funding tx broadcast, waiting for confirmations |
| `pending_close` | Close initiated, waiting for on-chain confirmation |
| `force_closed` | Unilateral close broadcast |
| `breach_close` | Penalty claimed against cheating partner |

---

## Payment Mechanics (HTLCs)

### How an HTLC Works

An HTLC (Hash Time-Locked Contract) says: "I'll pay you X sats IF you can show me the preimage of hash H, BEFORE block height N."

**Adding an HTLC to a channel:**
1. Sender sends `update_add_htlc` with amount, payment hash, expiry
2. Both sides create new commitment transactions including the HTLC output
3. Both sides exchange signatures and revoke old commitments

**Settling an HTLC:**
1. Receiver reveals preimage R (where HASH(R) = H)
2. Both sides create new commitments WITHOUT the HTLC, balances updated
3. Old commitments revoked

**Failing an HTLC:**
- If preimage not provided before expiry, HTLC times out
- Funds return to sender

### Multi-Hop Payment Flow

For Alice → Bob → Chan → Dina:
- Alice's HTLC to Bob: 1,000,100 msat, expires block 500
- Bob's HTLC to Chan: 1,000,050 msat, expires block 450
- Chan's HTLC to Dina: 1,000,000 msat, expires block 400

Each hop deducts their fee. Expiries DECREASE along the path (prevents race conditions on failure).

### Commitment Transactions

Each partner holds a DIFFERENT commitment transaction:
- **Your version**: pays partner immediately, pays YOU after timelock
- **Partner's version**: pays you immediately, pays THEM after timelock

The broadcaster must wait (giving the other party time to catch cheating). This asymmetry is the enforcement mechanism.

---

## Fee Structure

### The Fee Formula

```
routing_fee = base_fee_msat + (amount_msat × fee_rate_ppm / 1,000,000)
```

Each channel direction has its own fee policy. Fees are set by the node controlling the OUTBOUND direction of that channel.

### Fee Propagation

When you change fees, the update propagates via gossip:
1. Node signs a new `channel_update` message
2. Peers forward it to their peers
3. **Full network propagation: ~1 hour typical**
4. Stale updates (>2 weeks old with no refresh) cause channel pruning from the graph

### HTLC Limits

Each channel direction advertises:
- `htlc_minimum_msat`: Smallest payment accepted (typically 1 msat)
- `htlc_maximum_msat`: Largest single HTLC accepted
- Max 483 concurrent HTLCs per channel (protocol limit)

---

## Gossip Protocol — How the Network Graph Works

### Three Message Types

1. **`channel_announcement`**: Proves a channel exists (references on-chain funding tx). Contains capacity.
2. **`channel_update`**: Fee policy, timelock delta, min/max HTLC, enabled/disabled. Two per channel (one per direction).
3. **`node_announcement`**: Node exists, with alias, addresses, features. Must have at least one public channel.

### What's Known vs Private

| Known (public) | Private |
|---------------|---------|
| Channel capacity | Balance distribution |
| Fee policies | Payment amounts |
| Node connections | Unannounced channels |
| Node uptime (inferred) | Payment sender/receiver |

### Graph Quality Issues

- **Zombie channels**: Both nodes offline, channel still in graph. Can't route but pathfinding might try.
- **Stale updates**: Channels with no update in 2 weeks get pruned from graph.
- **Incomplete view**: Each node builds its own graph from gossip — no "canonical" graph exists.
- **Private channels**: Never announced, invisible to the network. Can still route if sender knows about them via invoice routing hints.

---

## Failure Modes Agents Should Recognize

### From API Responses

| Signal | What It Means | Agent Action |
|--------|--------------|--------------|
| Channel `active: false` | Peer disconnected | Wait or close if chronic |
| `local_balance` near zero | Can't route outbound | Rebalance or accept inbound-only |
| `remote_balance` near zero | Can't receive | Lower fees to attract inbound routing |
| Force-close in channel list | Funds locked for weeks | Monitor, don't panic |
| High `num_updates` | Very active channel | Good candidate for fee optimization |
| `commit_fee` rising | On-chain fees high | Avoid opening/closing channels now |

### Timing Expectations

| Event | Typical Duration |
|-------|-----------------|
| Channel open (confirmations) | 30-60 minutes (3-6 blocks) |
| Fee update propagation | ~1 hour via gossip |
| Cooperative close | 10-60 minutes (1-6 blocks) |
| Force-close fund release | 1-2 weeks (144-2016 blocks) |
| HTLC timeout | Hours to days (depends on CLTV delta) |
| Payment attempt | Milliseconds to seconds per attempt |

---

## Channel Types

| Type | Feature | Status |
|------|---------|--------|
| **Legacy** | Original commitment format | Deprecated |
| **Anchor** | Both sides can fee-bump | Current default |
| **Zero-conf** | Usable before mining | Trust-based, opt-in |
| **Taproot** | Schnorr signatures, cooperative closes look like normal payments | Experimental |
| **Wumbo** | Channels >0.16 BTC | Opt-in via feature bits |

---

## Privacy Model

- **Onion routing**: Each hop only sees previous hop and next hop. No intermediary knows the full path.
- **Source routing**: Sender chooses entire path — intermediaries don't make routing decisions.
- **Balance probing**: Adversaries can discover channel balances with ~20 targeted payment attempts per channel (binary search).
- **Channel jamming**: 483 tiny HTLCs can lock a channel for hours. No complete solution yet — mitigate with min HTLC sizes.
