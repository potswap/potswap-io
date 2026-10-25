---
title: Key handling
description: How the MCP server loads, uses and protects your Solana keypair, and how to supply one safely.
---

## Supplying a key

Two environment variables, checked in this order:

| Variable | Format |
|---|---|
| `SOLANA_PRIVATE_KEY` | base58 secret key (64 bytes), base58 32-byte seed, or a JSON array of 64 integers 0–255 |
| `SOLANA_KEYPAIR_PATH` | path to a `solana-keygen` JSON keypair file (a 64-byte JSON array) |

`SOLANA_PRIVATE_KEY` wins when both are set. When neither is set the server runs read-only and every signing tool returns `Wallet not configured. Set SOLANA_PRIVATE_KEY or SOLANA_KEYPAIR_PATH. No funds were debited.`

Generate a dedicated agent keypair:

```bash
solana-keygen new --no-bip39-passphrase -o ~/.config/solana/agent.json
solana-keygen pubkey ~/.config/solana/agent.json
```

Fund that address with only what the agent should control.

### Which to prefer

- **`SOLANA_KEYPAIR_PATH`** keeps the secret out of your MCP host's config file, which is often synced or backed up. Prefer it where your host lets you reference a file path.
- **`SOLANA_PRIVATE_KEY`** is convenient for hosts whose config is the only place to set env, such as Claude Desktop. Treat that config file as a secret.

Invalid inputs fail fast at startup with one of:

```text
Private key is not valid base58 or a JSON byte array
Keypair JSON must be an array of 64 bytes
Private key has N bytes; expected 64 (or a 32-byte seed)
Cannot read keypair file at SOLANA_KEYPAIR_PATH
```

## What happens to the key in-process

1. The raw value is parsed into a `Keypair` once at startup. The secret lives only inside the wallet module's closure; the rest of the server sees a `Signer` with a `publicKey` string and a `sign(tx)` function.
2. Every encoding the secret could leak in is registered with the redaction filter: the raw string you supplied, the base58 form of the 64-byte secret and the JSON byte-array form.
3. `sign(tx)` signs a `VersionedTransaction` in memory and returns it. The server never writes the key to disk, never includes it in a request, and never logs it.

## Redaction, everywhere

All output paths pass through `redact()`:

- tool results (both the text summary and `structuredContent`),
- stderr log lines (stdout is the MCP transport and carries only protocol messages),
- the strategy state file `strategies.json` before it is written.

Any occurrence of a registered secret is replaced with `[REDACTED]`. JSON byte arrays are matched whitespace-insensitively so a re-serialised array does not slip through. This is a backstop: nothing in the normal code path puts the key in any of those places.

## What the server sends over the network

- To `POTSWAP_API`: order parameters, your **public** wallet address as `taker`, and the **signed** transaction (base64) with its `requestId`. Never the secret.
- To `SOLANA_RPC_URL`: `getBalance` and `getParsedTokenAccountsByOwner` for a public address.

## Threat model, honestly

The key is as safe as the machine and the process that hold it. The server protects against the key leaking **through its own outputs** (to the LLM, to logs, to the state file) and against the key being sent anywhere. It cannot protect against:

- malware or another user on the same machine reading the env or the keypair file,
- an MCP host that logs its environment,
- you pasting the key into a chat message.

Mitigations: a dedicated agent wallet with limited funds, file permissions on the keypair file (`chmod 600`), low caps, and `POTSWAP_DRY_RUN` while evaluating. An enforced mode with a session-key or smart-wallet signer is on the [Roadmap](/resources/roadmap/).
