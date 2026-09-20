# On-chain market page

`/chain/markets/[marketId]` accepts a canonical unsigned 64-bit chain market ID. It uses the pinned public browser runtime and a selected Wallet Standard account. It never falls back to a database market or infers a price from empty liquidity.

The browser requests the finalized market endpoint, independently reads the pinned RPC snapshot, and verifies the exact retained manifest bytes with `verifyMarketTerms`. Question, rules, sources, economics, deployment identity, reviewer identities, and digest come from those verified bindings. Missing accounts or terms render an unavailable state. The book lists actual resting orders, including expired orders not yet removed; it is not an executable-depth or fill guarantee.

The page supports:

- Explicit market-seat registration for an enrolled wallet.
- Depositing and withdrawing wallet feathers from market escrow.
- YES/NO limit buys and sells with GTC, IOC, or FOK, bounded to the shipping 16-touch matching limit.
- Owner cancellation of an exact resting order ID.
- Claiming a resolved position into market escrow, followed by a separate withdrawal.

Every action is prepared unsigned, reviewed, and approved by the selected linked wallet. Reviews include market identity, mint, exact financial intent, network fee and applicable account rent estimates. Registering a seat is permanent. A changing book can invalidate a prepared nonce, and order execution may differ within the reviewed limit; the UI never silently retries with a new signature.

`useChainTransaction` coordinates the wallet page's receipt namespace and cross-tab submission lock. It verifies runtime, configuration, network and account link before and after signing, persists signed bytes before the single broadcast, and recovers status without sending. Account changes abort pending work. Unknown or expired outcomes block further signing; failed transactions unblock only with finalized evidence. The page rereads finalized balances and orders after recovery.

The public catalog remains separate: this direct route does not publish a hidden DRAFT database catalog entry. No synthetic history, price chart, database balance, or automatic funding is added.

## Browser verification

```sh
GOOSEY_SOLANA_VALIDATOR_BIN=/absolute/path/to/solana-test-validator npm run test:browser:chain-market
```

Requires the compiled Goosey program, installed dependencies and Playwright Chromium. The runner owns a new validator, SQLite database, app server and ephemeral Wallet Standard keys. It creates a real market, obtains two independent reviewer acceptances, seals the exact terms and activates the market. Existing retained validators and app balances are untouched.

The journey claims an authorized grant, registers the trader's seat, deposits collateral, places a resting limit order, cancels it, and withdraws. It checks finalized on-chain balances after every operation. A forwarded cancellation loses its RPC response; reload must recover the persisted signature without duplicate signing or sending. Altered manifest bytes must block approval. Screenshots and account/transaction evidence are written to `output/playwright/chain-market`.

This test covers the resting-order lifecycle and recovery, not every matching combination or resolved-market claim. Those preparation branches also have focused unit tests; program-level matching and settlement verification remain separate. The test Wallet Standard implementation uses genuine signatures but does not prove compatibility with every wallet extension.
