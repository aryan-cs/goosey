//! Compile against actual foundation types and Anchor; no runtime/CPI claim.
pub use ::goosey_exchange::*;
#[allow(dead_code)]
#[path = "../programs/goosey-exchange/src/matching.rs"]
pub mod matching;
#[allow(dead_code)]
#[path = "../programs/goosey-exchange/src/exchange.rs"]
pub mod exchange;
#[path = "../programs/goosey-exchange/src/book-bootstrap.rs"]
pub mod book_bootstrap;
