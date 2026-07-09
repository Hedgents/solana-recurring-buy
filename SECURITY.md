# Security

This is **devnet-first, pre-third-party-audit** software. Do not use it with real funds on mainnet.

## Reporting a vulnerability

Please report suspected vulnerabilities privately to **security@hedgents.com** rather than opening a public issue. We aim to acknowledge within 72 hours.

## Trust model

- **Keeper: untrusted.** Anyone may call `execute_buy` and supply the swap route. The program verifies the outcome (destination, price floor, drain-to-zero, whitelist), never the route. A keeper cannot redirect user funds or underpay beyond `max_slippage_bps`.
- **Admin: bounded.** Can only set the venue whitelist, price/slippage params, and pause. No instruction lets the admin move user funds. On mainnet the admin should be a multisig/timelock.
- **User: never signs `execute_buy`.** Funds are pulled by the user's own native subscription (capped, revocable) and delivered to the user's own canonical ATA in the same transaction. No pooled account ever holds user funds.

## Invariants (enforced on-chain, see `SPEC.md` §6)

1. Destination is the subscriber's own canonical ATA for the target mint.
2. The price floor is **mandatory** and `min_out` must clear it; realized output must clear `min_out`.
3. The transient account drains to zero (nothing is held).
4. Only whitelisted venues may be invoked.
5. No admin path to user funds.

## Known residual items (see `AUDIT.md`)

Instruction-sysvar binding of `execute_buy` to the native pull, a Pyth-backed reference price, a multisig admin, completion of the Jupiter route path, and a third-party audit are all tracked as mainnet-gated work. The current guarantees hold for the devnet reference with the mandatory floor.
