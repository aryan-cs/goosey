# Transferable play feathers and the Polymarket comparison

Research checked against official documentation on 2026-09-19.

Goosey feathers are freely issued play tokens. Goosey offers no purchase,
cash redemption, monetary peg, bridge, or investment return. Market outcome
payouts and escrow withdrawals return feathers, not money. Only localnet and
devnet are supported. Transferable tokens cannot technically prevent people
from arranging unrelated exchanges outside the application; do not promise
that unrestricted tokens are impossible to sell.

## What to copy, and what differs

[Polymarket's order lifecycle](https://docs.polymarket.com/concepts/order-lifecycle)
uses off-chain signed orders and operator matching, followed by atomic on-chain
settlement on Polygon. A matched order is not yet a finalized trade. Goosey's
current Solana program instead keeps matching, priority, reserves, fills and
cancellations on-chain. The application index is a derived read model, never
an alternative authority for balances or matching.

[Solana token transfers](https://solana.com/docs/tokens/basics/transfer-tokens)
move balances between accounts for the same mint without changing supply.
Goosey uses classic SPL feathers and wallet-authorized TransferChecked, with
mint and decimals validation. The sender approves the exact transaction;
uncertain submission is reconciled by signature, not automatically replaced
with another signed transfer.

The following product distinctions are intentional:

- Grant claim: receive an authorized free feather allowance.
- Transfer: send wallet-held feathers to another wallet.
- Deposit/withdraw: move feathers between a wallet and market escrow.
- Outcome claim: credit a resolved position's feather payout to its seat.
- Financial finality: display chain-confirmed state independently of UI intent.

[Polymarket positions](https://docs.polymarket.com/concepts/positions-tokens)
are ERC-1155 outcome tokens. Goosey currently records YES/NO holdings in market
seats: transferable SPL feathers do not imply transferable outcome tokens.
Standalone split/merge and portable outcome tokens are not implemented parity
features. Matching-driven complete-set mint/burn is not the same user action.

[Polymarket resolution](https://docs.polymarket.com/concepts/resolution)
and subsequent payout are separate operations. Goosey likewise separates
reviewer resolution, position claims and wallet withdrawal. Goosey's frozen
two-reviewer process is not UMA and has no automatic fallback if a reviewer
becomes unavailable. Both reviewers accept immutable terms before trading;
neither can trade that market.

## Integration status and remaining release gates

The actual local-validator suites exercise SPL grants/transfers, escrow,
order-book trading/cancellation, terms acceptance and YES/NO/VOID settlement.
This is not a claim that the public website is fully on-chain: its current
main catalog financial backend remains the database. The `/wallet` browser flow
has now claimed and transferred real SPL feathers on an isolated local validator,
including recovery after a lost submission response without duplicate sending
(see `wallet-browser-verification.md`). A separate chain-market interface is
implemented; its complete browser trading rehearsal is still in progress.
Durable finalized indexing/recovery and retained manifest verification have
isolated runtime coverage. Main catalog integration, a running deployment
indexer, devnet deployment, participant fee funding and the deliberate
single-authority backend cutover remain release gates.
Do not enable dual financial writes or silently translate database feathers
into minted tokens. Production identity/enrollment policy must explicitly
authorize issuance; client input must never become mint authority.

Immutable per-market execution backends now separate SQL and Solana markets.
SQL trading, cancellation, settlement and administrative lifecycle operations
reject Solana entries, and SQL workers exclude them. Verified chain registrations
create hidden draft metadata and a canonical network/program/market binding,
without creating SQL collateral or balances. This does not migrate existing
database markets or make draft chain entries publicly tradeable.

## Network identity correction

Read-only public `getGenesisHash` checks exposed shortened devnet/mainnet
identifiers in the initial configuration. Runtime, wallet challenges, browser
wallet selection, terms and transfer receipts now require full 32-byte hashes.
Devnet is pinned to `EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG`;
known mainnet and testnet hashes are rejected even under a localnet label.
Regression tests explicitly reject the old shortened values. Reading public
RPC network identity did not deploy the program or submit any transaction.
