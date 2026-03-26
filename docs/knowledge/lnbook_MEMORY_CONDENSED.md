# Lightning Network Strategy — Agent Decision Guide

What you need to know to make good decisions on the Lightning Network. Focused on economics, routing, and operational wisdom — not protocol internals.

---

## Channel Economics

A payment channel is a **bilateral financial relationship** backed by a 2-of-2 multisig on-chain. Both partners hold signed commitment transactions that let them exit unilaterally if needed.

**Capacity** = total bitcoin locked in the funding transaction. Public, unchanging until close.
**Balance** = how capacity is split between partners. Private, changes with every payment.
**Directionality matters**: You can only SEND up to YOUR balance. A 10M sat channel doesn't mean you can send 10M — it depends on your side's balance.

### Liquidity as Scarce Resource

- **Outbound liquidity** (your local balance): what you can send or route outward
- **Inbound liquidity** (remote balance): what you can receive or route inward
- Sending moves liquidity from your side to theirs. Receiving does the reverse.
- Channels naturally drift toward one side over time from routing activity
- **Rebalancing** = making circular payments to yourself to redistribute liquidity

### Channel Reserve (Skin in the Game)

Each partner must keep ~1% of capacity locked. This ensures you always have something to lose if you try to cheat by broadcasting old state. Without it, cheating is risk-free.

### Fee Economics

**Routing fee = base_fee + (fee_rate_ppm × payment_amount / 1,000,000)**

Why routing nodes charge fees:
- Capital locked in channels (opportunity cost)
- On-chain fees for opening/closing
- Hardware, uptime, management complexity
- Risk of force-closures

**Fee market dynamics:**
- Lower fees → more routing volume, less revenue per payment
- Higher fees → fewer payments, higher revenue per payment
- Well-connected nodes can charge premium (fewer alternative paths)
- Large channels support bigger payments (can charge lower percentage)

**Reality check**: Running a profitable routing node is hard. Many operators route for network support, not profit. Calculate ALL costs before expecting returns.

---

## Routing & Payments

### Key Distinction: Pathfinding vs Routing

**Pathfinding** = finding a POSSIBLE path through the channel graph (done by sender using gossip data).
**Routing** = actually SENDING the payment along the path (requires cooperation of all intermediaries).

A path may exist but fail to route — nodes offline, insufficient liquidity, policy rejections. This is normal.

### How Payments Move (HTLC Chain)

1. Recipient generates random secret R, computes hash H = HASH(R), puts H in invoice
2. Sender creates HTLC chain: each hop offers payment IF they can provide preimage of H
3. Each hop takes a fee: incoming HTLC > outgoing HTLC by the fee amount
4. When recipient reveals R, it propagates backward — each hop claims their incoming HTLC
5. Either ALL hops succeed or ALL fail (atomicity via hash locks + timelocks)

**Decreasing timelocks** prevent race conditions: earliest expiry at the end of the chain, latest at the start. Each node's `cltv_expiry_delta` sets how much buffer they need.

### Why Routing Fails (Normal)

- **Insufficient liquidity**: a hop lacks outbound balance in the needed direction
- **Offline node**: payment path includes a node that's down
- **Fee insufficient**: sender underestimated required fees
- **HTLC expiry too soon**: not enough time to propagate
- **Unknown payment hash**: recipient never issued that invoice

Payments commonly try 5-10 routes before success. "Instant" is aspirational — most succeed in seconds, some take longer.

### Multipath Payments (MPP)

Large payments split into smaller parts across multiple paths. All parts use the same payment hash — recipient waits for all parts before releasing preimage.

**Why MPP matters:**
- Increases success probability (smaller amounts more likely to find liquidity)
- Uses more of the network graph (channels too small for full amount can carry parts)
- Harder to surveil (payment split across paths)

### Balance Uncertainty

Only channel **capacity** is public (from the blockchain). Balance distribution is private.
- Pathfinding operates on INCOMPLETE information
- You know channels exist and their capacity, but NOT how much is on each side
- Success probability per channel: `P(a) = (capacity + 1 - amount) / (capacity + 1)`
- Multi-hop probability: multiply per-channel probabilities → exponential decay with more hops
- **Smaller payments have higher success probability**

---

## Operational Wisdom

### Channel Lifecycle

**Opening:**
- Choose partners with high uptime, good connectivity, reasonable fees
- Size channels for their purpose: 5-25M sats for routing, smaller for experiments
- Don't open for one payment — open/close is expensive on-chain
- Consider balanced allocation: some capacity for sending, some for receiving

**Keeping channels open:**
- Channels should stay open LONG-TERM. Every open/close costs on-chain fees.
- Rebalance rather than close unbalanced channels
- Monitor for: offline partners, peer policy changes, force-close threats

**Closing:**
- ALWAYS prefer cooperative close (lower fees, immediate balance, smaller tx)
- Force close costs MORE: higher fees, timelocked funds, pending HTLCs resolve on-chain
- Only force-close if partner is unresponsive or channel is permanently broken

### Fee Strategy

**Dynamic adjustment based on:**
- Channel balance (higher fee in depleted direction to discourage further drain)
- Network competition (lower fees if many alternative paths exist)
- Operational costs (ensure fees cover on-chain expenses over time)

**Practical approach:**
1. Start at network median (~250 PPM)
2. Raise fees on busy channels (high forwarding volume can absorb higher fees)
3. Lower fees on idle channels (attract routing volume)
4. Adjust every 1-2 weeks based on forwarding data

### Key Numbers

| Metric | Value | Why It Matters |
|--------|-------|----------------|
| Minimum useful channel | 1M sats | Below this, routing capacity is negligible |
| Recommended channel size | 5-25M sats | Good balance of capital efficiency and routing capacity |
| Channel reserve | ~1% of capacity | Can't spend this — it's your anti-cheat collateral |
| Max HTLCs per channel | 483 | Protocol limit; high-volume routers should monitor this |
| Default CLTV delta | 40-144 blocks | Time to claim HTLCs; lower = faster routing, higher = safer |
| Fee gossip propagation | ~1 hour | Fee changes aren't instant — takes time to reach the network |
| Force-close timelock | ~2 weeks (2016 blocks) | Your funds are locked this long on force-close |
| Max payment size (MPP) | ~4.29M sats per part | LND's per-part limit; larger payments must use MPP |

### Security Essentials

- **Watchtower problem**: You must monitor the blockchain for old commitment broadcasts (cheating). If you miss it, partner can steal funds. Timelocks (~2 weeks) give you time.
- **Penalty economics**: If you catch a cheater, you take ALL channel funds. This makes cheating irrational.
- **Probing**: Adversaries can estimate your channel balances with ~20 targeted payments per channel.
- **Channel jamming**: Attacker sends 483 tiny HTLCs, holds until timeout, makes channel unusable. Mitigate with minimum HTLC sizes and rate limiting.

### Network Topology

- **Power-law distribution**: Few highly-connected hubs, many peripheral nodes
- **Preferential attachment**: New nodes open to well-connected nodes (maximize routing reach)
- **Your graph is always incomplete**: Private channels, stale data, gossip delays
- **Capacity ≠ liquidity**: A 10M sat channel might have 9M on one side

---

## Decision Frameworks for Agents

### When to Open a Channel
- Target peer has high uptime and many active channels
- Target peer routes traffic you want to capture (geographic, volume-based)
- Your node needs connectivity in that direction
- Channel size: 5M+ sats for routing, match or exceed target peer's median channel size

### When to Close a Channel
- No forwarding activity in 60+ days
- Peer offline frequently or permanently
- Peer charges excessive fees (>2000 PPM) with no volume
- Channel capacity needed elsewhere (close idle, reopen productive)

### When to Rebalance
- Channel stuck at 0% or 100% on one side (can't route)
- Expected routing revenue exceeds rebalance cost by 2x+
- Rebalance fee should be < 50% of expected weekly routing revenue from that channel

### When to Adjust Fees
- Low inbound liquidity → raise fees (discourage further drain)
- High inbound liquidity → lower fees (attract outbound routing)
- Channel consistently busy → raise fees (capture demand)
- Channel consistently idle → lower fees (attract any routing)
