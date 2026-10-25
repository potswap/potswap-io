---
title: Points and POT
description: How the fee you pay becomes POT points today, and the specified economy around the POT token — Season 0 launch pool, 30-day seasons, reward balances with claim-now and limit claims, staking and burn.
---

:::note[Status]
The **points and economy engine** is built, tested and deployed: fee paid → points, Season 0 airdrop replay, 30-day season budgets, round-trip dampening, weights and levels, reward balances, claim intents and ladder, launch meter. It reports `enabled: false` from `get_points` / `get_leaderboard` until Potswap switches on the points database, and the meter shows 0 / 500 SOL until the pool address is published. **No token exists yet.** The token launch, the claims worker and the on-chain claim and staking programs, the burn and governance votes are the remaining pieces and are marked below.
:::

## Points today (built, pending activation)

- **Reward basis.** The Potswap fee a wallet pays in an epoch, valued in USD at swap time. `swap` and every strategy leg return `feeUsd` and `pointsAdded`; they are equal when the fee is configured. Agents earn exactly like humans.
- **Epoch.** One UTC day, 00:00–23:59:59.
- **Daily split.** Each closed epoch allocates its POT budget across wallets by `fee^1.1 / Σ fee^1.1`, capped at **10%** of the epoch per wallet, with the excess redistributed pro rata among uncapped wallets. The exponent means splitting one wallet into two earns less, not more.
- **Snapshots.** Each closed epoch publishes allocations and a deterministic Merkle root (`/api/epochs/:n`) for a Merkle-distributor claim.
- **Unlock.** An epoch becomes claimable 7 days after it closes, or 7 days after the token launch for epochs before the token exists.
- **Dust.** Swaps whose fee basis is below $0.005 are ignored.
- **No fee, no points.** A swap that carries no Potswap fee (fee not configured, or a third-party client that omits it) earns 0 points. Failed transactions earn 0.

What `get_points` returns once enabled: points this epoch, points all-time, POT allocated (closed epochs), POT claimable, next unlock date. `get_leaderboard` returns the top wallets by fee paid.

The budget per epoch under the original Season 1 plan was **666,666 POT/day**; the seasons model below replaces that figure (Season 1 ≈ 667k/day, declining per season) while keeping the same daily mechanics.

## The POT economy (P12)

### Season 0 — the launch pool

- 60% of each net fee (net = after Jupiter's 20%) moves to a published **launch-pool address**. The **launch meter** shows the pool balance against its target of **500 SOL**, read from chain. See [Launch meter](/economy/launch-meter/).
- When the pool reaches 500 SOL a scripted, auditable launch runbook executes: mint 1,000,000,000 POT, revoke the mint authority, seed a Meteora / Raydium pool with 20% of POT plus all pool SOL, lock the LP, publish the Season 0 Merkle snapshots, start Season 1.
- **No deposits, presales or contributions** are accepted from anyone; the only inflow is protocol fees.
- **Season 0 airdrop (25% of supply):** day *k* of the pool period receives a slice proportional to that day's share of total fee basis; within the day wallets split by the daily rule above; day *k* unlocks at launch + *k* days as a Merkle claim.

### Token allocation (at launch)

| Allocation | Share | Rule |
|---|---|---|
| Launch LP | 20% | paired with all launch-pool SOL, LP locked |
| Season 0 airdrop | 25% | day-by-day replay of the pool period |
| Reward emissions | 30% | 120M trading seasons + 180M (plus rollovers) staking |
| Governance treasury | 10% | grants, listings, Season 13+ |
| Team | 15% | 24-month linear vest, 6-month cliff |

### Fee split after launch

| Net fee | Season 0 | Seasons 1+ |
|---|---|---|
| Launch pool | 60% | — |
| User reward balances | 20% | 20% |
| Buy-and-burn | — | 30% |
| Team & operations | 20% | 50% |

### Reward balances: claim now or limit claim

- Each wallet accrues a **reward balance** equal to 20% of its net fees, in SOL, credited when the swap is priced. It is a POT purchase budget, never claimable as SOL, and never expires. It appears as `rewardBalanceSol` in `get_points` and on `/app/earnings`.
- After launch, **Claim POT** buys POT on the market with the wallet's balance (routed through Potswap's own aggregator with a slippage cap) and sends the POT to the wallet. Claims are user-initiated, rate-limited per wallet, and may be **partial**. Timing claims — buying on dips — is the intended game.
- **Limit claims:** convert up to N SOL of balance when POT ≤ price P; cancellable, optional expiry, partial fills, filled oldest-first and never above P.
- Public stats: the **total unclaimed balance** (`unclaimedSol`) and the **pending claim ladder** by price band (no wallets, `claimLadder`) in `/api/stats` and `get_launch_status`.
- `POST /api/claims` records a claim intent signed by the wallet (Ed25519 over a JSON message with `wallet`, `ts`, `action: claim | cancel`, `kind`, `amountSol`, `maxPriceUsd`, `expiresAt`); it returns 503 until the launch date, limits each wallet to one new claim per minute and 10 open claims, and never reserves more than the free balance. `GET /api/claims?wallet=…` lists a wallet's balance and claims.
- v1 executes claims through a claims worker with a limited hot wallet refilled daily from the multisig; a trustless on-chain claim program (user-signed claim → swap by CPI → POT to user) is the first on-chain deliverable after launch.

### Seasons 1+ (30 days each)

- Season *n* budget: `20M × 0.85^(n−1)` POT for n = 1…12 (Season 1 ≈ 667k/day), distributed by the daily epoch mechanism with the 10% cap.
- **Round-trip dampening:** a swap that reverses one from the same wallet within 10 minutes earns 25% points.
- **Weights:** points = fee basis × season weights, each 1.0–2.0×, product capped at 2×. Season 1 has base weights only; Season 2 adds consumed observations; Season 3 adds strategy legs and POT/SOL LP; later seasons may add referrals and new protocols.
- Anything undistributed (caps, empty epochs, dust) rolls to the staking pool.
- **Levels** from all-time fee basis (Larva → Bee → Queen) persist across seasons with a permanent multiplier ≤ 1.25×; season leaderboards reset, the all-time board stays.
- From Season 2, POT holders vote each season's weights, the fee (50–255 bps), the fee split (each slice 20–50%) and the budget (50–125% of formula).

### Staking (live with the token)

- Locks of 30 / 90 / 180 days at weights 1.0 / 1.5 / 2.0×.
- Rewards stream daily from the staking pool (180M plus rollovers over 36 months, ≈165k/day at the start) pro rata by staked × weight; claimable any time; principal unlocks at lock end.
- Staking at least `stakerMinPot` unlocks the **staker fee tier** (−100 bps). See [Fees](/routing/fees/).

### Burn

After launch, 30% of every net fee buys POT and burns it within the epoch at randomized times; burns are reported in `/api/stats`.

## MCP surface

`get_points` returns `rewardBalanceSol`, `level` and `season`; `get_launch_status` returns the meter, split, unclaimed balance and claim ladder (both since 0.4.0). `claim_pot`, `stake_pot` and `unstake_pot` arrive with the token. See the [Roadmap](/resources/roadmap/).
