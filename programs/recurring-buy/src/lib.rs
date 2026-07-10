//! # recurring-buy
//!
//! A non-custodial recurring-buy (DCA) router for Solana. It composes ON TOP of
//! the native Subscriptions & Allowances rail: each period a keeper pulls a
//! user-capped amount of USDC (via the native `transfer_recurring`, in the SAME
//! transaction) into a per-user transient PDA, this program atomically swaps it
//! through a WHITELISTED venue, and delivers the bought asset to the user's OWN
//! wallet. The operator never pools, holds, or custodies user funds.
//!
//! The router is venue-agnostic: the keeper supplies the swap route, and this
//! program VERIFIES THE OUTCOME rather than trusting the route. See SPEC.md.

use anchor_lang::prelude::*;
use anchor_lang::solana_program::{
    instruction::{AccountMeta, Instruction},
    program::invoke_signed,
};
use anchor_spl::associated_token::get_associated_token_address;
use anchor_spl::token::{Mint, Token, TokenAccount};

pub mod errors;
pub mod state;

use errors::BuyError;
use state::*;

declare_id!("H36vWFrN1iYWEAqweZ9BU8c7Wd35Adq9vCkprwLgMqsn");

#[program]
pub mod recurring_buy {
    use super::*;

    pub fn init_config(
        ctx: Context<InitConfig>,
        swap_programs: Vec<Pubkey>,
        price_ref_micros: u64,
        max_slippage_bps: u16,
    ) -> Result<()> {
        require!(swap_programs.len() <= MAX_SWAP_PROGRAMS, BuyError::TooManyVenues);
        require!(max_slippage_bps <= 10_000, BuyError::BadParam);
        // Bound target decimals so the u128 floor math cannot overflow-revert a
        // legitimate buy (10^decimals * amount_in). SPL mints are <= 9 in practice.
        require!(ctx.accounts.target_mint.decimals <= 12, BuyError::BadParam);
        // Both floors assume a 6-decimal quote mint (micro-USD cancels USDC's
        // 1e6). A different-decimal quote would silently mis-scale the floors.
        require!(ctx.accounts.usdc_mint.decimals == 6, BuyError::BadParam);
        let cfg = &mut ctx.accounts.config;
        cfg.admin = ctx.accounts.admin.key();
        cfg.target_mint = ctx.accounts.target_mint.key();
        cfg.usdc_mint = ctx.accounts.usdc_mint.key();
        cfg.swap_programs = [Pubkey::default(); MAX_SWAP_PROGRAMS];
        for (i, p) in swap_programs.iter().enumerate() {
            cfg.swap_programs[i] = *p;
        }
        cfg.swap_program_count = swap_programs.len() as u8;
        cfg.price_ref_micros = price_ref_micros;
        cfg.target_decimals = ctx.accounts.target_mint.decimals;
        cfg.max_slippage_bps = max_slippage_bps;
        cfg.paused = false;
        cfg.bump = ctx.bumps.config;
        Ok(())
    }

    pub fn set_pause(ctx: Context<AdminOnly>, paused: bool) -> Result<()> {
        ctx.accounts.config.paused = paused;
        Ok(())
    }

    pub fn set_params(
        ctx: Context<AdminOnly>,
        price_ref_micros: u64,
        max_slippage_bps: u16,
    ) -> Result<()> {
        require!(max_slippage_bps <= 10_000, BuyError::BadParam);
        let cfg = &mut ctx.accounts.config;
        cfg.price_ref_micros = price_ref_micros;
        cfg.max_slippage_bps = max_slippage_bps;
        Ok(())
    }

    pub fn set_whitelist(ctx: Context<AdminOnly>, swap_programs: Vec<Pubkey>) -> Result<()> {
        require!(swap_programs.len() <= MAX_SWAP_PROGRAMS, BuyError::TooManyVenues);
        let cfg = &mut ctx.accounts.config;
        cfg.swap_programs = [Pubkey::default(); MAX_SWAP_PROGRAMS];
        for (i, p) in swap_programs.iter().enumerate() {
            cfg.swap_programs[i] = *p;
        }
        cfg.swap_program_count = swap_programs.len() as u8;
        Ok(())
    }

    /// Permissionless. Swaps the USDC sitting in the per-user transient PDA
    /// (pulled by the native subscription in the same tx) into the target asset
    /// and delivers it to the user's own wallet. Enforces the non-custody
    /// invariants (SPEC.md ss.6). `swap_data` + `remaining_accounts` are the
    /// keeper-built venue call; this program signs it under the transient PDA
    /// and verifies the result.
    pub fn execute_buy<'info>(
        ctx: Context<'_, '_, 'info, 'info, ExecuteBuy<'info>>,
        min_out: u64,
        swap_data: Vec<u8>,
    ) -> Result<()> {
        let cfg = &ctx.accounts.config;
        require!(!cfg.paused, BuyError::Paused);

        // INV-1: destination MUST be the subscriber's OWN CANONICAL ATA for the
        // target mint (canonical-ATA binding, not merely owner == user).
        require_keys_eq!(ctx.accounts.dest_ata.mint, cfg.target_mint, BuyError::WrongTargetMint);
        require_keys_eq!(
            ctx.accounts.dest_ata.key(),
            get_associated_token_address(&ctx.accounts.user.key(), &cfg.target_mint),
            BuyError::DestinationNotOwner
        );

        // The transient MUST be the per-user PDA's CANONICAL USDC ATA.
        require_keys_eq!(ctx.accounts.transient_usdc.mint, cfg.usdc_mint, BuyError::BadTransient);
        require_keys_eq!(
            ctx.accounts.transient_usdc.key(),
            get_associated_token_address(&ctx.accounts.buy_authority.key(), &cfg.usdc_mint),
            BuyError::BadTransient
        );

        let amount_in = ctx.accounts.transient_usdc.amount;
        require!(amount_in > 0, BuyError::NothingPulled);

        // INV-4 (venue): only whitelisted swap programs may be invoked.
        require!(
            cfg.is_whitelisted(&ctx.accounts.swap_program.key()),
            BuyError::VenueNotWhitelisted
        );

        // INV-2 (floor): the price-sanity floor is MANDATORY. `min_out` is
        // keeper-supplied and can never be the sole protection, so a config with
        // price_ref_micros == 0 is treated as unconfigured and execution is
        // refused (mainnet must set a reference price or wire a Pyth read). The
        // floor (reference price minus max slippage) bounds any keeper/MEV
        // underpayment to the tolerated band.
        require!(cfg.price_ref_micros > 0, BuyError::FloorNotConfigured);
        let floor = price_floor(
            amount_in,
            cfg.price_ref_micros,
            cfg.target_decimals,
            cfg.max_slippage_bps,
        )?;
        require!(min_out >= floor, BuyError::MinOutTooLow);

        let dest_before = ctx.accounts.dest_ata.amount;

        // Force the transient PDA to sign the venue CPI (it is the authority of
        // the source USDC). We forward the keeper-built instruction verbatim and
        // rely on the post-conditions below, never on the route's honesty.
        let buy_auth_key = ctx.accounts.buy_authority.key();
        let metas: Vec<AccountMeta> = ctx
            .remaining_accounts
            .iter()
            .map(|ai| AccountMeta {
                pubkey: *ai.key,
                is_signer: ai.is_signer || *ai.key == buy_auth_key,
                is_writable: ai.is_writable,
            })
            .collect();
        let ix = Instruction {
            program_id: ctx.accounts.swap_program.key(),
            accounts: metas,
            data: swap_data,
        };

        let user_key = ctx.accounts.user.key();
        let signer_seeds: &[&[u8]] =
            &[BUY_AUTH_SEED, user_key.as_ref(), &[ctx.bumps.buy_authority]];

        let mut infos = ctx.remaining_accounts.to_vec();
        infos.push(ctx.accounts.swap_program.to_account_info());
        invoke_signed(&ix, &infos, &[signer_seeds])?;

        // Reload post-swap balances.
        ctx.accounts.transient_usdc.reload()?;
        ctx.accounts.dest_ata.reload()?;

        // INV-3: no residue may remain in the transient (nothing is held).
        require!(ctx.accounts.transient_usdc.amount == 0, BuyError::TransientNotDrained);

        // INV-2: realized output must clear min_out.
        let out = ctx
            .accounts
            .dest_ata
            .amount
            .checked_sub(dest_before)
            .ok_or(BuyError::Overflow)?;
        require!(out >= min_out, BuyError::SlippageExceeded);

        emit!(BuyExecuted {
            user: user_key,
            amount_in,
            amount_out: out,
            venue: ctx.accounts.swap_program.key(),
        });
        Ok(())
    }

    // ── M2: amortized decumulation (SPEC_M2_DECUMULATION.md) ───────────────

    /// Open an amortized sell schedule. Holds parameters only, never balances;
    /// the pot is the user's own wallet balance, read at execution time.
    pub fn open_sell_plan(ctx: Context<OpenSellPlan>, end_ts: i64, period_secs: i64) -> Result<()> {
        require!(
            (MIN_PERIOD_SECS..=MAX_PERIOD_SECS).contains(&period_secs),
            BuyError::BadParam
        );
        let now = Clock::get()?.unix_timestamp;
        require!(end_ts > now.saturating_add(period_secs), BuyError::BadParam);
        let plan = &mut ctx.accounts.sell_plan;
        plan.user = ctx.accounts.user.key();
        plan.end_ts = end_ts;
        plan.period_secs = period_secs;
        plan.next_due_ts = now; // first sell is immediately due
        plan.bump = ctx.bumps.sell_plan;
        Ok(())
    }

    /// Close the plan (rent back to the user). The user's delegation on the
    /// native rail is separately revocable; either alone stops the flow.
    pub fn close_sell_plan(_ctx: Context<CloseSellPlan>) -> Result<()> {
        Ok(())
    }

    /// Permissionless. Sells the target asset pulled (by the user's native
    /// subscription, same tx) into the per-user transient PDA and delivers the
    /// USDC to the user's own wallet. Mirrors `execute_buy`'s non-custody
    /// invariants, plus the amortization cap (a keeper can never outrun the
    /// schedule) and the clock gate. SPEC_M2 §6.
    pub fn execute_sell<'info>(
        ctx: Context<'_, '_, 'info, 'info, ExecuteSell<'info>>,
        min_out: u64,
        swap_data: Vec<u8>,
    ) -> Result<()> {
        let cfg = &ctx.accounts.config;
        require!(!cfg.paused, BuyError::Paused);

        // Terminal state (M2 INV-8): every due period ≤ end_ts gets exactly one
        // crank; once next_due_ts has advanced past end_ts the schedule is
        // complete and the automation stops (the user still owns everything —
        // funds never left their wallet). Checked BEFORE the clock gate so the
        // terminal state reports correctly.
        require!(
            ctx.accounts.sell_plan.next_due_ts <= ctx.accounts.sell_plan.end_ts,
            BuyError::PlanCompleted
        );

        // Clock gate (M2 INV-6).
        let now = Clock::get()?.unix_timestamp;
        require!(now >= ctx.accounts.sell_plan.next_due_ts, BuyError::NotDue);

        // Canonical bindings: proceeds may only land in the user's own USDC
        // ATA; the transient is the per-user PDA's canonical target-asset ATA;
        // the wallet account used for the amortization cap is the user's own
        // canonical target-asset ATA (so a keeper cannot understate the pot).
        require_keys_eq!(
            ctx.accounts.dest_usdc.key(),
            get_associated_token_address(&ctx.accounts.user.key(), &cfg.usdc_mint),
            BuyError::DestinationNotOwner
        );
        require_keys_eq!(
            ctx.accounts.transient_target.key(),
            get_associated_token_address(&ctx.accounts.buy_authority.key(), &cfg.target_mint),
            BuyError::BadTransient
        );
        require_keys_eq!(
            ctx.accounts.user_target_ata.key(),
            get_associated_token_address(&ctx.accounts.user.key(), &cfg.target_mint),
            BuyError::BadPotAccount
        );

        let amount_in = ctx.accounts.transient_target.amount;
        require!(amount_in > 0, BuyError::NothingPulled);

        // M2 INV-5 (amortization cap): the pulled amount may not exceed
        // (total pot) / (periods remaining). The pot is wallet + this pull
        // (the pull already left the wallet earlier in this tx).
        let total_pot = (ctx.accounts.user_target_ata.amount as u128)
            .checked_add(amount_in as u128)
            .ok_or(BuyError::Overflow)?;
        let periods = ctx.accounts.sell_plan.remaining_periods(now) as u128;
        let cap = total_pot.checked_div(periods).ok_or(BuyError::Overflow)?;
        require!(amount_in as u128 <= cap, BuyError::OverdrawSchedule);

        // INV-4 (venue): only whitelisted swap programs may be invoked.
        require!(
            cfg.is_whitelisted(&ctx.accounts.swap_program.key()),
            BuyError::VenueNotWhitelisted
        );

        // INV-2 (mandatory floor, sell direction): min USDC out for the pulled
        // target amount at the reference price minus the slippage band.
        require!(cfg.price_ref_micros > 0, BuyError::FloorNotConfigured);
        let floor = sell_floor(
            amount_in,
            cfg.price_ref_micros,
            cfg.target_decimals,
            cfg.max_slippage_bps,
        )?;
        require!(min_out >= floor, BuyError::MinOutTooLow);

        let dest_before = ctx.accounts.dest_usdc.amount;

        // Forward the keeper-built venue instruction with the transient PDA
        // forced as signer (identical mechanics to execute_buy).
        let buy_auth_key = ctx.accounts.buy_authority.key();
        let metas: Vec<AccountMeta> = ctx
            .remaining_accounts
            .iter()
            .map(|ai| AccountMeta {
                pubkey: *ai.key,
                is_signer: ai.is_signer || *ai.key == buy_auth_key,
                is_writable: ai.is_writable,
            })
            .collect();
        let ix = Instruction {
            program_id: ctx.accounts.swap_program.key(),
            accounts: metas,
            data: swap_data,
        };

        let user_key = ctx.accounts.user.key();
        let signer_seeds: &[&[u8]] =
            &[BUY_AUTH_SEED, user_key.as_ref(), &[ctx.bumps.buy_authority]];

        let mut infos = ctx.remaining_accounts.to_vec();
        infos.push(ctx.accounts.swap_program.to_account_info());
        invoke_signed(&ix, &infos, &[signer_seeds])?;

        // Reload post-swap balances.
        ctx.accounts.transient_target.reload()?;
        ctx.accounts.dest_usdc.reload()?;

        // INV-3: no residue may remain in the transient.
        require!(ctx.accounts.transient_target.amount == 0, BuyError::TransientNotDrained);

        // INV-2: realized USDC must clear min_out.
        let out = ctx
            .accounts
            .dest_usdc
            .amount
            .checked_sub(dest_before)
            .ok_or(BuyError::Overflow)?;
        require!(out >= min_out, BuyError::SlippageExceeded);

        // Advance the clock gate past `now`, skipping missed periods (no
        // catch-up: re-amortization spreads the remainder — SPEC_M2 §6.6).
        let plan = &mut ctx.accounts.sell_plan;
        let k = now
            .checked_sub(plan.next_due_ts)
            .ok_or(BuyError::Overflow)?
            .checked_div(plan.period_secs)
            .ok_or(BuyError::Overflow)?
            .checked_add(1)
            .ok_or(BuyError::Overflow)?;
        plan.next_due_ts = plan
            .next_due_ts
            .checked_add(k.checked_mul(plan.period_secs).ok_or(BuyError::Overflow)?)
            .ok_or(BuyError::Overflow)?;

        emit!(SellExecuted {
            user: user_key,
            amount_in,
            amount_out: out,
            venue: ctx.accounts.swap_program.key(),
        });
        Ok(())
    }
}

/// Price-sanity floor in target base units.
///
/// `amount_in` is USDC base units (6 dp). `price_ref_micros` is micro-USD per
/// 1.0 whole target token. The USDC 1e6 and the micro 1e6 cancel, giving:
///   out_base = amount_in * 10^target_decimals / price_ref_micros
/// then discounted by `max_slippage_bps`.
fn price_floor(
    amount_in: u64,
    price_ref_micros: u64,
    target_decimals: u8,
    max_slippage_bps: u16,
) -> Result<u64> {
    let scale = 10u128
        .checked_pow(target_decimals as u32)
        .ok_or(BuyError::Overflow)?;
    let ideal = (amount_in as u128)
        .checked_mul(scale)
        .ok_or(BuyError::Overflow)?
        .checked_div(price_ref_micros as u128)
        .ok_or(BuyError::Overflow)?;
    let floor = ideal
        .checked_mul(10_000u128 - max_slippage_bps as u128)
        .ok_or(BuyError::Overflow)?
        .checked_div(10_000u128)
        .ok_or(BuyError::Overflow)?;
    Ok(floor as u64)
}

/// Sell-direction price-sanity floor in USDC base units.
///
/// `amount_in` is target base units; `price_ref_micros` is micro-USD per 1.0
/// whole target token. USDC has 6 dp and micro-USD is 1e6, so they cancel:
///   out_usdc = amount_in * price_ref_micros / 10^target_decimals
/// then discounted by `max_slippage_bps`.
fn sell_floor(
    amount_in: u64,
    price_ref_micros: u64,
    target_decimals: u8,
    max_slippage_bps: u16,
) -> Result<u64> {
    let scale = 10u128
        .checked_pow(target_decimals as u32)
        .ok_or(BuyError::Overflow)?;
    let ideal = (amount_in as u128)
        .checked_mul(price_ref_micros as u128)
        .ok_or(BuyError::Overflow)?
        .checked_div(scale)
        .ok_or(BuyError::Overflow)?;
    let floor = ideal
        .checked_mul(10_000u128 - max_slippage_bps as u128)
        .ok_or(BuyError::Overflow)?
        .checked_div(10_000u128)
        .ok_or(BuyError::Overflow)?;
    Ok(floor as u64)
}

#[event]
pub struct BuyExecuted {
    pub user: Pubkey,
    pub amount_in: u64,
    pub amount_out: u64,
    pub venue: Pubkey,
}

#[event]
pub struct SellExecuted {
    pub user: Pubkey,
    pub amount_in: u64,
    pub amount_out: u64,
    pub venue: Pubkey,
}

#[cfg(test)]
mod tests {
    use super::price_floor;

    #[test]
    fn floor_6dp_dollar() {
        // $10 USDC (10_000_000) at $1.00/token, 6 dp, 1% slippage -> 9.9 tokens.
        assert_eq!(price_floor(10_000_000, 1_000_000, 6, 100).unwrap(), 9_900_000);
    }

    #[test]
    fn floor_9dp_high_price() {
        // $2000 USDC at $2000/token (price_ref = 2_000_000_000 micro-USD), 9 dp,
        // 0.5% slippage. ideal = 2000e6 * 1e9 / 2000e6 = 1e9 base units (1.0 token);
        // floor = 1e9 * 9950/10000 = 995_000_000.
        assert_eq!(price_floor(2_000_000_000, 2_000_000_000, 9, 50).unwrap(), 995_000_000);
    }

    #[test]
    fn floor_zero_slippage_is_ideal() {
        assert_eq!(price_floor(5_000_000, 1_000_000, 6, 0).unwrap(), 5_000_000);
    }

    #[test]
    fn floor_rounds_down() {
        // 7 USDC at $3/token, 6 dp, 0 slippage: 7e6 * 1e6 / 3e6 = 2_333_333.33 -> 2_333_333.
        assert_eq!(price_floor(7_000_000, 3_000_000, 6, 0).unwrap(), 2_333_333);
    }

    use super::sell_floor;

    #[test]
    fn sell_floor_6dp_dollar() {
        // Sell 10.0 tokens (10_000_000 @ 6dp) at $1.00/token, 1% slippage -> $9.90.
        assert_eq!(sell_floor(10_000_000, 1_000_000, 6, 100).unwrap(), 9_900_000);
    }

    #[test]
    fn sell_floor_9dp_high_price() {
        // Sell 0.5 tokens (500_000_000 @ 9dp) at $2000/token, 0.5% slippage:
        // ideal = 5e8 * 2e9 / 1e9 = 1_000_000_000 uUSDC ($1000); floor = $995.
        assert_eq!(sell_floor(500_000_000, 2_000_000_000, 9, 50).unwrap(), 995_000_000);
    }

    #[test]
    fn buy_sell_floors_are_inverse() {
        // Round-tripping $10 through both floors at 0 slippage is identity.
        let tokens = price_floor(10_000_000, 2_000_000, 6, 0).unwrap(); // 5.0 tokens
        assert_eq!(sell_floor(tokens, 2_000_000, 6, 0).unwrap(), 10_000_000);
    }
}

#[derive(Accounts)]
pub struct InitConfig<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(
        init,
        payer = admin,
        space = 8 + Config::INIT_SPACE,
        seeds = [CONFIG_SEED],
        bump
    )]
    pub config: Account<'info, Config>,
    pub target_mint: Account<'info, Mint>,
    pub usdc_mint: Account<'info, Mint>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct AdminOnly<'info> {
    pub admin: Signer<'info>,
    #[account(mut, seeds = [CONFIG_SEED], bump = config.bump, has_one = admin)]
    pub config: Account<'info, Config>,
}

#[derive(Accounts)]
pub struct OpenSellPlan<'info> {
    #[account(mut)]
    pub user: Signer<'info>,
    #[account(
        init,
        payer = user,
        space = 8 + SellPlan::INIT_SPACE,
        seeds = [SELL_PLAN_SEED, user.key().as_ref()],
        bump
    )]
    pub sell_plan: Account<'info, SellPlan>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct CloseSellPlan<'info> {
    #[account(mut)]
    pub user: Signer<'info>,
    #[account(
        mut,
        close = user,
        seeds = [SELL_PLAN_SEED, user.key().as_ref()],
        bump = sell_plan.bump,
        has_one = user
    )]
    pub sell_plan: Account<'info, SellPlan>,
}

#[derive(Accounts)]
pub struct ExecuteSell<'info> {
    /// Any keeper may trigger; pays fees. NOT an authority over any funds.
    pub keeper: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, Config>,
    /// CHECK: the plan owner. Bound by the plan's has_one, the transient PDA
    /// seeds, and the canonical-ATA invariants. Never signs.
    pub user: UncheckedAccount<'info>,
    #[account(
        mut,
        seeds = [SELL_PLAN_SEED, user.key().as_ref()],
        bump = sell_plan.bump,
        has_one = user
    )]
    pub sell_plan: Account<'info, SellPlan>,
    /// CHECK: per-user transient signing PDA (same PDA as the buy side).
    #[account(seeds = [BUY_AUTH_SEED, user.key().as_ref()], bump)]
    pub buy_authority: UncheckedAccount<'info>,
    /// The per-user transient target-asset account the native pull deposited into.
    #[account(mut)]
    pub transient_target: Account<'info, TokenAccount>,
    /// The user's own target-asset ATA (the pot), read for the amortization cap.
    pub user_target_ata: Account<'info, TokenAccount>,
    /// The user's own USDC account; the only allowed destination for proceeds.
    #[account(mut)]
    pub dest_usdc: Account<'info, TokenAccount>,
    /// CHECK: verified against the config whitelist in the handler.
    pub swap_program: UncheckedAccount<'info>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct ExecuteBuy<'info> {
    /// Any keeper may trigger; pays fees. NOT an authority over any funds.
    pub keeper: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, Config>,
    /// CHECK: the subscriber. Bound by the transient PDA seeds and the
    /// destination-owner invariant. Never signs, never an authority.
    pub user: UncheckedAccount<'info>,
    /// CHECK: per-user transient signing PDA (authority of `transient_usdc`).
    #[account(seeds = [BUY_AUTH_SEED, user.key().as_ref()], bump)]
    pub buy_authority: UncheckedAccount<'info>,
    /// The per-user transient USDC account the native pull deposited into.
    #[account(mut)]
    pub transient_usdc: Account<'info, TokenAccount>,
    /// The user's own target-asset account; the only allowed destination.
    #[account(mut)]
    pub dest_ata: Account<'info, TokenAccount>,
    /// CHECK: verified against the config whitelist in the handler.
    pub swap_program: UncheckedAccount<'info>,
    pub token_program: Program<'info, Token>,
}
