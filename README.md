# try-x402

Pay a real HTTP 402 endpoint from your terminal, in about a minute.

```
npx try-x402 --dry-run
```

That reads the payment terms and pays nothing. Drop `--dry-run` to actually pay.

Paying for real needs a wallet that already holds USDC:

```
export X402_KEY=0xyour_private_key
npx try-x402
```

Without a key it generates a throwaway wallet, which by definition has no money, so
it will tell you that and stop rather than wait around.

![try-x402 reading the payment terms of a live x402 endpoint](https://raw.githubusercontent.com/webmilmind1/try-x402/main/demo.gif)

## Safety

This signs authorizations that move real money, so it refuses rather than trusts:

- **It only pays USDC.** If a server quotes a different token, it stops. The EIP-712
  domain is built entirely from a local table, so a server cannot choose which
  contract your signature binds to.
- **There is a price ceiling.** `1` USDC by default, `--max-price` to raise it. Without
  one, the only check is whether you can afford the amount, which a hostile endpoint
  satisfies by quoting exactly your balance.
- **Signed authorizations expire in 10 minutes**, however long the server asks for.
- **Unknown flags are fatal**, and `--flag=value` works. A silently ignored `--dry-run`
  is a silent payment.

Use a throwaway wallet anyway. The tool generates one if you have no key.

## What this is

[x402](https://x402.org) is an open standard where a server answers `HTTP 402 Payment
Required` with machine-readable terms, the client pays in stablecoin, and the request
succeeds. No account, no API key, no subscription. It exists so software can buy things
without a human filling in a signup form.

Trying it normally means writing a client first, which is where most people stop. This is
that client, as one command.

It works against **any** x402 server. It defaults to
`https://deskcrew.io/api/x402/paid/ping` (a [DeskCrew](https://deskcrew.io/agents) demo
endpoint) because we maintain it and it costs two cents, but `--url` points it anywhere.

## Usage

```bash
npx try-x402 --dry-run                       # read the terms, pay nothing
npx try-x402                                 # pay the default demo endpoint (0.02 USDC)
npx try-x402 --url https://example.com/paid  # any x402 server
npx try-x402 --json                          # machine-readable, for agents
npx try-x402 --chain polygon                 # pick a chain the server accepts
npx try-x402 https://api.example/tool '{"arg":"value"}'   # send a JSON body
```

## For AI agents

`--json` emits a stable object, so an agent can run this and parse the result:

```json
{
  "wallet": "0x...",
  "dialect": "v1",
  "network": "base",
  "priceUsdc": "0.02",
  "payTo": "0x...",
  "settled": true,
  "tx": "0x...",
  "spentUsdc": "0.02",
  "ok": true
}
```

## Wallets and safety

- Run it with no key and it **generates a throwaway wallet**, prints the address, and
  waits for you to fund it. Export `X402_KEY` to reuse one.
- **Use a throwaway wallet.** This is a demo tool. Never put a key here that controls
  anything you would miss.
- The key is read from the environment or generated in memory. It is never written to
  disk, and it never leaves your machine except as a signature.
- You need **USDC but no native gas token**. Payment is an EIP-3009 authorization the
  server broadcasts and pays gas for.

The whole tool is one file, `cli.mjs`, with viem as its only dependency. Anything that
asks for a private key should be short enough to read before you run it. Please read it.

## Supported chains

Base, Polygon, Avalanche, Sei, and Base Sepolia for testing. It picks a chain the server
accepts and that it knows how to pay on, or you can force one with `--chain`.

Both protocol dialects are handled: v1 (terms in the response body, paid with
`X-PAYMENT`) and v2 (terms on the `PAYMENT-REQUIRED` header, paid with
`PAYMENT-SIGNATURE`). You do not have to know which one a server speaks.

## License

MIT
