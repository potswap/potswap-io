---
title: Limits and policies
description: The safety limits applied before anything is signed — per-trade cap, slippage cap, daily cap, dry run, confirm, the SOL reserve and output redaction — and how they are enforced in this version.
---

Every signing path in `@potswap_io/mcp` (`swap`, `transfer`, `stake_sol` / `unstake_sol` and each strategy leg) runs the same checks **before** a transaction is built. A refused request returns an error that ends with `No funds were debited.` and nothing is signed.

## The limits

| Limit | Variable | Default | Check |
|---|---|---|---|
| Per-trade cap | `POTSWAP_MAX_TRADE_SOL` | `1` | The input's SOL-equivalent (SOL amount directly, or USD value ÷ SOL price) must not exceed the cap. Applies to `transfer` too. |
| Token allowlist | `POTSWAP_ALLOWED_TOKENS` | unset | When set, both mints of a swap, stake or strategy leg must be on the list; checked before any quote. |
| Recipient allowlist | `POTSWAP_ALLOWED_RECIPIENTS` | unset | When set, `transfer` only sends to listed addresses. |
| Slippage cap | `POTSWAP_MAX_SLIPPAGE_BPS` | `300` (3%) | A requested `slippageBps` / `maxSlippageBps` above the cap is refused. |
| Daily cap (strategies) | `POTSWAP_MAX_DAILY_SOL` | `5` | SOL-equivalent of all successful strategy legs in the current UTC day; a leg that would exceed the remainder is skipped. Resets at 00:00 UTC. |
| Active strategies | `POTSWAP_MAX_STRATEGIES` | `10` | Creating an eleventh active strategy fails. |
| SOL reserve | fixed | `0.01` SOL | Swaps that would spend below the reserve are refused: `Keep at least 0.01 SOL for fees.` |
| Positive amount | — | — | `amount` must be a positive number in UI units. |

The refusal copy names the limit and the configured value, for example:

```text
Refused by safety limit: 2 SOL ≈ 2.000 SOL is above POTSWAP_MAX_TRADE_SOL (1). No funds were debited.
Refused by safety limit: slippage 5% is above POTSWAP_MAX_SLIPPAGE_BPS (3%). No funds were debited.
Daily cap reached (5 SOL). Next legs resume at 00:00 UTC. No funds were debited.
```

When `amount` is 1,000,000 or more the per-trade refusal adds `Hint: amount is in UI units (1 = 1 SOL), not lamports.`

If no USD price is known for a non-SOL input, the SOL-equivalent cannot be computed and the per-trade and daily caps do not apply to that order; the balance check and slippage cap still do.

## Confirm

Every write tool defaults to `confirm: false`. Without `confirm: true`:

- `swap`, `stake_sol`, `unstake_sol` return `{ confirmRequired: true, quote }` and sign nothing; `transfer` returns `{ confirmRequired: true }`.
- `dca_create`, `rebalance_create`, `tpsl_create`, `limit_order_create` return `Set confirm=true to create a strategy. Nothing was created and no funds were debited.`
- `wallet_create` returns `Set confirm=true to create a wallet. Nothing was created.`

Put the confirmation step in your agent's prompt or workflow: quote first, show the human, then call again with `confirm: true`.

## Dry run

`POTSWAP_DRY_RUN=true` (also `1` or `yes`) turns every signing path into a report:

- `swap` with `confirm: true` returns `{ dryRun: true, quote }` with the text `DRY RUN, nothing signed`; `transfer` returns `{ dryRun: true }`.
- Strategy legs are logged with outcome `dry-run` and the quote they would have executed. DCA runs still count toward `totalRuns`.

Use it to watch an agent's decisions on real prices before giving it the ability to trade.

## Redaction

Everything that leaves the process passes through a redaction filter: tool text, `structuredContent`, stderr logs and the strategy state file. On wallet load the server registers every encoding of the secret (the raw value you supplied, its base58 form and its JSON byte-array form) and replaces any occurrence with `[REDACTED]`, including JSON arrays re-serialised with different whitespace. See [Key handling](/security/key-handling/).

## Strategy-specific policies

- A strategy pauses itself after **3 consecutive failed legs** with a `pausedReason`; skipped legs (caps) do not count.
- Only one process per state directory runs the scheduler (PID lock).
- Rebalance never touches an asset outside `targets`; take-profit / stop-loss never triggers on a missing price.

## The transaction validator

Since 0.7.0 every transaction is checked **before** the wallet signs it (`validateTransaction` in the SDK):

- the fee payer must be the agent wallet;
- every instruction whose program can be resolved from the message must be on the allow-list: System, Token, Token-2022, Associated Token, Compute Budget, Memo, Jupiter v6, Jupiter referral, Raydium CPMM, plus anything in `POTSWAP_ALLOWED_PROGRAMS`;
- token `Approve` / `ApproveChecked` (delegation) and `SetAuthority` are refused; `CloseAccount` may only send rent to the wallet;
- a System transfer from the wallet may only go to its own wSOL account, an allow-listed recipient, or stay under a small cap (the swap amount for aggregator orders);
- programs reached through address-lookup tables cannot be resolved offline: they are counted as `unresolved`. Aggregator orders legitimately use lookup tables for DEX programs, so they are allowed `unresolved > 0`; transactions Potswap builds itself (direct route, transfers) are checked strictly.

Refusals read `Refused by the transaction validator: <reason>. No funds were debited.` and nothing is signed.

## Idempotent operations

Pass an `opId` (4–64 characters) to `swap` and the server records the operation in `POTSWAP_STATE_DIR/operations.json`: `pending → sent → ok | failed | unknown`. Repeating a call with the same `opId`:

| Stored state | Result |
|---|---|
| `ok` | the stored result is returned with `replayed: true`; nothing is sent again |
| `failed` | a fresh attempt is made |
| `pending`, `sent`, `unknown` | refused: `Operation <id> was already sent (signature …); check get_transaction before retrying with a new opId. Funds may have been debited.` |

`unknown` is recorded when the send happened (or may have happened) but the outcome could not be read, for example when the execute call times out. `get_operation {id}` shows a record; without an id it lists recent ones. Give retrying agents a stable `opId` per intended trade so a network blip never doubles a position.

## How limits are enforced

**Limits are software-enforced in this version.** They live in the MCP server process on your machine and apply to every path that process signs. They are not enforced by the Solana runtime, by a smart wallet or by a session key. That means:

- A different program using the same keypair is not bound by them.
- A modified or compromised copy of the server could bypass them.
- They protect against an agent making a mistake or being manipulated through its prompt, not against an attacker who already has your key.

An **enforced mode** using a session-key or smart-wallet signer, where caps are checked on-chain, is a named roadmap item. Potswap will not describe limits as "enforceable" until it ships. Until then, the strongest control is the one that is already yours: a dedicated agent wallet holding only what the agent may spend.
