# Internal audit — findings & resolutions

## Round 2: M2 decumulation additions (2026-07-10)

Independent internal review of the M2 additions (`SellPlan`, `open_sell_plan`, `close_sell_plan`, `execute_sell`, `sell_floor`, keeper sell leg, M2 tests) against `SPEC_M2_DECUMULATION.md`. One in-depth reviewer (a second, adversarially-framed reviewer was blocked by a policy filter; the completed review covered the security-relevant surface: account constraints, stale-safety, clock/cap math, cross-instruction composition). M1 findings were not re-opened.

| # | Severity | Issue | Status |
|---|----------|-------|--------|
| M2-1 | Medium | **No terminal state after `end_ts`.** `remaining_periods` floors at 1, so a post-horizon plan silently became a perpetual "sell the full (possibly re-accumulated) pot every period" license until the user closed the plan or revoked the delegation. | **FIXED**: every due period `≤ end_ts` gets exactly one crank; once `next_due_ts > end_ts`, `execute_sell` refuses forever (`PlanCompleted`, checked before the clock gate). Spec §6.8 added. |
| M2-2 | Medium | **Tests only half-mirrored M1** on the sell path, and the amortization-cap boundary was fuzzed (periods ∈ {9,10}), never pinned. | **FIXED**: added the full sell-side mirror (INV-1 wrong destination, INV-3 residue, INV-4 venue, slippage-underpay, pause, non-canonical pot) + an exact cap/cap+1 boundary pair + a lifecycle test (k-jump advance, NotDue, late final crank, `PlanCompleted`). 23/23 localnet. |
| M2-3 | Low | `init_config` never checked the quote mint's decimals; a non-6dp quote mint would mis-scale both floors ~1000x. | **FIXED**: `require!(usdc_mint.decimals == 6)` at init. |
| M2-4 | Low | Spec §6.6 text said `next_due_ts += period_secs`; the code (correctly) does the k-jump past `now`. Doc drift an auditor would flag. | **FIXED**: spec updated to the k-jump formula + rationale; `next_due_ts = now` at open documented. |
| M2-5 | Low | Keeper `amortizedDraw` ignored pre-existing transient residue (could compose a tx exceeding the on-chain cap) and its doc overstated itself; keeper/e2e computed periods from the **local** clock (boundary-skew `OverdrawSchedule` liveness race). | **FIXED**: residue-aware draw (`cap − residue`, floored at 0) + chain-time (`getBlockTime`) in the e2e + doc guidance. |
| M2-6 | Nit | Non-canonical pot account rejected with generic `BadParam`; the pot binding (what makes INV-5 sound) was undocumented in the spec. | **FIXED**: dedicated `BadPotAccount` + spec §6.5 documents the binding. |
| — | Info | Confirmed sound: cap formula matches spec §6.5 exactly (incl. `max(1)` and pot-includes-this-pull accounting, stale-safe by instruction-entry deserialization); k-jump arithmetic (signedness, `now == next_due` edge, checked ops); account structs complete (`INIT_SPACE` exact, `close = user`, seeds/bumps); keeper and on-chain math agree bit-for-bit under a shared clock; `sell_floor` units/rounding correct and consistent with `price_floor`. | — |

Residual (documented, mainnet-gated, unchanged from M1): instruction-sysvar binding of the pull, Pyth reference price, multisig admin, live venue route; plus the SPEC_M2 dust-guard open question (malicious-keeper dust cranks are a liveness annoyance, not theft — the user can always self-crank or revoke).

Post-remediation status: 8/8 Rust unit, 23/23 localnet, devnet sell e2e PASS on the upgraded program (real target-mint delegation, draw == pot/periods exactly).

## Round 1: M1 (2026-07-09)

Independent multi-reviewer audit of the M1 deliverable, run before any grant submission. Three parallel reviews: (A) adversarial security red-team of the on-chain program, (B) correctness + code-quality, (C) repo hygiene + grant-readiness. This is an **internal** review, not a substitute for a third-party audit (that is a funded milestone, see README).

## Threat model (trust boundaries)

- **Keeper: UNTRUSTED.** Anyone may call `execute_buy` and supply the swap route (`swap_data` + `remaining_accounts`). The program never trusts the route; it verifies the outcome. A keeper's blast radius is bounded to the USDC sitting in the per-user transient PDA, and the mandatory price floor bounds any underpayment to `max_slippage_bps`.
- **Admin: BOUNDED.** May set the venue whitelist, price/slippage params, and pause. Has **no** instruction that can move any user's funds (INV-5). For mainnet the admin should be a multisig/timelock.
- **User: never signs `execute_buy`.** Custody stays with the user: funds are pulled by the user's own native subscription (capped/revocable) and delivered to the user's own canonical ATA in the same transaction. No pooled account ever holds user funds.

## Findings

| # | Severity | Issue | Status |
|---|----------|-------|--------|
| C-2 | Critical | Price floor was optional (`price_ref_micros == 0` disabled it) while `min_out` is keeper-supplied → a keeper could pass `min_out = 1` and drain the pull through a whitelisted venue. Real theft, not bounded MEV. | **FIXED** |
| M-3 | Medium | `dest_ata`/`transient_usdc` bound only by owner+mint, not to the canonical ATA (weaker than the SPEC's "user's own ATA" claim). | **FIXED** |
| B-1 | Medium | `price_floor` u128 math could overflow-revert a legitimate buy for very-high-decimal targets; and the decimal path was untested (all tests used 6dp/$1/1:1). | **FIXED** |
| C-1 / M-2 | Medium | `execute_buy` is not pinned (via `instructions` sysvar) to run atomically after the native `transfer_recurring`; the atomicity is assumed. | **DOCUMENTED** (mainnet hardening) |
| H-2 | Medium | The whitelist is a trust anchor: a permissive/compromised whitelisted venue, invoked with the PDA signer, is only backstopped by the floor. | **ACCEPTED by design** + documented |
| M-1 | Medium | `user`/`dest` not bound to the delegator recorded in the native delegation account (SPEC §6.6). | **DOCUMENTED** (mainnet hardening; superseded in practice by C-2 fix + canonical ATA) |
| — | Info | Forced-signer `is_signer \|\| key == buy_authority` — **cannot** elevate third-party accounts (different PDA seeds → different key; runtime rejects unmatched signer seeds). | **Confirmed sound** |
| — | Info | Reentrancy via the venue CPI is not exploitable (post-CPI `reload()` + drain/floor checks). Arithmetic is `checked_*`. Whitelist clearing has no stale-entry bug. Admin authz (`has_one`) correct. | **Confirmed sound** |
| K-1 | Medium | `keeper.buildJupiterSwap` drops address lookup tables and ignores setup/cleanup instructions → cannot yet produce a landable mainnet tx. | **DOCUMENTED** as a mainnet scaffold (SPEC §11.2); not presented as functional |
| G-* | Should-fix | No CI, no SECURITY.md/threat-model, README lacked a quick-start and the "mock venue" caveat, no tagged release. | **FIXED** |

## Resolutions (code)

- **C-2 / H-1 (mandatory floor).** `execute_buy` now `require!(price_ref_micros > 0)` (`FloorNotConfigured`) and always enforces `min_out >= price_floor(...)`. The keeper-supplied `min_out` can never be the sole protection. `price_ref_micros == 0` is treated as unconfigured and refuses execution.
- **M-3 (canonical ATA).** `dest_ata` must equal `get_associated_token_address(user, target_mint)` and `transient_usdc` must equal `get_associated_token_address(buy_authority, usdc_mint)`. Delivery can only ever land in the user's own canonical ATA.
- **B-1 (overflow + tests).** `init_config` clamps `target_mint.decimals <= 12`. Added Rust unit tests for `price_floor` (6dp/$1, 9dp/$2000, zero-slippage, round-down) and TS tests for the mandatory-floor refusal and admin-only params.

## Residual / mainnet items (not blocking M1; on the roadmap)

- **C-1/M-2/M-1:** add `instructions`-sysvar introspection to bind `execute_buy` to the immediately-preceding native `transfer_recurring` (delegator + receiver match). Defense-in-depth; the mandatory floor already guarantees the user receives ≥ floor value for whatever is in their transient.
- **K-1:** complete the Jupiter path (resolve LUTs, handle setup/cleanup, verify the one-tx CPI size) — this is exactly SPEC §11.2, unverifiable on devnet (no Jupiter liquidity).
- Replace the config reference price with a **Pyth** read on mainnet; make the admin a **multisig/timelock**; commission a **third-party audit**.

## Test status after remediation

- Rust unit tests: **5/5** (`price_floor` decimal math).
- Localnet integration (mock venue): **10/10** (happy path, INV-1..4, mandatory-floor, admin-only, keeper e2e, pause).
- Devnet e2e (real native Subscriptions pull + router, atomic, one tx): **passing** on the hardened program.
