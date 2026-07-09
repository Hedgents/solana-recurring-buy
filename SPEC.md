# solana-recurring-buy — design spec (v0.1, draft)

**Status:** design, pre-implementation. Devnet-first. Not audited. Not legal advice.
**License:** MIT OR Apache-2.0.

## 0. TL;DR

A small, open-source Anchor program that turns Solana's **native Subscriptions & Allowances** recurring *pull* into a **non-custodial recurring buy (DCA)**: each period a keeper pulls a user-capped amount of USDC, atomically swaps it to a target SPL asset (e.g. PAXG), and delivers that asset to the user's **own** wallet, all in a single transaction. Funds are never pooled or held by the operator. It builds **on top of** the Foundation's native Subscriptions program and does **not** duplicate it.

## 1. The gap this fills (why it is a public good, not a duplicate)

| Layer | What it does | Custody | Status |
|---|---|---|---|
| Native Subscriptions & Allowances (`De1egAFMkMWZSN5rYXRj9CAdheBamobVNubTsi9avR44`) | Capped, revocable recurring **pull** of one token to a receiver. A payments rail. | Non-custodial (capped delegate) | Exists (Foundation-backed) |
| Jupiter DCA / Recurring | Scheduled DCA, but **escrows** the user's funds in a program account for the duration. | Custodial | Exists |
| **This program** | Pull (via the native rail) → **atomic swap** → deliver bought asset to the user's own wallet. Recurring **investment**, self-custody preserved. | **Non-custodial** | Gap |

The native rail moves a payment. Jupiter's DCA holds your money. Neither provides a **non-custodial recurring buy**: pulling from the user's wallet and returning a different asset to that same wallet without the operator ever taking custody. This program is exactly that missing composition layer.

## 2. Non-goals

- **Not a scheduler.** Solana has no on-chain cron (Clockwork is dead). A keeper cranks; user self-trigger and Tuktuk are backups. "Automatic" means "the user does not re-approve," not "a chain job runs it."
- **Not a payout / decumulation rail.** The native rail is pull-only; a scheduled catch-up *payout* primitive is a possible later milestone, out of scope for v1.
- **Not a new payments primitive.** It consumes the native one.
- **No pooling, no yield, no custody, no discretion.**

## 3. Architecture: one atomic transaction

```
tx (all-or-nothing):
  ix1  native transfer_recurring   user USDC ATA  --(≤ per-period cap)-->  transient per-user PDA USDC ATA
  ix2  <swap route>                keeper-supplied Jupiter route (USDC -> PAXG)
  ix3  execute_buy (this program)  PDA signs the swap authority, verifies outcome, drains to zero
```

Everything is in **one transaction**, so it is all-or-nothing. The keeper signs and pays the fee but has no power to divert funds: the program hard-codes the destination and drains the transient account to zero. (Exact composition of ix2/ix3 — bracket vs. direct CPI — is settled in §5; the observable guarantee is identical.)

## 4. Account model

- **Transient per-user PDA** — seeds `[b"buy", delegator]`, and its USDC ATA. This is the swap source; the PDA is the swap authority via `invoke_signed`. **Drained to zero every transaction.** Per-user derivation prevents cross-user contamination.
- **User USDC ATA** — the pull source; the native subscription authority is its capped delegate.
- **User PAXG ATA** — the final, only destination for the bought asset.
- **Config PDA** — `[b"config"]`: admin, target mint (PAXG), whitelisted swap program id(s), optional Pyth PAXG/USD feed, slippage/sanity-band params, pause flag.
- **No pooled or persistent token balances anywhere.** The only lamports the program holds are rent for the (transient, zero-token) ATAs.

## 5. The swap composition (venue-agnostic, verify-outcome)

The program does **not** embed routing logic. The keeper builds a Jupiter route off-chain (USDC → PAXG) and passes its instruction + accounts to `execute_buy`. `execute_buy`:

1. Assert the transient PDA USDC ATA holds the just-pulled amount (deposited by the preceding native `transfer_recurring` in the same tx).
2. Snapshot the user's PAXG ATA balance.
3. CPI the **whitelisted** swap program (Jupiter), with the transient PDA as source authority (`invoke_signed`); output destination is the user's PAXG ATA.
4. Assert the user's PAXG balance increased by **≥ `min_out`**, where `min_out` is keeper-supplied but **bounded by a Pyth PAXG/USD sanity band**, so neither the keeper nor MEV can underpay the user.
5. Assert the transient USDC ATA is **drained to zero**.
6. Assert the destination ATA **owner == the subscription delegator** (the user), read from the delegation account.

Only whitelisted swap program id(s) can be CPI'd, so the "keeper supplies the route" flexibility never becomes an arbitrary-CPI hole.

## 6. Non-custody invariants (normative — the audit core)

The program MUST enforce all of the following. Each maps to an on-chain check and a dedicated error code.

1. **Destination = user.** The bought asset can only be delivered to an ATA whose owner is the subscription delegator. `→ DestinationNotDelegator`
2. **Bounded price.** Realized output ≥ `min_out`, and `min_out` ≥ the Pyth-derived floor (sanity band). `→ SlippageExceeded` / `→ PriceOutOfBand`
3. **No residue.** The transient account holds zero of both tokens after the instruction. `→ TransientNotDrained`
4. **No discretion.** Amount and cadence come from the user's own subscription terms; the program supplies no amount and picks no timing. (Enforced structurally: the pull is the native rail's; the program only reacts to what was pulled.)
5. **Trigger, not custodian.** No instruction (including admin) can move a user's USDC or PAXG to any account other than the user's own. Admin is limited to whitelist/params/pause, all bounded. `→ Unauthorized`

## 7. Instruction interface (draft)

- `init_config(admin, target_mint, swap_program_whitelist, price_feed, params)` — one-time.
- `execute_buy(min_out)` — **permissionless** (any keeper), clock-gated by the native subscription's own period logic; enforces §6. This is the whole product.
- `set_params` / `set_whitelist` / `set_pause` — admin-only, bounded.

No `open_plan`/deposit instruction is needed: the recurring terms (cap, cadence, revocation) live entirely in the user's native subscription. This program is stateless per-user beyond the transient PDA + config.

## 8. Keeper

Extends the already-proven `subs-keeper` (native `@solana/subscriptions` client). Per due plan: read the native subscription state → build one tx `[transfer_recurring, jupiter route, execute_buy(min_out)]` → sign → send. Idempotency and cadence are the native subscription's period gate (no double-pull). Backups: user self-trigger + Tuktuk crank.

## 9. Security considerations

- **Transaction size** is the main engineering risk: a full Jupiter route + the native pull + `execute_buy` in one tx may exceed limits. Mitigations: Address Lookup Tables, constrained routes, and a fallback to a single-pool (Orca Whirlpool) CPI for the reference if Jupiter-in-one-tx proves too large.
- **MEV / keeper underpayment** — mitigated by `min_out` + Pyth sanity band (§6.2).
- **Arbitrary CPI** — mitigated by the swap-program whitelist (§5).
- **Authority scoping** — the transient PDA signs only the swap, and only for output to the user.
- **No admin escape hatch** to user funds (§6.5).

## 10. Milestones (grant scope)

- **M1 (this repo):** the `execute_buy` composition program + keeper + devnet tests + this spec. Buy-side only. Deliverable: audit-ready, MIT/Apache, README framed as recurring-investment infrastructure.
- **M2:** third-party audit (single-purpose, small nSLOC → cheap).
- **M3 (optional):** mainnet PAXG wiring + a reference front-end.

## 11. Open questions — status

1. **RESOLVED (devnet, 2026-07-09).** The native `transfer_recurring` deposits into the per-user transient PDA ATA, and `execute_buy` consumes it, swaps, and delivers to the user, **atomically in one transaction**. Proven on devnet by `keeper/native/e2e.mjs` (real native Subscriptions pull + router swap + delivery; transient drains to zero). The router forwarding a venue instruction under the PDA signature works on real chain.
2. **OPEN (mainnet).** A live Jupiter route CPI'd under the transient PDA signer, plus one-tx size. Devnet used the deterministic mock venue (Jupiter has no real devnet liquidity); this must be verified against a live Jupiter route on mainnet, with a single-pool Orca/Raydium CPI as the fallback if a full aggregator route won't fit one transaction.
3. PAXG-on-Solana mint + a liquid USDC/PAXG venue: devnet uses a mock mint + mock pool; mainnet wires native PAXG.
4. Pyth PAXG/USD feed: devnet uses the config-set `price_ref_micros` floor; mainnet wires a Pyth read.

## 12. License

Dual-licensed under MIT OR Apache-2.0 (Rust ecosystem convention; both text files in-repo). Genuinely open (OSI-approved) so it qualifies as a Solana Foundation public good.
