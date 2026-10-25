---
title: How routing works
description: Potswap quotes every order through Jupiter Swap V2 meta-aggregation, where Metis, JupiterZ, DFlow and OKX compete and the best net route wins.
---

Potswap does not run its own router today. Every quote and swap goes through **Jupiter Swap V2**, Jupiter's meta-aggregation layer, via Potswap's hosted proxy (`POTSWAP_API/api/jup/*`). The proxy adds Potswap's Jupiter API key server-side so you never need one, and injects nothing else into the route.

## The routers that compete

On each order, Jupiter Swap V2 asks several routers for a route and returns the best one:

| Router | What it is |
|---|---|
| **Metis** | Jupiter's own on-chain aggregation across Solana AMMs and order books. |
| **JupiterZ** | Jupiter's RFQ (request-for-quote) system, where market makers quote directly; off-chain pricing, MEV-protected fills. |
| **DFlow** | A third-party router integrated into Swap V2. |
| **OKX** | OKX's DEX aggregator, integrated into Swap V2. |

The response names the winner in `router`, and both `get_quote` and `swap` return it so your agent can log which router filled the order.

## What "best route" means

Jupiter ranks candidate routes by the output amount the taker receives for the given input, after the platform fee is applied to the order. Potswap passes its fee (`referralAccount` + `referralFee`) on the order request, so the `outAmount` you see is net of the Potswap fee and of the route's own costs. There is no separate comparison step on the Potswap side in this version; the router that returns the most output wins.

What you can rely on:

- `outAmount` is what you receive if the transaction lands within slippage.
- `priceImpactPct` is the route's own impact estimate.
- `slippageBps` is the slippage the route was built with; omit `slippageBps` on the request to let Jupiter choose automatically, or set it (up to `POTSWAP_MAX_SLIPPAGE_BPS`).
- `expiresAt` is the order's expiry; `swap` always fetches a fresh order right before signing, so the quote you inspected is never the one that executes unchanged.

## The swap path

1. **Quote** — `GET /api/jup/swap/v2/order` with `inputMint`, `outputMint`, raw `amount`, optional `slippageBps`, and Potswap's `referralAccount` / `referralFee` for the tier the [fee schedule](/routing/fees/) selected.
2. **Limits** — `POTSWAP_MAX_TRADE_SOL`, `POTSWAP_MAX_SLIPPAGE_BPS`, balance and the 0.01 SOL reserve are checked. A refusal happens here, before anything is signed.
3. **Fresh order as taker** — the order is fetched again with the agent wallet as `taker`, which returns a serialized `VersionedTransaction`.
4. **Local signature** — the transaction is signed in-process with your keypair.
5. **Execute** — `POST /api/jup/swap/v2/execute` with the signed transaction and `requestId`. Jupiter lands it and reports the result.

Every step that fails returns a message stating whether funds were debited.

## Rate limits

Potswap's proxy uses Jupiter's free tier (one request per second, shared). The server retries a `429` or `503` once after 1.1 s, then returns `Potswap is busy; retry in a few seconds. No funds were debited.` Token lists from `get_trending` are edge-cached for 15 s.

## What is not here yet

Direct DEX adapters (Raydium, Orca, Meteora) as a fallback or comparison to Jupiter, a net-of-fee "saved vs X" comparison, and simulate-before-sign are specified but not built. See [Direct DEX routing (roadmap)](/routing/direct-dex-roadmap/).
