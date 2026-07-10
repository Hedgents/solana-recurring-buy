# solana-recurring-buy

**Non-custodial recurring buy (DCA) for Solana.** Open-source infrastructure that turns Solana's native [Subscriptions & Allowances](https://github.com/solana-foundation) recurring *pull* into a recurring *buy*: every period, a user-capped amount of USDC is pulled, atomically swapped to a target asset, and delivered to the user's **own** wallet. The operator never pools, holds, or custodies user funds.

Status: **design / devnet-first, pre-audit.** See [`SPEC.md`](./SPEC.md).

## Why

- Solana's native subscription rail does recurring **payments** (pull a token to a receiver).
- Jupiter DCA does scheduled buys, but **custodially** (it escrows your funds).
- Nothing does a **non-custodial recurring buy**: pull from the user's wallet, swap, and return the bought asset to that same wallet, with no operator custody in between.

This program fills that gap by composing **on top of** the native subscription primitive, not duplicating it.

## How it works

One atomic transaction per period:

1. `transfer_recurring` (native) pulls ≤ the user's per-period cap of USDC into a transient per-user PDA.
2. A keeper-supplied swap route (USDC → target asset) executes.
3. `execute_buy` (this program) verifies the outcome and delivers the asset to the user's own wallet, draining the transient account to zero.

The program enforces a set of **non-custody invariants** (destination must be the user, bounded price, no residual balances, no discretion, no admin path to user funds). See [`SPEC.md` §6](./SPEC.md).

## Build & test

Requires Anchor 0.31.1, Solana 3.0.x, Rust, Node 22+/Yarn.

```bash
anchor build                     # SBF build (both programs)
cargo test -p recurring-buy --lib   # price_floor unit tests
anchor test                      # localnet: full invariant + keeper suite
```

Devnet end-to-end (real native Subscriptions pull + router, one atomic tx):

```bash
# 1) fixtures + a live router smoke on devnet (writes scripts/.devnet.json)
ANCHOR_PROVIDER_URL=https://api.devnet.solana.com ANCHOR_WALLET=$HOME/.config/solana/id.json \
  ./node_modules/.bin/ts-mocha -p ./tsconfig.json -t 1000000 scripts/devnet_fixtures.ts
# 2) the atomic pull+swap+deliver e2e (isolated @solana/kit module)
cd keeper/native && npm install && node e2e.mjs
```

`Cargo.lock` is committed, so SBF builds are reproducible (the toolchain pins matter — see the lockfile).

## Status & roadmap

- [x] Design spec
- [x] `execute_buy` router + all five non-custody invariants
- [x] Localnet invariant test suite (23/23 passing incl. M2, deterministic mock venue)
- [x] Keeper (composes native pull + swap route + `execute_buy`)
- [x] Devnet e2e: **real** native Subscriptions pull + router, atomic, one tx ([`keeper/native/e2e.mjs`](./keeper/native/e2e.mjs)) — *mock venue; the live Jupiter route is the open mainnet item ([SPEC §11.2](./SPEC.md))*
- [x] M2 design spec: amortized non-custodial decumulation ([`SPEC_M2_DECUMULATION.md`](./SPEC_M2_DECUMULATION.md))
- [x] M2 build: `SellPlan` + `execute_sell` (fixed-unit amortized draws, exact runway) + keeper sell leg
- [x] M2 devnet e2e: real native pull **on the target mint** + amortized sell, atomic, one tx ([`keeper/native/e2e_sell.mjs`](./keeper/native/e2e_sell.mjs)) — *mock venue, same caveat as M1*
- [x] Internal red-team of the M2 additions (findings fixed: [`AUDIT.md`](./AUDIT.md) round 2)
- [ ] Third-party audit, M1+M2 scope
- [ ] Mainnet reference (PAXG, live Jupiter route) + front-end

## Keeper daemon

[`keeper/native/daemon.mjs`](./keeper/native/daemon.mjs) turns the rails into a running service: each tick it
discovers every recurring delegation naming the keeper as delegatee (via `fetchDelegationsByDelegatee`),
and cranks whatever is due — USDC delegations become atomic `[pull, swap, execute_buy]`, target-mint
delegations with a due `SellPlan` become atomic `[pull, swap, execute_sell]` (amortized draw mirrored
off chain state). One tick, one keeper, any number of users; a failed item never kills the tick.

```bash
node keeper/native/daemon.mjs --once   # single tick
INTERVAL_S=60 node keeper/native/daemon.mjs
```

[`keeper/native/golden.mjs`](./keeper/native/golden.mjs) dumps byte-exact golden vectors for the three
native instructions so alternative encoders (e.g. a web3.js-v1 browser flow) can be verified against
the audited kit client.

## License

Dual-licensed under either [MIT](./LICENSE-MIT) or [Apache-2.0](./LICENSE-APACHE), at your option.

---

*This is infrastructure, not financial advice, and not a securities or custody solution by itself. Anyone deploying it is responsible for their own legal and regulatory posture.*
