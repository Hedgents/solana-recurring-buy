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

#[event]
pub struct BuyExecuted {
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
