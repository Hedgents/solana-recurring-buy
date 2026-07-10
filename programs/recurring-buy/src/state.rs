use anchor_lang::prelude::*;

/// Max number of whitelisted swap venues (e.g. Jupiter, an Orca pool).
pub const MAX_SWAP_PROGRAMS: usize = 3;

pub const CONFIG_SEED: &[u8] = b"config";
pub const BUY_AUTH_SEED: &[u8] = b"buy";
pub const SELL_PLAN_SEED: &[u8] = b"sell-plan";
pub const FEE_CONFIG_SEED: &[u8] = b"fee";

/// Hard cap on the protocol execution fee. An admin can NEVER set more than
/// 1% of flow; the cap is compiled in, not a parameter.
pub const MAX_FEE_BPS: u16 = 100;

/// Cadence bounds for a sell plan: 1 minute (test-friendly) to 1 year.
pub const MIN_PERIOD_SECS: i64 = 60;
pub const MAX_PERIOD_SECS: i64 = 366 * 86_400;

#[account]
#[derive(InitSpace)]
pub struct Config {
    /// Admin authority: may set whitelist / params / pause ONLY.
    /// Has no path to move any user funds (see SPEC INV-5).
    pub admin: Pubkey,
    /// The asset users are buying (e.g. PAXG).
    pub target_mint: Pubkey,
    /// The stablecoin users pay with (e.g. USDC).
    pub usdc_mint: Pubkey,
    /// Whitelisted swap program ids the router is allowed to CPI.
    pub swap_programs: [Pubkey; MAX_SWAP_PROGRAMS],
    pub swap_program_count: u8,
    /// Price-sanity reference: micro-USD per 1.0 whole target token.
    /// The floor is MANDATORY: `execute_buy` refuses to run while this is 0
    /// (treated as unconfigured). Mainnet must set a real reference (or wire a
    /// Pyth read) so a keeper can never underpay beyond `max_slippage_bps`.
    pub price_ref_micros: u64,
    /// Decimals of the target mint (cached for the floor computation).
    pub target_decimals: u8,
    /// Slippage the floor tolerates below the reference price, in bps.
    pub max_slippage_bps: u16,
    /// When true, `execute_buy` is halted.
    pub paused: bool,
    pub bump: u8,
}

impl Config {
    pub fn is_whitelisted(&self, program_id: &Pubkey) -> bool {
        self.swap_programs[..self.swap_program_count as usize].contains(program_id)
    }
}

/// Protocol execution fee (the Uniswap-Labs-style interface-fee model): a
/// FIXED, disclosed, product- and counterparty-agnostic percentage of each
/// executed swap's INPUT, skimmed pre-swap to the destination's canonical ATA.
/// It is an automation/execution fee on FLOW, never a management fee on
/// holdings (nothing is ever held). Default 0 — the open-source reference
/// deployment is free; an operated instance may turn it on up to MAX_FEE_BPS.
#[account]
#[derive(InitSpace)]
pub struct FeeConfig {
    /// Fee in basis points of each execution's input amount. <= MAX_FEE_BPS.
    pub fee_bps: u16,
    /// Wallet whose canonical ATAs receive the fee (USDC on buys, target on sells).
    pub destination: Pubkey,
    pub bump: u8,
}

/// M2 decumulation: a per-user amortized sell schedule (SPEC_M2 §4). Holds
/// schedule parameters ONLY — never balances. The "pot" is the user's own
/// wallet balance of the target asset, read at execution time, so the runway
/// (`remaining_balance / remaining_periods`) is self-correcting by construction.
#[account]
#[derive(InitSpace)]
pub struct SellPlan {
    /// Owner. Only signer who can open/close the plan.
    pub user: Pubkey,
    /// When the schedule completes (user-chosen horizon).
    pub end_ts: i64,
    /// Payout cadence in seconds.
    pub period_secs: i64,
    /// Clock gate for the permissionless crank. Advanced past `now` on each
    /// execution (missed periods are skipped, not caught up: re-amortization
    /// spreads the remainder — SPEC_M2 §6.6).
    pub next_due_ts: i64,
    pub bump: u8,
}

impl SellPlan {
    /// Periods left in the schedule, floored at 1 so the final period (and any
    /// time past `end_ts`) allows selling the full remainder.
    pub fn remaining_periods(&self, now: i64) -> i64 {
        (self.end_ts.saturating_sub(now) / self.period_secs).max(1)
    }
}
