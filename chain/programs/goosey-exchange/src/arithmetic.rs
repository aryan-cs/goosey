//! Exact economic primitives shared by the future onchain matcher and its tests.

pub fn cumulative_fee(notional: u64, fee_bps: u16) -> Option<u64> {
    if fee_bps > 10_000 { return None; }
    let numerator = u128::from(notional) * u128::from(fee_bps);
    u64::try_from(numerator / 10_000 + u128::from(numerator % 10_000 != 0)).ok()
}

pub fn fee_delta(previous: u64, fill: u64, fee_bps: u16) -> Option<u64> {
    cumulative_fee(previous.checked_add(fill)?, fee_bps)?
        .checked_sub(cumulative_fee(previous, fee_bps)?)
}

pub fn buy_reserve(limit: u64, remaining: u64, chain_notional: u64, fee_bps: u16) -> Option<u64> {
    let principal = limit.checked_mul(remaining)?;
    principal.checked_add(fee_delta(chain_notional, principal, fee_bps)?)
}

pub fn void_payout(payout: u64, yes: u64, no: u64) -> Option<u64> {
    let total = u128::from(yes) + u128::from(no);
    u64::try_from(u128::from(payout).checked_mul(total)? / 2).ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fees_telescope_across_fills_and_replacement() {
        for rate in [0, 1, 17, 100, 9_999, 10_000] {
            let mut previous = 0;
            let mut charged = 0;
            for fill in [1, 2, 19, 200, 1, 99_999] {
                charged += fee_delta(previous, fill, rate).unwrap();
                previous += fill;
                assert_eq!(Some(charged), cumulative_fee(previous, rate));
            }
            assert_eq!(buy_reserve(1, 1, previous, rate), Some(1 + fee_delta(previous, 1, rate).unwrap()));
        }
    }

    #[test]
    fn void_combines_outcomes_before_rounding() {
        assert_eq!(void_payout(3, 1, 1), Some(3));
        assert_eq!(void_payout(3, 1, 0), Some(1));
        assert_eq!(void_payout(100_000, 7, 3), Some(500_000));
    }

    #[test]
    fn boundaries_fail_without_wrapping() {
        assert_eq!(cumulative_fee(u64::MAX, 10_000), Some(u64::MAX));
        assert_eq!(cumulative_fee(1, 10_001), None);
        assert_eq!(fee_delta(u64::MAX, 1, 100), None);
        assert_eq!(buy_reserve(u64::MAX, 2, 0, 0), None);
        assert_eq!(void_payout(u64::MAX, u64::MAX, u64::MAX), None);
    }
}
