//! Standalone host/SBPF compile harness for immutable market terms. This does
//! not wire instructions into the deployed program or rebuild its shared ELF.

#![allow(unexpected_cfgs)]

pub use ::goosey_exchange::*;

#[path = "../programs/goosey-exchange/src/market_terms.rs"]
pub mod market_terms;

// Compile concrete handlers and generated Anchor account validators for SBPF
// without changing the deployable program's instruction table.
#[cfg(target_os = "solana")]
#[no_mangle]
pub fn initialize_terms_probe(
    ctx: anchor_lang::context::Context<market_terms::InitializeMarketTerms>,
    version: u8,
    digest: [u8; 32],
    manifest_len: u32,
) -> anchor_lang::Result<()> {
    market_terms::initialize_market_terms(ctx, version, digest, manifest_len)
}

#[cfg(target_os = "solana")]
#[no_mangle]
pub fn accept_terms_probe(
    ctx: anchor_lang::context::Context<market_terms::AcceptMarketTerms>,
    digest: [u8; 32],
) -> anchor_lang::Result<()> {
    market_terms::accept_market_terms(ctx, digest)
}

#[cfg(target_os = "solana")]
#[no_mangle]
pub fn seal_terms_probe(
    ctx: anchor_lang::context::Context<market_terms::SealMarketTerms>,
    digest: [u8; 32],
) -> anchor_lang::Result<()> {
    market_terms::seal_market_terms(ctx, digest)
}
