---
title: Fees
description: The Potswap fee schedule — 2.5% standard, 1% at or above $1,000, a staker discount later — how it is charged inside the swap, and how it becomes POT points.
---

Potswap charges an integrator fee inside each swap through Jupiter's referral program. The fee is deducted from the order on-chain; there is no separate payment. Observations and all read-only tools are free.

## The schedule

One pure function, shared by the web app and the MCP server, picks the fee for each order from a schedule served by `GET /api/config`:

| Tier | Condition | Fee | `feeLabel` |
|---|---|---|---|
| Standard | input value below $1,000 | 250 bps (2.5%) | `2.5%` |
| Size | input value at or above $1,000 | 100 bps (1%) | `1% (size tier)` |
| Staker | wallet stakes at least `stakerMinPot` POT | −100 bps on the tier above, never below 50 bps | `1.5% (staker)` or `0.5% (staker)` |

The input value is the USD value of the input amount at quote time. When no price is known the standard tier applies. Jupiter allows referral fees between 50 and 255 bps, so every result is clamped to that range.

**Staker tier status:** the discount exists in code but is disabled until the POT token launches. `stakerMinPot` is `null` until then, so no discount is applied today. See [Points and POT](/economy/points-and-pot/).

### Defaults

```ts
{
  standardBps: 250,
  sizeBps: 100,
  sizeThresholdUsd: 1000,
  stakerDiscountBps: 100,
  stakerMinPot: null
}
```

The MCP server reads the live schedule from `/api/config` (cached 5 minutes) and falls back to these defaults field by field.

## Where the fee goes

Of every fee collected, **Jupiter keeps 20%**. What remains is Potswap's net fee.

| Net fee | Season 0 (pre-launch) | Seasons 1+ |
|---|---|---|
| Launch pool (future LP SOL) | 60% | — |
| User reward balances | 20% | 20% |
| Buy-and-burn POT | — | 30% |
| Team & operations | 20% | 50% |

`GET /api/config` returns the split in force as `splits` (and `burnShare`), switching from the Season 0 row to the Seasons 1+ row at the launch date. The split governs how the referral accounts are swept by the daily treasury job; until the launch-pool address is published no fees are swept.

## Fee is off until configured

The fee is only added when Potswap's referral account is configured on the server. When it is not, orders carry no `referralAccount`, `get_quote` returns `feeBps: 0` with `feeTier: null`, and `swap` returns `pointsAdded: 0`. The quote still shows `scheduledFeeBps` (what the tier *would* be) so clients can display the schedule consistently.

## Points equal fee paid

The fee basis you pay, in USD at swap time, is credited to the trading wallet as POT points. A discounted swap earns proportionally fewer points. `swap` and every strategy leg return `feeUsd` and `pointsAdded`; `pointsAdded === feeUsd` whenever the fee is configured. Details, including the daily split and the 10% cap, are on [Points and POT](/economy/points-and-pot/).

## Third-party clients

A client that sends Potswap's referral account with a lower `referralFee` simply pays less and earns fewer points. Nothing else is enforced.
