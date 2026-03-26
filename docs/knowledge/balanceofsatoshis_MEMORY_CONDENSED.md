# Rebalancing & Fee Management — Agent Decision Guide

Practical decision frameworks for channel rebalancing and fee optimization, distilled from the Balance of Satoshis (bos) tool's logic and real-world operator experience.

---

## Rebalancing: Core Concept

Rebalancing moves liquidity from channels with excess outbound to channels needing outbound, by making a **circular payment to yourself** through the network. You pay routing fees to other nodes to shift your own liquidity.

**When to rebalance:**
- Channel stuck near 0% or 100% on one side → can't route in that direction
- Expected routing revenue from the channel > 2× the rebalance cost
- Recent forwarding failures due to insufficient liquidity on a productive channel

**When NOT to rebalance:**
- Channel has no forwarding activity (rebalancing idle channels wastes money)
- Rebalance cost exceeds expected weekly routing revenue
- Channel is naturally flowing toward a useful state from routing activity

---

## Key Numbers

```
MIN_REBALANCE_AMOUNT   = 50,000 sats          Smallest useful rebalance
TYPICAL_PROBE_SIZE     = 200,000 sats          Starting probe amount
MAX_PAYMENT_SIZE       = 4,294,967 sats        ~4.29M (per-part MPP limit)
MIN_INBOUND_BALANCE    = 8,590,000 sats        ~8.59M (good inbound candidate)
MIN_REMOTE_BALANCE     = 4,294,967 sats        ~4.29M (good outbound candidate)
DEFAULT_MAX_FEE_RATE   = 250 PPM               Max fee rate for rebalancing
DEFAULT_MAX_FEE        = 1,337 sats            Max total fee per rebalance
REBALANCE_CLTV_DELTA   = 144 blocks            ~1 day safety margin
```

---

## Rebalancing Decision Tree

### Step 1: Identify channels that need rebalancing

**Needs outbound liquidity** (route OUT through this channel):
- `local_balance < local_reserve + 50,000 sats`
- This channel had forwarding activity in the past 30 days
- Peer is online and active

**Needs inbound liquidity** (route IN through this channel):
- `remote_balance < 4,290,000 sats`
- This channel earns routing fees (proven demand)

### Step 2: Check if it's worth the cost

```
rebalance_cost = rebalance_amount × max_fee_rate / 1,000,000
weekly_revenue = channel_forwarding_fees_last_7_days

IF weekly_revenue > 2 × rebalance_cost:
    → Rebalance (payback < 0.5 weeks)
ELSE IF weekly_revenue > rebalance_cost:
    → Consider (payback < 1 week, marginal)
ELSE:
    → Skip (not worth the cost)
```

### Step 3: Choose amount and fee limit

- **Target**: Restore channel to roughly 50/50, or use specific target
- **Amount**: Don't rebalance more than needed — each sat costs routing fees
- **Max fee**: 250 PPM is the standard ceiling. Go lower for high-frequency rebalancing.

---

## Fee Management Strategy

### The Fee Formula

```
routing_fee = base_fee_msat + (amount_msat × fee_rate_ppm / 1,000,000)
```

Typical ranges:
- **Base fee**: 0-1000 msat (many operators set to 0)
- **Fee rate**: 1-2000 PPM (network median ~250 PPM)

### Dynamic Fee Rules

**Raise fees when:**
- Inbound liquidity is low (channel draining in one direction)
- Channel is consistently busy (high forwarding volume = demand)
- Competitors raised their fees (less price pressure)

**Lower fees when:**
- Channel is idle (no forwarding activity in 7+ days)
- Inbound liquidity is high (plenty of room, attract routing)
- You want to attract specific traffic patterns

### Fee Optimization Cycle

1. **Baseline**: Set all channels to 250 PPM
2. **Observe**: Run for 1-2 weeks, track forwarding per channel
3. **Raise**: Busy channels can absorb 500-1000 PPM
4. **Lower**: Idle channels drop to 50-100 PPM to attract traffic
5. **Repeat**: Adjust every 1-2 weeks based on data

### Conditional Fee Formulas

Fee rates can respond to channel state:
```
Low inbound → high fee:    IF(INBOUND < 1M, 2000, 500)
High inbound → low fee:    IF(INBOUND > 10M, 100, 500)
Graduated:                  IF(INBOUND > 15M, 2000, IF(INBOUND > 10M, 1000, 500))
Match competitor:           Mirror another node's fee rate
Percentage-based:           0.25% of routed amount (= 2500 PPM)
```

### Multi-Channel Peers

When you have multiple channels with the same peer, routing uses the **most expensive policy**. Set fees consistently across channels to the same peer.

---

## Channel Health Signals

### Healthy Channel
- Routes regularly (appears in forwarding history)
- Balanced liquidity (40-60% on each side)
- Active peer (online consistently)
- Peer fee rate reasonable (< 500 PPM)

### Unhealthy Channel
- No forwarding in 30+ days
- Stuck at 0% or 100% liquidity (one-sided)
- Peer offline frequently
- Peer charges excessive fees (> 2000 PPM)

**Action**: Close unhealthy channels after 60-90 days of no activity. Coop-close with low on-chain fee.

---

## Channel Evaluation

### Capacity Tiers

| Tier | Size | Use Case |
|------|------|----------|
| Micro | < 1M sats | Testing only |
| Small | 1-5M sats | Light routing, experiments |
| Medium | 5-10M sats | Standard routing |
| Large | 10-25M sats | High-volume routing |
| Whale | > 25M sats | Major routing corridors |

**Rule**: Larger channels are more capital-efficient (fewer on-chain fees per sat, less frequent rebalancing, can handle larger payments).

### Peer Quality Signals

**Good inbound peer** (sends you traffic):
- High remote balance (> 8.59M sats)
- Many active channels (well-connected)
- Reasonable fee rate (< 250 PPM)
- Regular forwarding history

**Good outbound peer** (you send traffic to):
- Low remote balance (needs liquidity → they'll route to you)
- High total capacity
- Well-connected in the graph
- Good forwarding track record

---

## Channel Closing Strategy

### ROI-Based Closing

```
routing_revenue_90d = forwarding fees earned from this channel in 90 days
capital_locked = channel capacity in sats
annual_yield = (routing_revenue_90d / 90) × 365 / capital_locked

IF annual_yield < 1%:
    → Close channel (capital is underperforming)
    → Use cooperative close with low fee
    → Redeploy capital to higher-yield peer
```

### When to Force-Close

Only when:
- Peer has been offline for weeks with no sign of return
- Channel is stuck in a broken state
- You need to recover funds urgently

**Cost**: Force-close is 3-10× more expensive than cooperative close and locks your funds for 1-2 weeks.

---

## Anti-Patterns

- **Don't rebalance every channel to 50/50** — let routing activity guide natural equilibrium, rebalance only productive channels
- **Don't set all fees to the same rate** — different channels serve different traffic patterns
- **Don't open many small channels (< 1M sats)** — each costs on-chain fees and provides negligible routing capacity
- **Don't chase every new peer** — focus on proven routers with forwarding track records
- **Don't force-close channels** — always prefer cooperative close (cheaper, faster, no fund lockup)
- **Don't rebalance without checking ROI** — every rebalance costs routing fees to other nodes

---

## Summary: The Rebalancing Economics Rule

**Only rebalance if: expected routing revenue > 2 × rebalance cost**

Everything else follows from this. If a channel doesn't earn enough to justify rebalancing, it doesn't justify the capital locked in it either — close it and redeploy.
