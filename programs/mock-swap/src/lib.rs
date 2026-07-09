//! # mock-swap (TEST ONLY)
//!
//! A minimal swap venue used to exercise `recurring-buy` deterministically on
//! localnet without live Jupiter liquidity. It pulls `amount_in` USDC from the
//! caller's source account (whose authority is signed by the router's
//! `invoke_signed`) into a pool, and pays `out_amount` target tokens from a
//! pre-funded pool to the destination. NOT for production use.

use anchor_lang::prelude::*;
use anchor_spl::token::{self, Token, TokenAccount, Transfer};

declare_id!("H4SoWFSerNHbat7XxPKp1UTTtfp6o9LTrB7Z9zS1gPf3");

pub const POOL_SEED: &[u8] = b"pool";

#[program]
pub mod mock_swap {
    use super::*;

    /// Swap `amount_in` USDC for exactly `out_amount` target tokens. `out_amount`
    /// is supplied by the caller so tests can drive precise slippage/drain cases.
    pub fn swap(ctx: Context<Swap>, amount_in: u64, out_amount: u64) -> Result<()> {
        // Pull USDC from the source. Its authority (the router's transient PDA)
        // is a signer here via the outer invoke_signed.
        token::transfer(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.source_usdc.to_account_info(),
                    to: ctx.accounts.pool_usdc.to_account_info(),
                    authority: ctx.accounts.source_authority.to_account_info(),
                },
            ),
            amount_in,
        )?;

        // Pay the target asset out of the pool to the destination.
        let bump = ctx.bumps.pool_authority;
        let seeds: &[&[u8]] = &[POOL_SEED, &[bump]];
        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.pool_target.to_account_info(),
                    to: ctx.accounts.dest_target.to_account_info(),
                    authority: ctx.accounts.pool_authority.to_account_info(),
                },
                &[seeds],
            ),
            out_amount,
        )?;
        Ok(())
    }
}

#[derive(Accounts)]
pub struct Swap<'info> {
    #[account(mut)]
    pub source_usdc: Account<'info, TokenAccount>,
    /// CHECK: authority over `source_usdc`; signed by the router's invoke_signed.
    pub source_authority: UncheckedAccount<'info>,
    #[account(mut)]
    pub pool_usdc: Account<'info, TokenAccount>,
    #[account(mut)]
    pub pool_target: Account<'info, TokenAccount>,
    #[account(mut)]
    pub dest_target: Account<'info, TokenAccount>,
    /// CHECK: pool PDA authority over `pool_target`.
    #[account(seeds = [POOL_SEED], bump)]
    pub pool_authority: UncheckedAccount<'info>,
    pub token_program: Program<'info, Token>,
}
