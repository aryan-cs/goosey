//! Standalone host compilation harness for the real Anchor resolution adapter.
//! It deliberately does not wire the module into the deployable program.

pub use ::goosey_exchange::*;

#[path = "../programs/goosey-exchange/src/resolution.rs"]
pub mod resolution;
