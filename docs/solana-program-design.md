# Goosey: Solana program architecture

Research date: **2026-09-19**. Scope: architecture and an isolated chain foundation; Next.js integration and toolchain provisioning belong to the main integration work. This document is a design, not a claim that the exchange is already deployed or a security audit.

Implementation checkpoint: the isolated [chain foundation](../chain/README.md) now compiles for host and SBF and implements issuance plus SPL escrow. It does **not** implement the matcher or oracle yet. The README records its exact stable accounts/seeds, build evidence, and runtime-test handoff. The remaining sections describe the target full exchange; they must not be used to claim all features are already available.

## Integration snapshot

The user's final currency decision supersedes the earlier nontransferable proposal: **free, nonredeemable feathers MUST transfer between users through real Solana transactions, on localnet/devnet only**.

Build a dedicated Anchor exchange with **fully onchain price/time matching**, a standard **SPL Token feather mint with exactly 3 decimals**, wallet associated token accounts, and per-market PDA-controlled SPL escrow. One token base unit is one existing milli-feather. Outcomes remain program-owned YES/NO positions. Users sign token transfers and deposits; the program signs vault withdrawals and capped issuance with PDAs. The server never holds a key that spends user tokens. There is no SOL/USDC purchase, cash redemption, bridge, mainnet deployment, or mainnet balance import.

Immediate dependency target: **Anchor CLI, `anchor-lang`, and `anchor-spl` 1.2.0**, Rust edition 2021, **Rust >=1.89**, Solana CLI **4.1.2** as recommended by Anchor's release notes. These are source-verified recommendations, not a locally tested toolchain matrix. Use Anchor's Solana types/re-exports; its workspace uses the Solana 3.x split crates. The SBF platform compiler also must support the language/dependency requirements; a new host `rustc` alone is insufficient. Pin the tested toolchain and Cargo.lock after main provisions it. [A1–A4]

Suggested program dependencies (for the isolated chain workspace, not the app manifest):

```toml
[dependencies]
anchor-lang = { version = "=1.2.0", features = ["event-cpi"] }
anchor-spl = { version = "=1.2.0", default-features = false, features = ["token", "token_2022", "token_2022_extensions", "associated_token"] }
bytemuck = { version = "=1.25.2", features = ["derive", "min_const_generics"] }

[features]
default = []
no-entrypoint = []
cpi = ["no-entrypoint"]
idl-build = ["anchor-lang/idl-build", "anchor-spl/idl-build"]
```

Use `Program<Token>`, `Account<Mint>`, and `Account<TokenAccount>` for the original SPL Token program, explicitly excluding Token-2022 and arbitrary token programs at runtime. A local compile established that Anchor 1.2.0's mint-init account macro also needs the `token_2022` and `token_2022_extensions` features; those build features do not authorize Token-2022 accounts. Its `CpiContext::new` takes a program public key, not an AccountInfo, despite older examples. Bytemuck 1.20 from the documentation example conflicts with the current SPL interface dependency graph; 1.25.2 resolves and compiles here. No OpenBook/Phoenix runtime dependency is required. [A4–A6]

Main can integrate against these boundaries now:

| Boundary | Contract |
| --- | --- |
| Currency | `FEATHER_DECIMALS = 3`; amounts are unsigned integer base units, serialized as decimal strings at JSON boundaries |
| Claim | Enrollment authority authorizes a capped allowance; connected wallet claims into its own feather ATA; only the program mint-authority PDA can mint |
| Send feathers | Wallet signs SPL `TransferChecked` with decimals 3 to the recipient's feather ATA; optional idempotent ATA creation; server only sponsors/relays |
| Trade funding | User signs `deposit(market, amount)`; SPL transfer to market vault and credit to their market seat are atomic |
| Withdraw | User signs `withdraw(market, amount)`; only available seat cash can return to the same user's feather ATA |
| Orders | `place_order`, `cancel_order`, `replace_order`; book chooses makers and prices onchain; no server-submitted fill allocation |
| Oracle | `propose_result`, `reject_result`, `approve_result`; two eligible distinct identities; evidence digest and immutable market rules |
| Settlement | Permissionless bounded close/drain and redemption to the predetermined seat; owner can withdraw feathers afterward |
| Authority | Solana state is authoritative; Prisma becomes a projection for these markets, never a second matching engine |

Standard transferable SPL tokens cannot enforce current web-login eligibility on every wallet-to-wallet transfer. Current authentication gates enrollment, grant authorization, and exchange participation; external token transfers remain owner-authorized. Nonredeemable means Goosey offers no cash conversion, not that transferable tokens can make private resale or key sales technically impossible. Wallet visibility means a standard token account/mint; automatic display of the Goosey name/icon additionally depends on wallet metadata support and may require importing the devnet mint. [T1–T3]

## 1. Research method and architecture choice

Read official Solana and Anchor documentation, followed relevant release/manifest, account, token, event, and transaction links, and inspected official Phoenix and OpenBook matching source. Follow-ups were bounded to the mechanics needed here; no third-party performance claims or deployed program IDs are adopted as dependencies. Sources and exact URLs are recorded below with this access date.

Polymarket is a useful product reference, but its documented workflow has an operator matching signed orders and settling on Polygon. That is a **hybrid**: authorization and settlement onchain do not imply onchain order discovery or globally enforced price/time priority. [P1]

| Approach | Matching authority and storage | Fit |
| --- | --- | --- |
| Dedicated Goosey program | Orders, priority, escrow, fill selection, outcome accounting, and final result all in program state | Recommended; matches the explicit full-onchain requirement and existing four-way binary accounting |
| Signed offchain order service | Service stores/sorts orders and chooses fills; program verifies signatures, limits, cancellation nonces, and settlement | Not selected; lower onchain storage does not meet the requested matching model |
| Existing Phoenix/OpenBook spot market | Real onchain matching, but token-pair market semantics and account model | Useful references, not drop-in binary prediction settlement with Goosey oracle/fee semantics |

Phoenix's source demonstrates a FIFO order key and market-local trader state; its repository describes atomic settlement without a crank. OpenBook's matcher can process maker effects immediately when accounts are supplied, otherwise append them to an event heap consumed later. Both are onchain matching; an onchain event crank is not the same as an offchain matcher. Choose Phoenix-like immediate internal settlement, without copying its token economics or claiming compatibility. [D1–D4]

## 2. Existing Goosey semantics to preserve

Inspected working-tree files on the research date. References identify current functions, not a guarantee that concurrently edited line numbers remain stable.

| Existing source | Observed behavior | Solana disposition |
| --- | --- | --- |
| `src/lib/order-book.ts`: `normalizeToYesBook`, `matchOrder` | One canonical YES book; best price then ascending priority sequence; execution at maker price | Preserve; sequence assigned by program acceptance, never browser time |
| `src/lib/order-book-accounting.ts`: `classifyFillEconomics`, `planFillJournal` | Complementary buys mint pairs; complementary sells burn pairs; same-outcome trades transfer positions | Preserve exactly, with SPL collateral backing internal cash |
| `src/lib/order-entry.ts`; `market-maker.ts` constants | Whole contracts; milli-feathers; default payout 100,000 milli = 100 feathers; max quantity 10,000,000, payout <=1,000,000 | Preserve units and bounds; no float or implicit one-feather payout |
| `src/lib/order-exchange.ts`: `reserveAssets`, `adjustReservationAfterFill` | Buys reserve limit principal + fees; sells reserve owned shares; price improvement releases surplus | Preserve atomically |
| `existingExecutedNotional`, `applyFill`, `replaceOrder` in the same file | Both parties charged market `feeBps`; cumulative rounding follows the entire replacement chain, including maker/taker role changes | Store cumulative chain notional explicitly; do not reset it at replacement |
| `placeOrderRequestSchema`; `src/lib/order-options.ts` | GTC, IOC, FOK; post-only and expiry only for GTC; three STP modes; reduce-only rejected | Preserve; no unsupported flags silently accepted |
| `replaceOrder` | Atomic cancel/replace, expected version, new priority even for smaller quantity; rejected post-only replacement keeps original | Preserve; retain outcome/action and chain accounting |
| `drainMarketOrderBook`; `src/lib/admin-service.ts`: lifecycle transitions | Pause and close drain all live orders, despite persisted `cancelOnPause` flag | Preserve effective behavior; bounded onchain draining introduces a visible intermediate state |
| `src/lib/admin-service.ts`: resolution functions | Creator cannot propose/approve; distinct reviewers; any historical trade disqualifies reviewer; close and resolution times must have elapsed | Preserve with registered identities and permanent `ever_traded` state |
| `src/lib/settlement-payout.ts`; `settlement-service.ts` | YES/NO pays winning holdings; VOID pays floor of combined YES+NO half-payout; book must drain; leftovers returned only after all settlements | Preserve arithmetic; replace database leases with deterministic permissionless claims |
| Prisma `MarketOrder`, `OrderCommand`, `OrderReservation`, `OrderFill` | Unique client IDs, version checks, durable command replay, sequenced effects | Replace with scoped nonces, receipts, unique chain IDs, revisions, and events |

Existing ORDER_BOOK balances and legacy LMSR state are different. No automatic migration of legacy LMSR liabilities, treasury subsidies, email identities, or live database wallets is implied. New localnet/devnet markets start empty; test inventory comes from real claims, deposits, and matching instructions. Existing sandbox fixtures stay isolated.

Cost basis and realized P&L are reporting data. Reconstruct their existing proportional basis allocation and fee treatment from indexed fills/redemptions; they must not authorize spending or substitute for onchain positions. Preserve the current tests as reference cases rather than treating a copied Prisma row as chain state.

## 3. Feather issuance, transfers, and escrow

### Token choice

Use an original SPL mint with immutable 3-decimal precision, program mint authority, and no freeze authority. No transfer tax, interest, rebasing, permanent delegate, or transfer hook. This makes amounts received equal amounts sent and gives normal wallet transfer support. Token-2022 NonTransferable explicitly prevents moving tokens, contradicting the final instruction; discard it. Program-owned balances with a custom `transfer` instruction could perform real Solana transfers of ledger credit, but would need a custom wallet/explorer experience and would not appear as ordinary SPL assets. Use them only inside escrow. [T1–T4]

`Config` records the approved mint, fixed token program, enrollment authority, grant caps, environment label, and operational authorities. Initialization is authorized by the program's actual deployment/upgrade authority or an explicitly supplied bootstrap authority agreed by main; never permit the first arbitrary caller to select authorities. Mint address and authority are immutable after initialization for this version.

Enrollment uses the current authenticated account as the eligibility source. The issuer submits an onchain allowance for a wallet plus an opaque, domain-separated enrollment identifier (no email/public PII). A permanent grant record binds that enrollment identifier to the wallet. Enforce both enrollment uniqueness and wallet uniqueness for the configured grant campaign; wallet relinking cannot earn another allocation. Authority approvals may be transactions, avoiding an initial detached-signature verifier. User wallet signs the claim, the program verifies the allowance/campaign/expiry, updates claimed amounts, then invokes SPL minting with PDA signer seeds. The fee payer may be a sponsor; the sponsor is not token authority. [T2, S3]

Set the actual per-person and campaign totals explicitly during initialization from the intended development configuration; do not invent a grant balance in code. Use checked `u64` units and `u128` intermediates, a lifetime minted counter (not current mint supply), and a campaign ceiling. Burning feathers must not reopen issuance quota. The program is the sole mint authority; enrollment authority can authorize grants within caps but cannot mint directly, move wallet tokens, or withdraw a user's market cash. Preserve spent grant records across resets of web sessions or recreation of token accounts.

Transfers are direct SPL `TransferChecked` transactions signed by the token-account owner. Include ATA creation when needed. Neither registration nor being logged into Goosey is necessary for the SPL Token program to validate a recipient. A received balance does not automatically grant eligibility to trade or claim. Show wallet balance and escrowed market balance separately; only wallet balance is immediately transferable. [T1]

### Backing and vault invariants

Each market has one feather vault token account controlled by that market's PDA. Deposit moves existing SPL feathers into the vault and credits the depositor's seat in the same transaction. Withdrawal debits only available seat cash and transfers from that vault to the owner's ATA. No generic destination or admin withdrawal of user balances.

For every market, at every successful instruction boundary:

```text
accounted_vault = sum(seat.available_cash + seat.reserved_cash)
                  + market.outcome_collateral + market.fee_revenue
actual_SPL_vault_amount >= accounted_vault
sum(order.cash_reserve) = sum(seat.reserved_cash)
sum(order.YES_reserve) = sum(seat.reserved_YES)
sum(order.NO_reserve)  = sum(seat.reserved_NO)
seat.reserved_YES <= seat.YES; seat.reserved_NO <= seat.NO
```

Use `>=` because anyone may directly send SPL tokens to a known vault. Such unsolicited transfers are unallocated surplus and grant no depositor credit. Never use actual vault balance as permission to mint positions or inflate user balances. Track `accounted_vault` and bucket aggregates; deposits/withdrawals adjust it, internal fills do not. Normal flows preserve equality; explicit surplus reconciliation may classify donations without assigning them to an arbitrary user. Fees remain separately accounted feather tokens; any fee withdrawal is capped to fee revenue and has a fixed configured recipient.

Token account lamports pay rent; SOL transaction fees are independent of feather accounting. A free feather grant is not free network execution. Devnet SOL/sponsorship is an integration concern, not a feather purchase mechanism.

## 4. Accounts and execution layout

Use small Anchor accounts for configuration and authorization; fixed-layout zero-copy accounts for market-local books and seats. Keep data associated with a fill available without requiring the taker to supply each maker wallet. [A5, A6]

| State | Address/binding | Principal fields |
| --- | --- | --- |
| Config | PDA `["config"]` scoped by deployed program ID | schema version, environment/genesis domain, mint, issuer/admin keys, immutable cap parameters |
| Mint authority | PDA `["mint_authority", config]` | PDA signer only; no private key |
| Feather mint | PDA `["feather_mint", config]`, owned by SPL Token | decimals 3, mint authority PDA, freeze authority None |
| Enrollment/grant | PDAs keyed by config + enrollment digest and config + wallet | unique identity binding, allowance, claimed amount, eligibility, campaign/version |
| Market | PDA `["market", config, market_id_bytes]` | creator, rules digest, close/resolve times, payout, fee bps, book/seat account addresses, status, sequences, collateral/revenue totals |
| Market vault | ATA for market PDA + feather mint | real SPL feathers; only market PDA authorizes debits |
| Book storage | Program-owned large account bound once in Market | bid/ask heaps, order slab/free list, slot generations, per-order cash/share reserve, chain fee counters |
| Seat storage | Program-owned large account bound once in Market | wallet/enrollment identity, status, cash/positions/reserves, nonce, active-order count, permanent ever-traded flag |
| Seat locator | PDA `["seat", market, wallet]` | immutable seat index/generation; owner binding; prevents duplicate registration |
| Command receipt | PDA `["command", market, wallet, nonce_le]` | canonical payload digest, command kind, result, order ID, event range |
| Result proposal | PDA `["result", market, proposal_sequence_le]` | outcome, evidence/rules digests, proposer, approver, timestamps, status |

All seeds include fixed domain/version choices; specify byte order and field serialization in the IDL/client package. Check account owner, discriminator, market/config binding, signer, mint, token program, vault authority, and ATA destination. Reject duplicate alias accounts where distinct roles are required. No client-provided seat index may override the immutable locator's wallet binding.

Large storage accounts can be keypair-addressed program-owned accounts created by a top-level System instruction, then initialized and bound to Market atomically. They need not be PDAs. This avoids pretending that a large PDA can be created by a single Anchor `init` CPI. Anchor documents a 10,240-byte `init` limit and `zero` initialization for larger preallocated accounts. Never expose a partly initialized tradable market. Use bounded initialization or metadata/free lists without constructing entire large arrays on the stack. [A5]

The market hot path writes Market, Book, Seats, a receipt, and payer state as needed; ordinary fills make no token CPI and do not write the global mint/config. Deposits and withdrawals additionally write the vault and wallet ATA. Markets can execute independently; a single market is intentionally serialized by its mutable state. Wallet transfers outside the exchange do not lock books.

## 5. Exact matching and arithmetic

### Price/time rules

Normalize public limit `p`, payout `P`, and intent into the canonical YES book:

| User intent | Book side | Canonical limit |
| --- | --- | --- |
| BUY YES | bid | p |
| SELL YES | ask | p |
| BUY NO | ask | P-p |
| SELL NO | bid | P-p |

Bids sort by descending price then ascending accepted sequence; asks by ascending price then ascending sequence. Every accepted order/replacement receives a checked monotonically increasing sequence. Fill at the resting maker's canonical price; user's NO execution price is `P - maker_price`. Chain acceptance order is the fairness boundary; client timestamps, RPC arrival order, or wall-clock nanoseconds cannot establish network-wide priority.

Recommended initial structure: two binary heaps of order-slot indices over a fixed slab. Heap comparators include price and sequence, each order stores its heap position, and cancellation/removal updates that position during swaps. This gives bounded O(log N) insert/delete without sorting the full book. A slot generation/order sequence prevents stale cancel requests from affecting a reused slot. Keep original intent beside normalized price for accounting.

### Four fill paths

For a fill of `q` whole contracts at canonical YES price `x`, `Y=x*q`, `N=(P-x)*q`, and `Y+N=P*q` exactly:

| Counterparties | Principal movement | Position movement |
| --- | --- | --- |
| BUY YES + BUY NO | Debit each buyer's reserve by Y or N; increase collateral by P*q | Issue q YES and q NO |
| SELL YES + SELL NO | Decrease collateral by P*q; credit gross proceeds Y and N | Destroy q YES and q NO |
| BUY YES + SELL YES | Buyer reserve pays Y to seller | Transfer q YES; collateral unchanged |
| BUY NO + SELL NO | Buyer reserve pays N to seller | Transfer q NO; collateral unchanged |

Fees additionally debit buyers' cash reserves or reduce sellers' proceeds and credit fee revenue. Mint/burn in this table refers to **outcome positions**, never feather minting. Trading cannot change feather supply. Before final result, total outstanding YES equals NO and `outcome_collateral = P * total_outstanding_YES`; reject any instruction that would violate this equality. There is no short selling, unbacked credit, or administrative setting of positions.

### Numerical contract

Amounts/reserves/notionals use checked `u64`; products and fee computations use checked `u128`; signed P&L, if materialized, is reporting-only. Quantities are whole contracts with the current 10,000,000 bound, prices satisfy `0 < p < P`, and `2 <= P <= 1,000,000`. Enforce aggregate seat/market bounds in addition to per-order bounds. Explicitly check downcasts. No float, saturating arithmetic, wrapping sequences, or conversion through JavaScript Number for monetary fields.

Keep a single immutable market fee `b` in `[0,10000]`, applying equally to maker and taker as today. A chain's cumulative fee is:

```text
F(n) = floor(n*b / 10000) + (n*b % 10000 != 0 ? 1 : 0)
fill_fee = F(previous_chain_notional + fill_notional) - F(previous_chain_notional)
buy_reserve = user_limit * remaining_quantity
              + F(chain_notional + user_limit * remaining_quantity)
              - F(chain_notional)
```

This telescopes across fragmented fills, role changes, and replacements. Copy the cumulative chain notional/charged fee to the replacement; do not charge another initial rounding increment. A new independent order starts a new chain. Reject mid-market fee changes in this version, rather than retroactively repricing historical notional. Sells reserve shares, with fees deducted from proceeds. Bounds on `b` guarantee the incremental fee does not exceed the positive integer fill principal.

After every fill, recompute the remaining buy reserve using the original user-side limit and release the excess; release all unused reserves on terminal cancellation/expiry. Use the same accounting for STP cancellation, pause draining, and rejection cleanup.

## 6. Orders, limits, and command replay

GTC matches then rests the unfilled quantity only after no executable cross remains. IOC executes a bounded best-price prefix and cancels its remainder. FOK must execute the entire requested quantity atomically or have no trading effect. Post-only rejects if a valid crossing maker exists, including a same-owner maker as the existing matcher does; it never converts to IOC. Expired makers cannot trade. STP uses registered identity (wallet by default): CANCEL_AGGRESSOR stops the incoming remainder, CANCEL_RESTING removes the same-owner maker and continues, CANCEL_BOTH removes that maker and stops incoming remainder. No cross-wallet identity equivalence is claimed without enrollment evidence.

Use a protocol-defined maximum work count that includes fills, expired nodes, STP removals, heap operations, and emitted events. A proposed starting bound is 16 touched makers per matching instruction, subject to measurement. Do not count only successful fills. IOC may stop and cancel at the bound; GTC/FOK reject atomically with `MatchLimitExceeded` if satisfying their semantics needs more work. Never rest a still-crossing GTC or skip a better order to reach a supplied maker. A preflight simulation is advisory; validate against actual state again. No hidden multi-transaction FOK and no continuation queue that changes FIFO priority.

`expire_orders` and lifecycle `drain_orders` are permissionless and bounded; release assets to the owning seats. They allow callers to remove stale orders before a new order that otherwise exceeds its work budget. Expiry uses Solana Clock seconds (`now >= expires_at`); clients explicitly convert their millisecond timestamps. Store an instruction deadline to prevent very late submissions even for nonexpiring GTC orders.

Each user command has a market-scoped monotonically increasing nonce, instruction kind, deadline, expected revision where relevant, and canonical payload hash. Hash domain includes program ID, config/deployment domain, market, wallet, and schema version. Successful processing records a receipt and increments nonce atomically. Same nonce plus same payload returns the recorded outcome without effects; same nonce plus different payload errors. A nonce behind the counter without a receipt is stale, never executable. Retain receipts/seat nonces for the initial version; receipt pruning must not enable replay or reset account identity.

Transaction blockhash/signature replay protection alone is insufficient: a user can re-sign the same logical order with a fresh blockhash. The receipt supplies logical idempotency. Solana durable transaction nonces are a separate network mechanism and do not replace application order nonces. [S4]

Business rejections can commit a receipt with `accepted=false` and no financial changes; actual invalid-account/arithmetic failures abort the transaction and cannot persist receipts. Document that failed transactions can still consume SOL fees. Cancel/replace carries order ID + generation and optional/required expected version as in the current API. Replacement always gets new FIFO priority; validation, reserve adjustment, old cancellation, and new execution occur atomically.

Direct wallet SPL transfers have no Goosey receipt unless wrapped. Persist the signed transaction/signature before broadcasting, rebroadcast identical bytes, and query confirmation before offering a fresh transfer. Do not automatically re-sign an ambiguous transfer with a new blockhash, which could send twice. A later transfer-wrapper instruction can add application idempotency if product requirements demand it; it must still require the user's signer and call real SPL instructions.

## 7. Two-person results, closing, voiding, and redemption

Market rules include immutable question/rules/evidence-source digest, creator, `closes_at`, `resolves_at`, P, fee rate, and allowed outcome enum YES/NO/VOID. Long explanatory content may live offchain with an onchain digest and retrievable URI; the program cannot read a website or prove a real-world event. This is an explicit human oracle, not decentralized truth discovery.

```text
DRAFT -> OPEN -> PAUSING -> PAUSED -> OPEN
              \-> CLOSING -> CLOSED -> RESULT_PENDING -> RESOLVED / VOID
                                         ^    |
                                         |____| reject proposal
```

The reject arrow returns to CLOSED; a new proposal gets a new proposal sequence. Close can also start from DRAFT/PAUSED. `Clock >= closes_at` forbids new matching even if no keeper has recorded CLOSING. Early administrative close disables trading but does not bypass the original close/resolve deadlines for oracle approval.

Pause/close first set an irreversible trading barrier for that transition. Bounded crank calls cancel all orders and release reserves. This preserves the current effective cancel-on-pause behavior; `cancelOnPause=false` must not imply persistence in the new client. Finalize PAUSED/CLOSED only when active-order and reserve aggregates are zero. Resume requires completed pause draining and a future close time. Closing a market is not closing its rent-bearing accounts.

An eligible registered oracle proposes an immutable outcome plus reason/evidence digest only after CLOSED and both contractual times. Exactly one pending proposal per market. Another eligible identity approves that exact proposal digest, or rejects with a reason. Neither may be the creator; neither may have ever traded that market, even if positions are now zero. Persist `ever_traded` across exits and wallet enrollment bindings. Two keys prove two authorized keys; the current enrollment process must enforce two distinct people. This is an operational trust assumption, not something Solana signatures establish.

Approval freezes the outcome permanently and enables redemption after the drain invariant holds. No single admin result override, silent VOID fallback, or post-redemption correction. If reviewers are unavailable, claims wait; a replacement-reviewer governance policy is separate from granting one operator settlement discretion.

`redeem_for(seat)` can be submitted by anyone but only credits that seat's cash and consumes **all** its remaining YES/NO holdings exactly once. No caller-supplied payout destination, partial VOID redemption, or concurrent position transfer after close:

```text
YES:  payout = P * yes
NO:   payout = P * no
VOID: payout = floor(P * (yes + no) / 2)
```

Combine before division to preserve the existing behavior for odd P. Default P=100,000 is even and has no VOID rounding dust; odd P can leave a bounded residual across separate owners. Decrement collateral and outstanding supply by the actual consumed positions and payout, set positions to zero, and credit available market cash. Losers also consume their zero-value claims so outstanding-position counters reach zero. Repeated claims are harmless/no-op or return an explicit already-redeemed status.

Outcome redemption pays feathers already in SPL escrow, **not** SOL, USDC, or fiat. The user may then withdraw or transfer those feathers. Final settlement completion requires all position quantities and order reserves zero; only then classify any outcome rounding residual into the configured fee/treasury bucket. Never sweep collateral based on a timeout while claims remain. Keep withdrawal available after resolution; do not reclaim market/seat storage rent while user balances remain. Permissionless bounded `redeem_batch` gives the existing worker a useful keeper role without privileged accounting.

## 8. Capacity and compute plan

Start with a declared development tier of **1,024 active order slots and 256 permanent seats per market**, with the existing per-user ceiling of 100 orders. These are proposed implementation capacities, not measured throughput or parity with the database's 10,000-order market limit. Expose capacity errors before funding/placement where possible. Expand through explicit tested layout versions, not silent eviction of worse orders or dropping FIFO entries.

Planning budget: at most 256 bytes/order (~256 KiB), 256 bytes/seat (~64 KiB), two 1,024-entry u32 heap-index arrays (8 KiB), plus headers/free lists. Aim below 384 KiB combined market data. Actual `size_of`, alignment, discriminators, and offsets determine allocation and rent; compile-time assertions and SBF tests must confirm them. Zero-copy types use fixed arrays, explicit padding, and POD-safe fields; do not place native enum/bool/pointer/Vec representations into the persistent ABI. [A5]

Solana docs currently state a 1,400,000 CU transaction ceiling, 4,096-byte stack frames, default 32 KiB heap, and 10 MiB maximum account size. These are ceilings, not a throughput estimate. Simulate fill/expiry/STP/drain worst cases, account creation, and event emission; retain headroom under the selected budget. Test account locking and wall-clock contention separately. [S1, S2]

There is a relevant 2026 change: official docs report v1 transactions live on devnet as of this research date, with 4,096-byte transactions; legacy/v0 remain 1,232 bytes. The rollout page lists local validator support starting at CLI 4.2+, while Anchor 1.2.0 recommends CLI 4.1.2. Initial Goosey instructions must fit the legacy/v0 envelope and not require v1. Account-lock limits and loaded-data limits still apply; address lookup tables reduce address bytes, not writable contention or compute. Treat runtime feature settings as measured facts of main's selected local validator. [S1, S5, A2]

Use one bounded batched event payload per command where practical, rather than a self-CPI per fill; instruction trace limits and event size count toward the execution budget. A larger devnet book is a benchmark/migration milestone, not a reason to fall back silently to offchain matching.

## 9. Indexing and application integration

Emit versioned events for enrollment/claim, market creation/status, deposits/withdrawals, order acceptance/rejection, fill, cancellation/expiry/replacement, proposal/review, and redemption. Every market economic command increments a market event sequence; each effect has an index. Fills include both original intents, owner/seat IDs, order/chain IDs, canonical price, quantity, both fees, and enough balance deltas to reproduce reporting.

Anchor logs may be truncated. Prefer `emit_cpi!` for a bounded batch with its extra compute/account cost measured. Transaction history availability still depends on RPC retention; CPI events are not a permanent history service. Read full confirmed/finalized transaction metadata and ignore all effects of transactions with `meta.err != null`. Events emitted before an instruction failure are not committed accounting. [A7]

Subscribe for low-latency updates, persist a finalized cursor, backfill with paginated `getSignaturesForAddress` and `getTransaction`, deduplicate by cluster genesis + program ID + signature + instruction/effect index, and reconcile market event-sequence gaps. Keep provisional UI state distinct from finalized projections and support rollback/rebuild when a confirmed fork disappears. Periodically reconcile vault balances, buckets, positions, reserves, and order counts against account snapshots. Use an archival provider or retained development ledger when history is needed; state snapshots restore current balances but cannot fabricate missing historical fills. [S6, S7]

Wallet-to-wallet SPL transfers bypass Goosey events. Index relevant token accounts/owner token balances and token transaction metadata separately; support account creation/closure and recipient discovery. Do not expect a subscription to the Goosey program address to observe every feather transfer. Token balance snapshots remain authoritative for wallet balances. Reconcile supply with lifetime issuance and actual burns, rather than assuming supply only increases.

The indexer must understand transaction versions accepted by its RPC/SDK. Current Solana rollout docs list v1-reading support separately from v1 construction; do not hard-code `maxSupportedTransactionVersion: 0` as a universal devnet-history assumption. Confirm the client used by main can read v1 and its `transactionConfig`, even when Goosey only submits legacy/v0. [S5]

For chain-backed markets, existing API mutation routes must construct/relay wallet-signed instructions and return pending/signature/confirmed outcomes. They must never write speculative financial state to Prisma or execute the database matcher after RPC failure. Keep comments, notifications, editorial content, authentication, and searchable projections offchain. An offchain index or transaction builder does not make matching hybrid: it cannot choose fills, prices, or balances.

Main owns wallet linking/session consent, RPC/genesis allowlists, generated IDL client, fee sponsorship, UI transfer/funding screens, and route cutover. Chain code cannot securely infer a network's genesis hash from a caller-supplied label: enforce localnet/devnet in deployment/client configuration and verify RPC genesis; a program environment field is an additional domain marker, not proof that nobody could deploy the binary elsewhere. No production database is migrated or reset as part of this foundation.

## 10. Implementation and verification sequence

1. **Currency foundation.** Freeze seeds/IDL with main; provision the isolated pinned toolchain; initialize authenticated config, 3-decimal SPL mint with PDA authority, enrollment allowances and capped claims. Establish real ATA-to-ATA transfers signed by users. Compile and test real program/token instructions before adding exchange state.
2. **Escrow and invariants.** Implement market creation/storage, seat registration, SPL deposits/withdrawals, counted backing, and typed exact arithmetic. Confirm wrong mint/program/owner rejection and unsolicited vault transfers without credit inflation.
3. **Full onchain matcher.** Implement heaps/slab, sequence allocation, four fill paths, cumulative chain fees, reserves, GTC/IOC/FOK/post-only/STP, nonce receipts, expiry and atomic replacement. Maintain parity fixtures using current pure TypeScript matcher/accounting results as an independently checked oracle.
4. **Lifecycle/oracle.** Implement pause/close barriers and bounded drains, immutable result proposal and second-party approval/rejection, permanent trading-conflict flags, one-shot redemption and bounded batch processing, final dust classification.
5. **Projection integration.** Main replaces the backend of selected development markets with generated instructions and chain projections. Exercise public wallet transfers and user-funded orders with actual signatures and confirmed transactions. Existing database markets remain explicitly identified during the transition.
6. **Capacity acceptance.** Benchmark the declared order/seat tier at worst price dispersion, many same-price makers, expiry congestion, full capacity, and close under concurrent submissions. Record CU, account sizes, transaction bytes, final balances, and failures; raise limits only from measurements.

Required tests (all economic integration setup through real instructions, never injected price/balance/fill account bytes):

| Area | Required cases |
| --- | --- |
| Claims/mint | Authorized enrollment; unauthorized issuer; duplicate enrollment/wallet; over-cap and expired grant; repeated claim; lifetime cap after burn; account recreation; mint authority is PDA, no freeze authority |
| Real transfers | Claim to A's ATA, A signs `TransferChecked` to B; exact 3-decimal debit/credit and unchanged supply; absent recipient ATA creation; wrong decimals/mint; overspend; missing A signature; no server key can spend A; failed CPI rolls back |
| Escrow | A deposits through SPL CPI; exact vault/seat credit; unauthorized/wrong destination withdrawal; reserved cash cannot leave; external SPL donation gives no credit; no trading path mints feathers |
| Arithmetic | Checked boundary products; all four intent pairings in both maker directions; price improvement; cumulative fee telescoping including role changes/replacements; full fee bound; odd/even VOID P; complete-pair solvency |
| Matching | Equal-price FIFO, better-price precedence, NO normalization, partials, empty/full books, same-owner STP variants, rejected post-only, atomic FOK, bound exhaustion, slot reuse, expired best order, failed replacement retains original |
| Replay/concurrency | Same receipt/same payload, nonce conflict, re-sign with fresh blockhash, stale order revision, parallel cancels/fills/replacements, receipt retention, no double redemption, no fresh retry of ambiguous direct transfer |
| Lifecycle | Close-time boundary without keeper; pause drains all; no resume before drain; creator cannot resolve; historic trader with zero position disqualified; same reviewer cannot approve; mismatched evidence; replayed approvals; keeper restarts |
| Indexing | Failed-tx events ignored; duplicate delivery; missed subscription/backfill; confirmed fork rollback; RPC retention gaps; v1 reading; transfers absent from Goosey logs; snapshot/accounting reconciliation |

Pure Rust arithmetic/heap tests should be supplemented by LiteSVM loading the actual compiled program and real SPL programs, plus local-validator RPC tests and an explicit devnet smoke run when main authorizes deployment. LiteSVM is useful for time boundaries and transaction execution; it does not replace RPC/finality tests. Do not disable signature checking in the transfer acceptance tests or call arbitrary account setters to manufacture economic balances. Test fixtures are legitimate deterministic scenarios executed by the real services. [A8]

Completion evidence must distinguish host `cargo test`, SBF compilation, local-validator execution, and devnet signatures. No passing unit suite establishes that the deployed binary, wallet flows, or capacity target work. This document itself makes no deployment or benchmark claim.

## Sources (accessed 2026-09-19)

All external claims above use official primary documentation or official source repositories. Descriptive architecture, capacity choices, and implementation policies are recommendations derived from Goosey's requirements, not claims that the cited protocols implement Goosey's design.

- **A1:** [Anchor installation](https://www.anchor-lang.com/docs/installation) — toolchain setup and CLI pinning; example Rust versions are not the authoritative MSRV.
- **A2:** [Anchor 1.2.0 release notes](https://www.anchor-lang.com/docs/updates/release-notes/1-2-0) — recommends Solana 4.1.2.
- **A3:** [Anchor 1.2.0 language manifest](https://raw.githubusercontent.com/otter-sec/anchor/v1.2.0/lang/Cargo.toml) and [workspace manifest](https://raw.githubusercontent.com/otter-sec/anchor/v1.2.0/Cargo.toml) — Rust 1.89 minimum, edition, Solana dependencies and features.
- **A4:** [Anchor 1.2.0 SPL manifest](https://raw.githubusercontent.com/otter-sec/anchor/v1.2.0/spl/Cargo.toml) — token/ATA feature names and interface dependency versions.
- **A5:** [Anchor zero-copy](https://www.anchor-lang.com/docs/features/zero-copy) — AccountLoader, fixed layouts, large-account initialization. Use source/compiled layout assertions when examples and prose disagree about packing.
- **A6:** [Anchor account constraints](https://www.anchor-lang.com/docs/references/account-constraints) — signer/owner/seeds/address/token relationships.
- **A7:** [Anchor events](https://www.anchor-lang.com/docs/features/events) — logs, self-CPI events, truncation and compute tradeoffs.
- **A8:** [Anchor LiteSVM testing](https://www.anchor-lang.com/docs/testing/litesvm) — executing compiled programs and testing Clock; local validator remains necessary for RPC behavior.
- **T1:** [Solana token transfers](https://solana.com/docs/tokens/basics/transfer-tokens) — owner-authorized TransferChecked and base-unit amounts.
- **T2:** [Anchor minting with PDA authority](https://www.anchor-lang.com/docs/tokens/basics/mint-tokens) — mint authority and signer seeds.
- **T3:** [SPL Token specification](https://www.solana-program.com/docs/token) — token accounts, mint supply, authorities, transfers.
- **T4:** [Token-2022 extension guide: nontransferable](https://www.solana-program.com/docs/token-2022/extensions#non-transferable-tokens) — rejected alternative under the final user instruction.
- **T5:** [Anchor token transfers](https://www.anchor-lang.com/docs/tokens/basics/transfer-tokens) and [mint creation](https://www.anchor-lang.com/docs/tokens/basics/create-mint) — CPI account/authority composition.
- **S1:** [Solana constants reference](https://solana.com/docs/core/constants-reference) — account, stack, instruction trace, and runtime ceilings.
- **S2:** [Solana compute budget](https://solana.com/docs/core/fees/compute-budget) — transaction CU cap, simulation and requested budget.
- **S3:** [Solana PDAs](https://solana.com/docs/core/pda) and [account structure](https://solana.com/docs/core/accounts/account-structure) — deterministic program authority and ownership.
- **S4:** [Solana transaction confirmation/expiration](https://solana.com/developers/cookbook/transactions/confirmation) — retry/expiry considerations.
- **S5:** [Solana transaction structure](https://solana.com/docs/core/transactions/transaction-structure) and [v1 transaction rollout](https://solana.com/upgrades/larger-transaction-sizes) — current size limits, feature status and SDK/indexing implications.
- **S6:** [getSignaturesForAddress](https://solana.com/docs/rpc/http/getsignaturesforaddress) — signature history pagination.
- **S7:** [getTransaction](https://solana.com/docs/rpc/http/gettransaction) — transaction metadata, commitment and supported versions.
- **D1:** [Phoenix official repository](https://github.com/Ellipsis-Labs/phoenix-v1) — atomic onchain orderbook without a settlement crank; reference, not deployed dependency.
- **D2:** [Phoenix FIFO implementation](https://github.com/Ellipsis-Labs/phoenix-v1/blob/master/src/state/markets/fifo.rs) — price/sequence ordering and market trader state.
- **D3:** [OpenBook official matcher](https://github.com/openbook-dex/openbook-v2/blob/master/programs/openbook-v2/src/state/orderbook/book.rs) — matching and immediate/deferred maker effects.
- **D4:** [OpenBook consume-events instruction](https://github.com/openbook-dex/openbook-v2/blob/master/programs/openbook-v2/src/instructions/consume_events.rs) — onchain event settlement.
- **P1:** [Polymarket trading overview](https://docs.polymarket.com/trading/overview) — signed orders, operator matching/ordering and Polygon settlement.
