# M2 — non-custodial decumulation (amortized sell-side) — design spec (v0.1, draft)

**Status:** design, pre-implementation. Devnet-first. Not audited. Not legal advice.
**Depends on:** M1 (`SPEC.md`), which is frozen as audited scope; M2 is additive.

## 0. TL;DR

The sell-side mirror of M1. A user who has accumulated a target asset (e.g. tokenized gold) turns it into a **scheduled, self-owned income stream**: each period a keeper pulls an **amortized amount of the asset itself** (`remaining_balance / remaining_periods`) via a native-Subscriptions delegation on the target mint, atomically swaps it to USDC through a whitelisted venue, and delivers the USDC to the user's **own** wallet. Fixed-asset draws, floating (smoothed) dollars.

**The core promise this makes possible:** "this balance supports exactly N years" is *deterministic arithmetic*, not a market projection, because the schedule is denominated in the asset, not in dollars. There is no market-timing rule anywhere in the machine.

## 1. Design rationale (why amortized asset-draws, not fixed dollars)

- **Sequence-of-returns risk is eliminated, not managed.** A fixed-dollar payout sells more units into a crash, permanently shrinking the stack at the worst moment. A fixed-unit schedule never changes with price; there is nothing to time.
- **The runway is exact.** `remaining_units / units_per_period` is a verifiable on-chain fact. Dollar-fixed designs can only ever promise a probability band.
- **Self-correcting.** The draw is recomputed each period (`remaining / periods_left`), so missed periods, top-ups, or partial withdrawals re-amortize automatically. It cannot run out early; the amount adjusts.
- **Legally lightest.** No thresholds, no "sell when price is favorable" policy, no discretion of any kind. A countdown, not a strategy. (An earlier design with a buffer + refill-when-price-above-moving-average rule was rejected: it re-introduces something that looks like market-timing policy, and its dollar smoothing requires holding user funds — see §5.)
- **The tradeoff, stated honestly:** the monthly dollar amount floats with the asset price. Mitigation is smoothing (guidance-level, §5) and the fact that the target user's alternative is no scheduled income at all.

## 2. Non-goals

- **No longevity pooling / annuity / guaranteed lifetime income.** This is scheduled self-drawdown of the user's own assets. Nothing is pooled, nothing is guaranteed beyond the arithmetic of the schedule.
- **No custodial buffer.** The program never holds user funds across transactions (see §5).
- **No fixed-dollar payout mode in the program.** If ever offered, it is a client-side convenience over the same rail, presented with a runway *range*, never a guaranteed number.
- **No yield, no leverage, no borrowing against the asset** (retail financed metal is the heavy regulatory pattern; rejected).

## 3. Architecture: one atomic transaction per period

```
tx (all-or-nothing):
  ix1  native transfer_recurring   user TARGET ATA --(≤ delegation cap)--> transient PDA target ATA
  ix2  <swap route>                keeper-supplied venue route (TARGET -> USDC)
  ix3  execute_sell (this program) verifies schedule + outcome, delivers USDC to the user, drains to zero
```

Identical trust model to M1: the keeper is an untrusted trigger that signs and pays fees; the program verifies the outcome; the user's own capped, revocable delegation (on the **target mint** this time) authorizes the pull.

## 4. Plan state (new, minimal)

Unlike the stateless buy side, amortization needs a schedule anchor. A small per-user `SellPlan` PDA (seeds `[b"sell-plan", user]`):

| field | meaning |
|---|---|
| `user` | owner; only signer who can open/close/modify |
| `end_ts` | when the schedule completes (user-chosen horizon) |
| `period_secs` | payout cadence (e.g. 30 days) |
| `next_due_ts` | clock gate for the permissionless crank |
| `bump` | |

Instructions: `open_sell_plan(end_ts, period_secs)` (user-signed), `close_sell_plan` (user-signed, anytime — the escape hatch is inherent since the assets never left the user's wallet), `execute_sell` (permissionless, clock-gated).

No balances live in the plan. The "pot" is simply the user's own wallet balance of the target asset, read at execution time.

## 5. The smoothing decision (custody boundary)

Trailing-average dollar smoothing requires somewhere for un-paid-out proceeds to sit. Any program-held buffer — even a per-user, user-exit-only PDA — is the program holding user funds across transactions, which crosses the non-custodial bright line the entire legal posture depends on ("funds never leave the user's wallet except via an atomic self-authorized swap").

**Resolution: smoothing is a guidance layer, not an enforcement layer.**
- On-chain: each period's full USDC proceeds are delivered directly to the user's own USDC ATA. The user has all their money, immediately, always.
- Client-side: the app displays a **smoothed monthly budget** (trailing N-period average of proceeds) and frames the raw arrivals as deposits into that budget. Spending discipline belongs to the user, consistent with the product's self-custody philosophy: we automate the *sell* discipline; we advise on the *spend* discipline.
- Explicitly rejected: program-held smoothing buffer (custodial), agent-managed spending account (discretionary + custodial).

## 6. Non-custody + schedule invariants (normative — the audit core)

Mirrors M1 §6, plus the amortization guard. Each maps to an on-chain check and a dedicated error code.

1. **Destination = user.** USDC proceeds may only be delivered to the user's canonical USDC ATA. `→ DestinationNotOwner`
2. **Bounded price (mandatory floor, mirrored).** Realized USDC out ≥ `min_out`, and `min_out` ≥ the reference-price floor: `floor = amount_in × price_ref_micros / 10^target_decimals × (10000 − max_slippage_bps) / 10000`. The floor is refused-if-unconfigured, exactly like M1 (`FloorNotConfigured`). A keeper can never sell the user's asset below the tolerated band. `→ MinOutTooLow / SlippageExceeded`
3. **No residue.** The transient target-asset account drains to zero. `→ TransientNotDrained`
4. **Whitelisted venue only.** Same `Config` whitelist. `→ VenueNotWhitelisted`
5. **Amortization cap (anti-over-draw).** `amount_in ≤ (user_target_balance_before_pull) / remaining_periods`, computed on-chain as `amount_in ≤ (wallet_balance_now + amount_in) / max(1, (end_ts − now) / period_secs)`. Even if the user set their delegation cap generously, a keeper cannot drain faster than the schedule. The pot account is bound to the user's **canonical** target ATA (so a keeper cannot substitute a fake pot to inflate the cap). `→ OverdrawSchedule / BadPotAccount`
6. **Clock gate.** `now ≥ next_due_ts`; on success the gate jumps past `now` on the aligned grid: `next_due_ts += k × period_secs` with `k = (now − next_due_ts) / period_secs + 1`. Missed periods are *skipped*, never caught up (a literal single `+= period_secs` would leave the gate in the past and permit rapid catch-up cranks); re-amortization automatically spreads the remainder over the periods left. `→ NotDue`
7. **No discretion, no admin path to user funds.** Admin surface is unchanged from M1 (whitelist/params/pause only).
8. **Terminal state.** Every due period `≤ end_ts` gets exactly one crank; once `next_due_ts > end_ts` the schedule is complete and `execute_sell` refuses forever (checked before the clock gate). Without this, `remaining_periods`'s floor-at-1 would make a post-horizon plan a perpetual full-pot sell license against any re-accumulated balance. Completion only stops the *automation* — the user's funds never left their wallet. `→ PlanCompleted`

## 7. Instruction interface (draft)

- `open_sell_plan(end_ts, period_secs)` — user-signed. Requires `end_ts > now + period_secs`, sane `period_secs` bounds. `next_due_ts` initializes to `now`: the first draw is immediately due (so a plan opened at the minimum horizon has its first crank at `remaining_periods = 1`, i.e. the full pot — by design, that is a one-period schedule).
- `execute_sell(min_out, swap_data)` — permissionless keeper crank. Enforces §6. Venue-agnostic forwarding under the transient PDA signature, identical mechanics to `execute_buy`.
- `close_sell_plan()` — user-signed. Closes the plan account; the delegation is separately revocable by the user on the native rail at any time (defense in depth: either revocation alone stops the flow).

Reuses the existing `Config` (same admin, same whitelist, same `price_ref_micros` — one reference price serves both directions: buy-floor in target units, sell-floor in USDC units).

## 8. Keeper

Extends `RecurringBuyKeeper` with the mirrored leg: `buildExecuteSell` + a delegation-on-target-mint setup path. Per due plan: read plan + wallet balance → compute the amortized pull → build one tx `[transfer_recurring(target), venue route(target→USDC), execute_sell(min_out)]` → send. The devnet e2e mirrors M1's (`keeper/native/e2e.mjs` pattern) with the mock venue reversed (pool buys target, pays USDC).

## 9. Runway + UI honesty rules

- **Gram-denominated runway: show as exact.** "Your balance supports `N` payouts of `X` grams: final payout on `date`." This is arithmetic and may be presented as such.
- **Dollar figures: always a range or an estimate.** Any dollar projection is marked "at current price" or shown as median / pessimistic paths. Never a fixed guaranteed dollar number anywhere in product or marketing.
- **Smoothed budget: labeled as guidance.** "Suggested monthly budget (12-month average)" — never "your payout is guaranteed to be $X."

## 10. Milestones

- **M2.1:** `SellPlan` + `execute_sell` + invariants + localnet suite (mirror of the M1 invariant tests, plus over-draw and clock-gate cases).
- **M2.2:** keeper sell leg + devnet e2e (real native pull on the target mint, mock venue).
- **M2.3:** client runway/smoothing display math (off-chain, guidance layer).
- Third-party audit covers M1+M2 together (one scope, still small).

## 11. Open questions — status

1. **RESOLVED (devnet, 2026-07-10).** The native Subscriptions rail accepts arbitrary SPL mints for delegations: `keeper/native/e2e_sell.mjs` ran a real delegation + `transfer_recurring` on the mock target mint, composed atomically with `execute_sell` in one transaction (amortized draw enforced, USDC delivered to the user, transient drained).
2. `remaining_periods` rounding policy at the tail (final period sells the exact remainder; guard div-by-zero at `end_ts`).
3. Whether `execute_sell` should also enforce a per-period *minimum* (dust guard) so keepers don't crank economically meaningless sells.
4. Same mainnet items as M1: live venue route (Jupiter/Orca), Pyth reference, instruction-sysvar binding of the pull, multisig admin.
