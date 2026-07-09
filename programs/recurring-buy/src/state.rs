use anchor_lang::prelude::*;

/// Max number of whitelisted swap venues (e.g. Jupiter, an Orca pool).
pub const MAX_SWAP_PROGRAMS: usize = 3;

pub const CONFIG_SEED: &[u8] = b"config";
pub const BUY_AUTH_SEED: &[u8] = b"buy";

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
    /// 0 disables the on-chain floor (rely on keeper `min_out` only).
    /// Mainnet MUST set this (or wire a Pyth read) so a keeper cannot underpay.
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
