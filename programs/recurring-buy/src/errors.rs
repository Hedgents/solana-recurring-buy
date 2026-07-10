use anchor_lang::prelude::*;

#[error_code]
pub enum BuyError {
    #[msg("Router is paused")]
    Paused,
    #[msg("INV-1: destination token account is not owned by the subscriber")]
    DestinationNotOwner,
    #[msg("INV-1: destination mint is not the configured target mint")]
    WrongTargetMint,
    #[msg("Transient account mint/authority mismatch")]
    BadTransient,
    #[msg("No pulled funds present in the transient account")]
    NothingPulled,
    #[msg("Swap program is not whitelisted")]
    VenueNotWhitelisted,
    #[msg("INV-2: price floor is not configured (price_ref_micros == 0); refusing to execute")]
    FloorNotConfigured,
    #[msg("INV-2: min_out is below the price-sanity floor")]
    MinOutTooLow,
    #[msg("INV-3: transient account was not fully drained by the swap")]
    TransientNotDrained,
    #[msg("INV-2: realized output is below min_out")]
    SlippageExceeded,
    #[msg("Too many swap programs")]
    TooManyVenues,
    #[msg("Arithmetic overflow")]
    Overflow,
    #[msg("Invalid parameter")]
    BadParam,
    #[msg("M2: sell is not due yet (clock gate)")]
    NotDue,
    #[msg("M2 INV-5: pull exceeds the amortized schedule cap")]
    OverdrawSchedule,
}
