# keeper

Composes the non-custodial recurring buy into a single transaction and submits it:

```
[ ensure transient ATA ] [ native transfer_recurring (pull) ] [ swap route ] [ execute_buy ]
```

`RecurringBuyKeeper` (see [`keeper.ts`](./keeper.ts)) is a **trigger, not a custodian**: it signs and pays fees, but the on-chain program bounds every account it can touch. It cannot redirect a user's funds, over-pull (the native subscription caps that), or underprice the buy (the router's `min_out` floor caps that).

## Two pluggable legs

| Leg | localnet / tests | devnet / mainnet |
|-----|------------------|------------------|
| **pull** | a faucet mint into the transient stands in for the native program (not deployed on localnet) | `buildNativePull` → the audited `@solana/subscriptions` `transfer_recurring`, receiver = `transientUsdc(user)` |
| **swap** | `buildMockSwap` (deterministic) | `buildJupiterSwap` → a Jupiter route USDC→target, output to the user's own ATA |

The router forwards **one** swap instruction under the transient PDA's signature and verifies the outcome, so the keeper never has to be trusted about the route.

## Proven vs pending

- **Proven (localnet):** the composition + `execute_buy` path is exercised end-to-end in [`../tests/recurring-buy.ts`](../tests/recurring-buy.ts) ("keeper composes and lands a buy") through the mock venue.
- **Pending (devnet, needs SOL + the native program):** wiring `buildNativePull` to the real subscription, and verifying that a real Jupiter route CPI'd under the PDA signer fits in one transaction (see [`../SPEC.md`](../SPEC.md) §11). Jupiter routes need address lookup tables; resolve `addressLookupTableAddresses` and pass them to `composeAndSend({ luts })`.

## Usage sketch

```ts
const keeper = new RecurringBuyKeeper(program, { usdcMint, targetMint });
const swap = await keeper.buildJupiterSwap({ user, amountIn, slippageBps: 50 });
const pull = keeper.buildNativePull({ user, delegatee, nonce, amount });
const exec = await keeper.buildExecuteBuy({ user, keeper: payer.publicKey, minOut, swap });
await keeper.composeAndSend({
  connection, payer,
  ixs: [keeper.ensureTransientIx(user, payer.publicKey), pull, exec],
  luts: swap.luts,
});
```
