# Hack the North 2026 Solana track plan

Checked on 2026-09-19 against the live event and protocol documentation.

## What the judges require

Hack the North's Solana prize is **Best Use of Solana**: build a creative use
case that meaningfully leverages Solana. The event's general judging dimensions
are WOW factor, technical ability, originality, and design. The judging pitch is
a live demo, not a slide deck, and lasts five minutes in the first round. The
initial Devpost submission and sponsor-prize selection are due at 2:00 PM EDT on
September 19; final edits close at 8:00 AM EDT on September 20.

Primary sources:

- [Hack the North 2026 Devpost](https://hackthenorth2026.devpost.com/)
- [Hack the North 2026 rules](https://hackthenorth2026.devpost.com/rules)
- [MLH Solana prize guidance](https://www.mlh.com/events/hack-the-north-e8/prizes)

The MLH guidance explicitly calls out sophisticated trading/DEX applications
and consumer products that depend on instant, high-frequency transactions.
Goosey should therefore demonstrate that Solana is the economic system, not a
decorative transaction hash attached to a database market.

## Architecture decision

Goosey follows the useful parts of Polymarket's hybrid exchange model while
remaining a free game:

1. The web application handles authentication, editorial metadata, search,
   comments, notifications, and command orchestration.
2. A price-time-priority central limit order book determines counterparties.
3. Every feather issuance, transfer, market escrow movement, order mutation,
   fill, position change, resolution approval, and payout is enforced by the
   Goosey Solana program.
4. SQL is a catalog, command journal, and indexed projection. It is never an
   alternate authority for a Solana market's balances or positions.
5. Each ordinary Goosey account receives an encrypted app-managed Ed25519
   identity. A distinct server sponsor pays localnet/devnet transaction fees,
   so the product has no wallet connection or SOL requirement.
6. All submitted transaction bytes are durably journaled before the first send.
   Ambiguous sends reconcile the original signature and never manufacture a
   fresh economic intent.
7. Market terms are hashed, accepted by two distinct enrolled reviewers, and
   sealed before activation. Resolution uses separate proposal and approval
   roles, then pays winning positions from fully collateralized market escrow.

This is analogous to Polymarket's separation between user experience/order
orchestration and on-chain settlement, but Goosey uses nonredeemable SPL
feathers and program-owned market seats instead of real-money collateral and
ERC-1155 conditional tokens.

Relevant Polymarket primary documentation:

- [Prices and order books](https://docs.polymarket.com/concepts/prices-orderbook)
- [Order lifecycle](https://docs.polymarket.com/concepts/order-lifecycle)
- [Positions and tokens](https://docs.polymarket.com/concepts/positions-tokens)
- [Wallets and authentication](https://docs.polymarket.com/trading/wallets-auth)
- [Resolution](https://docs.polymarket.com/concepts/resolution)
- [Contracts and audits](https://docs.polymarket.com/resources/contracts)

Solana PDAs provide deterministic market, seat, order-book, enrollment, mint,
and resolution addresses with no private keys. See the official
[Solana PDA documentation](https://solana.com/docs/core/pda).

## Demo proof, in order

The five-minute live demo should make these facts visible without exposing
wallet plumbing to the user:

1. Create two ordinary Goosey accounts and show their free feather balances.
2. Open the same Waterloo-themed market in two sessions.
3. Place complementary orders and show the live book update.
4. Show the finalized matched trade, positions, and changed probability.
5. Transfer feathers by Goosey username.
6. Show a compact operator proof panel containing the pinned cluster/genesis,
   program address, market PDA, finalized transaction signatures, and an
   explorer/local validator link.
7. If time permits, close a disposable demo market, approve its result with the
   second reviewer, and claim the winning payout.

The demo must not depend on an existing browser wallet, faucet interaction, or
a manually running one-shot worker. The app, command worker, indexer, and
settlement worker need one supervised start path and explicit readiness checks.

## Acceptance gates

- A fresh isolated validator test provisions two managed users and one sealed
  market, executes a real match, transfer, cancellation, resolution, and payout,
  and verifies finalized account state.
- Retrying every public command with the same idempotency key has no duplicate
  economic effect.
- Killing a worker after send but before response recovers the original
  transaction signature without re-signing.
- The normal market and portfolio pages use chain state for every Solana market;
  no separate wallet or chain-only product path is required.
- Creating a market through the normal admin API produces a hidden Solana draft
  plus a durable provisioning command; no new DATABASE financial market can be
  created while the Solana-only gate is enabled.
- Release readiness fails closed unless the program is executable on the pinned
  genesis, every published market is sealed and fully initialized, the retained
  terms match, and indexer coverage is bounded-complete.
- No private key, signed wire payload, RPC credential, or custody material is
  returned by an API or written to application logs.

## Current implementation evidence

The repository already contains the Anchor program, SPL feather mint and
escrow, managed encrypted custody, sponsored transactions, market-local seats,
price-time-priority matching, reservations and fees, cancellation, transfers,
two-reviewer terms, resolution and claims, durable command journaling, bounded
indexing, and isolated real-validator suites. The remaining release-critical
work is integration: make normal admin creation provision Solana markets,
complete the managed no-wallet browser journey, merge managed chain holdings
into the ordinary portfolio, supervise workers, and publish a reproducible
localnet/devnet demo deployment.
