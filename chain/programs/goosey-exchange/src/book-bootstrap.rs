//! Canonical PDA setup in bounded account-growth steps.
//! A draft tag cannot pass the placement handler's ready-book check. Finalizing
//! is one-way: no instruction here can resize, reset, or close a ready book.
use anchor_lang::prelude::*;
use anchor_lang::system_program::{self, Transfer};
use crate::{Config, escrow::Market};
use crate::exchange::{BOOK_BYTES, BOOK_TAG};
use crate::matching::{MAX_ORDERS, runtime::{Header, Slot, Storage}};

pub const GROWTH_STEP: usize = 10_240;
const DRAFT_TAG: [u8; 8] = *b"GOOSEYI1";

fn next_size(current: usize) -> Option<usize> {
    if current < GROWTH_STEP || current >= BOOK_BYTES || current % GROWTH_STEP != 0 { return None; }
    Some(current.checked_add(GROWTH_STEP)?.min(BOOK_BYTES))
}

#[derive(Accounts)]
pub struct CreateBook<'info> {
    #[account(mut)] pub admin: Signer<'info>,
    #[account(seeds = [b"config"], bump = config.bump, has_one = admin)]
    pub config: Account<'info, Config>,
    #[account(seeds = [b"market", config.key().as_ref(), &market.market_id.to_le_bytes()],
        bump = market.bump, has_one = config)]
    pub market: Account<'info, Market>,
    /// CHECK: fresh canonical program-owned PDA; handlers enforce lifecycle tag/size.
    #[account(init, payer = admin, space = GROWTH_STEP, seeds = [b"order_book", market.key().as_ref()], bump)]
    pub book: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

pub fn create_book(ctx: Context<CreateBook>) -> Result<()> {
    require!(Clock::get()?.unix_timestamp < ctx.accounts.market.closes_at, BootstrapError::Closed);
    let mut data = ctx.accounts.book.try_borrow_mut_data()?;
    require!(data.len() == GROWTH_STEP, BootstrapError::InvalidDraft);
    data[..8].copy_from_slice(&DRAFT_TAG);
    Ok(())
}

#[derive(Accounts)]
pub struct GrowBook<'info> {
    #[account(mut)] pub admin: Signer<'info>,
    #[account(seeds = [b"config"], bump = config.bump, has_one = admin)]
    pub config: Account<'info, Config>,
    #[account(seeds = [b"market", config.key().as_ref(), &market.market_id.to_le_bytes()],
        bump = market.bump, has_one = config)]
    pub market: Account<'info, Market>,
    /// CHECK: canonical PDA with draft lifecycle validated before rent/resize.
    #[account(mut, seeds = [b"order_book", market.key().as_ref()], bump, owner = crate::ID)]
    pub book: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

pub fn grow_book(ctx: Context<GrowBook>, expected_size: u32) -> Result<()> {
    let book = ctx.accounts.book.to_account_info();
    let current = book.data_len();
    require!(current == expected_size as usize, BootstrapError::StaleSize);
    let target = next_size(current).ok_or(BootstrapError::InvalidDraft)?;
    {
        let data = book.try_borrow_data()?;
        require!(data[..8] == DRAFT_TAG, BootstrapError::InvalidDraft);
    }
    require!(Clock::get()?.unix_timestamp < ctx.accounts.market.closes_at, BootstrapError::Closed);
    let required = Rent::get()?.minimum_balance(target);
    let missing = required.saturating_sub(book.lamports());
    if missing > 0 {
        system_program::transfer(CpiContext::new(ctx.accounts.system_program.key(), Transfer {
            from: ctx.accounts.admin.to_account_info(), to: book.clone(),
        }), missing)?;
    }
    // Runtime rejects aggregate growth >10KiB within the same transaction.
    // Clients submit/confirm each expected-size step separately.
    book.resize(target)?;
    Ok(())
}

pub fn finalize_book(ctx: Context<GrowBook>) -> Result<()> {
    require!(Clock::get()?.unix_timestamp < ctx.accounts.market.closes_at, BootstrapError::Closed);
    let mut data = ctx.accounts.book.try_borrow_mut_data()?;
    require!(data.len() == BOOK_BYTES && data[..8] == DRAFT_TAG, BootstrapError::InvalidDraft);
    let ptr = data[8..].as_mut_ptr();
    require!((ptr as usize) % core::mem::align_of::<Header>() == 0, BootstrapError::InvalidDraft);
    // Exact account length and alignment checked above. Integer-only repr(C)
    // layouts, mutually disjoint regions, exclusive runtime data borrow.
    let (header, slots, bids, asks) = unsafe {
        let slots_ptr = ptr.add(core::mem::size_of::<Header>());
        let bids_ptr = slots_ptr.add(MAX_ORDERS * core::mem::size_of::<Slot>());
        let asks_ptr = bids_ptr.add(MAX_ORDERS * 2);
        (&mut *ptr.cast::<Header>(), core::slice::from_raw_parts_mut(slots_ptr.cast::<Slot>(), MAX_ORDERS),
            core::slice::from_raw_parts_mut(bids_ptr.cast::<u16>(), MAX_ORDERS),
            core::slice::from_raw_parts_mut(asks_ptr.cast::<u16>(), MAX_ORDERS))
    };
    Storage::initialize(ctx.accounts.market.key().to_bytes(), ctx.accounts.market.payout_milli,
        ctx.accounts.market.fee_bps, header, slots, bids, asks).map_err(|_| error!(BootstrapError::InvalidDraft))?;
    data[..8].copy_from_slice(&BOOK_TAG);
    Ok(())
}

#[error_code(offset = 7100)]
pub enum BootstrapError {
    #[msg("Order book is not a valid unfinished draft")] InvalidDraft,
    #[msg("Order book size changed; reread before another growth step")] StaleSize,
    #[msg("Cannot initialize an order book after market close")] Closed,
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn exact_bounded_growth_reaches_ready_size_without_overallocation() {
        let mut size = GROWTH_STEP;
        while let Some(next) = next_size(size) {
            assert!(next > size && next - size <= GROWTH_STEP && next <= BOOK_BYTES);
            size = next;
        }
        assert_eq!(size, BOOK_BYTES);
    }
    #[test]
    fn malformed_or_finished_sizes_cannot_grow() {
        for size in [0, 8, GROWTH_STEP - 1, GROWTH_STEP + 1, BOOK_BYTES, BOOK_BYTES + 1, usize::MAX] {
            assert_eq!(next_size(size), None);
        }
    }
}
