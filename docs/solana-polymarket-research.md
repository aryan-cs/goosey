# Goosey: Polymarket architecture and a fully on-chain Solana design

**Research date:** 2026-09-19 (America/Toronto)  
**Source policy:** Primary sources only: official Polymarket documentation and source repositories, official Solana documentation, and the canonical Phoenix/OpenBook repositories. Every source below includes the exact URL accessed on the research date. Product behavior and fee schedules can change; re-check the linked sources before deployment.

## Executive recommendation

Polymarket is not a fully on-chain CLOB. Its users sign orders off-chain, a privileged operator validates, orders, and matches them, and the operator then submits matches for atomic on-chain settlement. Its collateral, outcome tokens, fills, and resolution/redemption are on-chain, but the live book and matching authority are not ([P1], [P5]).

Goosey should not copy that trust boundary. For the requested fully on-chain Solana system:

1. Put market state, collateral custody, trader balances, resting orders, price-time priority, matching, fills, cancellations, fees, resolution, and redemption in a Solana program.
2. Have wallets submit signed Solana transactions directly. An optional relayer may pay SOL or forward bytes, but must have no authority to alter an order or choose a match.
3. Make matching permissionless and deterministic. Anyone can submit the next valid match/crank transaction; the program alone decides whether it is valid and which orders execute.
4. Keep PostgreSQL only as a rebuildable index/cache for search, charts, comments, notifications, and low-latency reads. A database row, API response, or hash anchored later on-chain must never be authoritative for an order, fill, balance, settlement, or resolution.
5. Use an explicit on-chain optimistic resolution state machine. External facts cannot be learned by a blockchain without trusted reporters; for Hack the North questions, that unavoidable oracle trust should be visible as bonded proposer/disputer roles and a governed final arbiter, not hidden in an admin database.

The deployment target for this phase is **local validator and Solana devnet only**. Feathers are free, nonredeemable game tokens with no cash deposit, cash-out, stablecoin backing, or promised monetary value. They are nevertheless real SPL tokens on the selected cluster: a user controls feathers in their token account and can transfer them directly to another user's token account with a signed Solana transaction.

This is a new economic backend, not a persistence adapter for the existing Prisma exchange. The current implementation remains useful as a behavioral specification and test oracle, but it must not remain the final source of truth.

## What Polymarket actually does

### Order book and execution boundary

Polymarket's current documentation says directly that orders are “created offchain, matched by an operator, and settled onchain” ([P1]). The lifecycle is:

1. The client creates an EIP-712 order containing outcome token, side, price, size, expiration, and a millisecond timestamp used for uniqueness, then signs it locally.
2. The order is sent to the CLOB operator. The operator checks signature, balance, allowance, and tick size.
3. The operator decides whether it rests or matches. The operator also applies configured delays for some markets.
4. When a match exists, the operator submits it on-chain. The exchange contract verifies signatures and atomically transfers outcome tokens and collateral.
5. The product exposes `MATCHED`, `MINED`, `CONFIRMED`, `RETRYING`, and `FAILED` trade states; `CONFIRMED` is the documented successful terminal state.

Cancellation before matching is likewise an operation through the CLOB API, not removal of an on-chain book node ([P1]). This means the operator cannot forge a user's signature or take arbitrary custody, but it can affect availability, inclusion, ordering, and matching latency. Calling Polymarket merely “on-chain” obscures that material trust boundary.

### On-chain settlement and complete sets

The current CTF Exchange V2 source describes operator-driven `matchOrders()` settlement and three execution paths ([P5]):

- **Complementary:** a buyer and seller exchange collateral and an existing outcome position.
- **Mint:** buyers of complementary outcomes contribute collateral that is split into a complete outcome set.
- **Merge:** sellers of complementary outcomes surrender a complete set, which is merged back into collateral.

The contract tracks fill state by order hash, validates signatures and crossing prices, applies fees, and settles atomically. V2 removed the older `NonceManager`; orders are tracked by hash with filled/remaining status ([P5]). Polymarket's lifecycle documentation separately states that the order timestamp contributes uniqueness ([P1]). Those are application-order identifiers, distinct from the Polygon account nonce used to submit the settlement transaction.

Polymarket's listed production contracts—CTF exchanges, Conditional Tokens, collateral adapters, and UMA adapters—are deployed on Polygon mainnet ([P4]). Winning positions are redeemed through the CTF collateral adapter; it burns outcome tokens and releases wrapped collateral ([P2]).

### Funding and transfer model: Polymarket versus Goosey

Polymarket's V2 collateral stack wraps USDC/USDC.e into pUSD and provides onramp/offramp contracts; resolved outcome claims redeem into pUSD ([P2], [P4], [P5]). That is a real-value collateral and redemption path.

Goosey must be deliberately different:

- one Goosey feather SPL mint exists only on the active local validator or devnet deployment;
- feathers are issued for free under an on-chain policy, not purchased, deposited from a bank/stablecoin, or redeemed for money;
- the mint authority is a Goosey program PDA, and each grant/claim is enforced and recorded on-chain (for example, a deterministic per-wallet `Claim` PDA prevents duplicate welcome grants);
- users hold unlocked feathers in their own associated token accounts (ATAs);
- a user-to-user transfer uses the SPL Token Program's `TransferChecked` path and the source owner or approved delegate signs it; transfers move balances without changing total supply ([S10]);
- only the mint authority can create new units, and minting increases the visible mint supply ([S11]);
- trading moves feathers into and out of program-controlled vault escrow on-chain; “unlock” returns the same feather token to the user's ATA and is not a cash withdrawal;
- there is no USDC bridge, fiat onramp, off-ramp, exchange-rate promise, or mainnet deployment in this phase.

Solana still requires SOL for transaction and account-storage costs. Local-validator SOL can be test-airdropped, devnet SOL comes from the devnet faucet, and Goosey may sponsor fees through a relayer without gaining authority over feather transfers or trades. Creating a recipient ATA has an on-chain storage cost, and the payer may be someone other than the token-account owner ([S12]).

### Resolution and oracle trust

Polymarket documents an optimistic resolution protocol through UMA ([P2]):

- anyone may propose an outcome with a bond;
- an initial challenge window allows a dispute;
- repeated disputes can escalate to UMA token-holder voting;
- accepted YES/NO positions redeem at $1/$0, while the documented rare Unknown result redeems both sides at $0.50.

This is decentralized adjudication, not objective knowledge generated by the chain. The rules name external resolution sources, participants submit assertions about them, and an oracle/governance process decides disputed assertions.

### Fees

As accessed on 2026-09-19, Polymarket says protocol-set fees are applied at match time, makers pay zero, and applicable taker fees use `shares × feeRate × price × (1 - price)`, symmetric around 50% ([P3]). The category rates are mutable product policy and should not be copied as constants.

### Polymarket trust summary

| Capability | Off-chain | On-chain | User must trust |
| --- | --- | --- | --- |
| Order creation | Client constructs/signs EIP-712 order | Signature later verified | Client/wallet for intent |
| Book availability and ordering | Operator owns live CLOB and sequencing | No canonical on-chain resting book | Operator for inclusion, uptime, and ordering |
| Matching | Operator selects compatible orders | Contract rejects invalid settlement | Operator for timely/fair selection; contract for validity |
| Asset settlement | Operator submits transaction | Atomic token/collateral movement | Polygon consensus and exchange contracts |
| Cancellation | CLOB API before matching | Fill status prevents overfill | Operator for timely removal before match |
| Resolution | Evidence and human judgment originate off-chain | UMA proposal/dispute result and redemption | UMA mechanism and voters/reporters |
| Read models | APIs/indexers | Contract state remains economic source | API for availability/presentation, not custody |

## Solana constraints that shape the design

Solana transactions execute all instructions atomically; if one instruction fails, state changes revert, although transaction fees are still charged ([S1]). Legacy/v0 transactions are bounded to 1,232 bytes, transactions have account and instruction limits, and a recent blockhash is valid for 150 slots ([S1]). Matching therefore needs bounded work per instruction—never an unbounded “drain the whole book” loop.

Solana programs can control deterministic Program Derived Addresses (PDAs). No private key exists for a PDA; only its deriving program can sign for it through `invoke_signed` ([S5]). PDA-owned token vaults and deterministic market/trader/order accounts therefore remove the need for a server-held custody key. Programs move, mint, and burn SPL tokens by CPI into the Token Program, including with PDA authority ([S6]).

Two existing Solana CLOBs establish useful design precedent, not a drop-in prediction-market implementation:

- Phoenix Legacy describes itself as an on-chain order book with atomic settlement and no crank ([C1]). Its current repository explicitly labels it “Legacy,” so use its architecture and tests as reference, not an unreviewed dependency decision.
- OpenBook V2 is a deployed Solana CLOB ([C2]). Its IDL exposes separate bids, asks, event heap, base/quote vaults, user open-orders accounts, client order IDs, bounded placement, cancellation, and take-order instructions ([C3]). Its repository also warns that deriving a similar Solana program from GPL-gated portions requires publishing changes under the GPL ([C2]).

The prediction-market program needs complete-set mint/merge, binary payout accounting, and disputed resolution, which neither generic spot CLOB supplies. The safest recommendation is a purpose-built program informed by these patterns, with an explicit license review before copying any implementation.

## Proposed fully on-chain Goosey architecture

### Canonical accounts

All economic accounts are PDAs or SPL token accounts controlled by PDAs:

| Account | Canonical contents |
| --- | --- |
| `Config` PDA | program version, protocol fee policy, fee vault, governance/upgrade references, global pause only for bounded emergencies |
| `Market` PDA | immutable question/rules hash and resolution source, payout unit, tick/lot sizes, open/close times, status, outcome, fee settings, next order and trade sequences |
| `BookSide` PDAs | deterministic price-time ordered bids and asks, split into bounded pages/slabs if required |
| `FeatherMint` | local/devnet SPL mint; mint authority = Goosey program PDA; no freeze/permanent-delegate authority unless explicitly justified |
| `FeatherVault` token account | escrowed feather game tokens, authority = market/program vault PDA |
| `OutcomeVault` token accounts | escrowed YES/NO SPL tokens if externally transferable outcome mints are enabled |
| `TraderMarket` PDA | available and reserved collateral, available and reserved YES/NO positions, next client nonce |
| `Order` PDA or slab node | owner, side/outcome, price, original/remaining quantity, sequence, expiry, time-in-force, post-only flag, client order ID |
| `Resolution` PDA | proposed outcome, proposer, bond, proposal slot/time, challenge deadline, dispute state, evidence/rules hashes, final outcome |
| `FeeVault` token account | protocol fees collected by deterministic on-chain math |

The preferred performance model is an **SPL feather mint plus an on-chain custodial subledger backed 1:1 by PDA token vaults**. Users receive free feathers into their ATAs and can transfer unlocked feathers wallet-to-wallet through ordinary SPL transactions. To trade, they lock feathers or outcome tokens into program vaults; the program then updates available/reserved balances during matching. This is still fully on-chain—the mint supply, user ATAs, subledger, reserves, and vault balances are all public chain state—and it avoids a Token Program CPI for every maker leg. Lock/unlock instructions prove the backing boundary and move only the same nonredeemable feather token. If external outcome-token composability is required, the program can mint canonical YES/NO SPL tokens and support explicit lock/unlock; the CLOB itself should still use its on-chain subledger for bounded account access.

### Instructions and invariants

The minimum instruction set is:

- `create_market` and `activate_market`
- `claim_feathers`, `lock_feathers`, `unlock_feathers`, plus direct wallet-to-wallet SPL transfers
- `split_complete_set`, `merge_complete_set`
- `place_order`, `cancel_order`, `cancel_all_bounded`, `replace_order`
- permissionless `match_orders` / `consume_matches` if placement cannot settle every crossed level within compute limits
- `propose_resolution`, `dispute_resolution`, `finalize_resolution`
- `redeem_position` and bounded batch redemption
- `collect_protocol_fees` under governed authority

Core invariants enforced by the program:

- escrowed feathers equal unredeemed complete-set game liability plus explicitly accounted fees;
- available + reserved balances reconcile to vault-backed program liabilities;
- every resting BUY has reserved collateral including maximum deterministic fee, and every resting SELL has reserved outcome quantity;
- complete sets mint only against one payout unit of collateral and merge only by burning one of every outcome;
- no fill can exceed either order's remaining quantity;
- price-time priority is determined only by `(price, order_sequence)`, with `order_sequence` allocated by the market program;
- fee calculations and rounding are integer-only and identical for preview and execution;
- terminal resolution disables placement/matching before redemption;
- every state transition is bounded by an explicit maximum number of orders/fills/accounts.

### Matching, fairness, and permissionless execution

`place_order` should cross a bounded number of best-priced resting orders in deterministic price-time order. IOC/FOK/post-only/GTC behavior is validated by the program, not a server. A remainder may rest only after its collateral or position is reserved on-chain.

If a transaction reaches its fill/compute cap while crossed liquidity remains, it commits the valid bounded prefix and emits enough state for any party to submit the next permissionless instruction. The caller does not select arbitrary makers: it supplies account addresses, while the program verifies that they are the current best eligible sequence. A stale or censored RPC can delay a user, but cannot create a different valid execution order.

The market PDA/book accounts become a writable-account contention point for that market. Different markets can execute in parallel because they use different accounts. Within a hot market, fixed-size book pages and bounded event queues should be benchmarked against Solana's transaction size, account, and compute limits before choosing slab sizes. This is an architectural inference from Solana's limits ([S1]) and the account layouts exposed by OpenBook ([C3]), not a claim that one structure is universally optimal.

### Resolution for Hack the North markets

“Fully on-chain” cannot make an off-chain hackathon result objectively knowable. It can make the process, custody, and final state transparent and enforceable:

1. Store the immutable resolution rules, canonical source URL, content hash, deadline, and fallback policy in `Market` at activation.
2. Allow any eligible account to propose YES, NO, or VOID with a feather bond.
3. Store the proposal, evidence hash/URI, bond, and challenge deadline on-chain.
4. Permit a bonded dispute during the challenge period.
5. Finalize an undisputed proposal permissionlessly after the deadline.
6. Route a dispute to a configured on-chain governance authority. For the hackathon deployment, use a disclosed multi-party organizer/judge authority rather than a single server key. A later version can use token voting or another oracle program after its incentives and availability are validated.
7. Have the program set the terminal outcome and enable redemption; no admin API may directly mutate balances or terminal status.

The trust statement shown to users must name the resolution authority and upgrade authority. Governance improves accountability but does not erase human judgment. Polymarket's UMA flow demonstrates the same fundamental split between external evidence and on-chain proposal/dispute enforcement ([P2]).

## Fees and economic accounting

There are two independent fees:

1. **Solana network fee:** paid in SOL by the transaction fee payer even though feathers themselves are free. Official documentation lists a 5,000-lamport base fee per signature and an optional priority fee calculated from requested compute-unit price and limit; these parameters can change and failed transactions still pay network fees ([S1], [S3]). A sponsor/relayer can pay this without receiving feather-transfer or trading authority.
2. **Goosey protocol fee:** denominated in feathers, calculated and transferred by the program during each fill. Fee parameters live in market/config state and cannot be supplied by an API response. The program emits gross amount, fee, net amount, maker/taker, and rounding result for every fill.

For a binary market, a symmetric curve like Polymarket's can avoid favoring equivalent YES-at-`p` and NO-at-`1-p` trades, but Goosey should adopt a formula only after specifying integer units, minimum/maximum fee, maker/taker treatment, rounding direction, and complete-set edge cases. Never copy the currently published Polymarket category rates as protocol constants ([P3]).

Account creation/rent and priority fees are visible transaction costs, not trading P&L. Close empty order/trader accounts where safe so reclaimable lamports return to the designated owner.

## Nonces, replay, and idempotency

Solana's recent blockhash and transaction-status cache prevent the exact signed transaction from being processed twice while it is in the replay window. The runtime checks a recent blockhash (up to 150 slots) or a durable nonce and rejects an already-processed message ([S2]). Durable nonces extend transaction lifetime by advancing an on-chain nonce account; they are useful for delayed or multisig signing ([S4]).

Neither mechanism provides Goosey business idempotency. A client can sign semantically identical instructions with a fresh blockhash. The program therefore needs its own replay key:

- each wallet chooses a `client_order_id` or monotonic `client_nonce` scoped to `(market, trader)`;
- the order PDA or a bounded replay record is deterministically derived from that scope;
- replaying the exact same canonical instruction returns the existing result/no-op;
- reusing the key with different side, price, quantity, expiry, or flags fails with an explicit conflict;
- cancel/replace instructions identify the canonical order and expected order version/remaining quantity;
- fills use program-assigned trade sequence numbers, never client timestamps, as the causal tie-break.

Durable nonces should not be substituted for this rule: they solve transaction freshness, not duplicate economic intent.

## Reorgs, commitment, and finality

Solana exposes `processed`, `confirmed`, and `finalized` commitments. Official RPC documentation states that `processed` is the newest view and may be rolled back, `confirmed` has a supermajority stake vote, and `finalized` has maximum lockout ([S7]). Solana's confirmation guidance recommends `confirmed` for most request flow and warns that a processed block can belong to a dropped fork ([S8]).

Goosey should therefore:

- show a submitted transaction immediately as local/pending, then `confirmed`, then `finalized`;
- never call a feather claim/transfer/lock/unlock, fill, resolution, or redemption irreversible before `finalized`;
- key indexer records by `(signature, instruction index, slot)` and retain their commitment;
- remove or reverse non-finalized projections when a fork is dropped;
- reconcile finalized program accounts/events from multiple RPC providers and backfill by slot;
- rebuild the entire economic read model from the program deployment slot without using database-only corrections;
- fetch recent blockhashes and run preflight with compatible commitment, track `lastValidBlockHeight`, and distinguish expiry from program rejection ([S8]);
- treat RPC/indexer outages as availability failures, not permission to execute in PostgreSQL.

Polymarket similarly exposes intermediate `MATCHED` and `MINED` states before terminal `CONFIRMED` ([P1]), but its operator is responsible for submitting/retrying settlements. In Goosey, transaction submission may be wallet-, relayer-, or crank-driven while the on-chain program remains the only execution authority.

## Trust model for the recommended system

| Actor/component | Can do | Must not be able to do | Mitigation/disclosure |
| --- | --- | --- | --- |
| Solana validators | order and finalize valid transactions | bypass program checks | wait for appropriate commitment/finality |
| Program code | move vault assets and mutate markets exactly as coded | exceed declared authorities | reproducible builds, public program ID, independent review before value |
| Upgrade authority | deploy new program logic while retained | silently remain a single developer key | disclosed multisig/governance plus delay; make immutable when operationally appropriate ([S9]) |
| Resolution proposers/disputers | assert external outcomes with bonds | directly alter balances | on-chain deadlines, bonds, evidence, and deterministic finalization |
| Final arbiter/governance | decide genuinely disputed external facts | trade or withdraw user collateral | narrowly scoped resolution authority, public membership/policy |
| Relayer/crank | submit valid user/program transactions and optionally sponsor SOL | choose a different valid book order or forge intent | permissionless alternatives; program verifies best order and signer |
| RPC/indexer/PostgreSQL | serve fast derived views | become economic source of truth | rebuildability and client-verifiable signatures/slots/accounts |
| Feather mint/program | issue free feathers under the published local/devnet policy | create hidden balances or imply cash value/redemption | PDA mint authority, on-chain claim records and supply; no cash bridge |

## What must change in Goosey

The existing site can remain the product shell, account/community layer, and reference model. The economic path changes as follows:

| Current-style responsibility | Fully on-chain replacement |
| --- | --- |
| Server authenticates trading request | Wallet signs Solana transaction; optional scoped on-chain delegate for session UX |
| Prisma transaction reserves wallet feathers/shares | Program locks ATA feathers into PDA vaults and moves on-chain available balances to reserves |
| Server matcher selects makers | Program enforces best-price then earliest sequence |
| Database fill/journal is authoritative | Program state and emitted fill event are authoritative |
| Admin route closes/resolves market | Program instruction advances governed resolution state |
| Reconciliation compares database ledgers | Indexer verifies program liabilities against token vault balances |
| Database backup protects balances | Chain state protects balances; database backup protects only derived/social data |

Do not build a bridge in which Goosey's server continues matching and periodically posts Merkle roots or trade hashes to Solana. That proves a server claimed a history; it does not give users on-chain ordering, on-chain reserves, permissionless execution, or program-enforced settlement.

## Delivery sequence and acceptance gates

1. **Protocol specification:** freeze integer units, complete-set algebra, order priority, time-in-force behavior, fee rounding, replay keys, expiry clock, resolution transitions, and every invariant. Port existing economic tests as chain-independent vectors.
2. **Program prototype on `solana-test-validator`:** create the SPL feather mint/PDA authority, on-chain free-claim policy, direct transfer fixture, vaults, trader balances, complete sets, bounded CLOB, fills, cancellation, and reconciliation. Measure maximum bounded fills and account footprints; do not assume generic CLOB settings fit prediction markets.
3. **Resolution program:** implement bonded propose/dispute/finalize and governed disputed outcome. Publish the exact authority and upgrade policy.
4. **Client/indexer:** wallet transaction builders, simulation, confirmation/finality state, event/account indexer, and full rebuild command. PostgreSQL is disposable for economics.
5. **Devnet adversarial and load testing:** concurrent placement/cancel/replace, same client key replays, partial fills at compute boundary, insufficient reserves, fork-aware indexer replay, expired blockhash retry, and oracle timing.
6. **Devnet release gate:** independently review program and economic invariants, verify deployed bytecode, set governed upgrade authority, fund monitoring/cranks with devnet SOL, and rehearse indexer loss/rebuild and RPC failover. Mainnet and any real-value collateral are explicitly out of scope and require a separate product, legal, economic, and protocol decision.

The system is not accepted as fully on-chain until all of these statements are true:

- deleting PostgreSQL and rebuilding from finalized Solana history produces the same orders, fills, balances, fees, market outcomes, and redemptions;
- no Goosey API credential or server key can create a fill, change priority, spend a trader's balance, or resolve a market outside an authorized on-chain instruction;
- a third party can submit a valid match/finalize instruction through an independent RPC;
- users can verify vault backing and program IDs without trusting Goosey's UI;
- duplicate transaction delivery and newly signed duplicate intent cannot double-execute an order;
- every displayed economic state records its Solana signature, slot, and commitment.

## Primary-source register

All links below were accessed **2026-09-19**.

### Polymarket

- **[P1] Order Lifecycle:** https://docs.polymarket.com/concepts/order-lifecycle
- **[P2] Resolution:** https://docs.polymarket.com/concepts/resolution
- **[P3] Fees:** https://docs.polymarket.com/trading/fees
- **[P4] Contracts:** https://docs.polymarket.com/resources/contracts
- **[P5] CTF Exchange V2 README/source overview:** https://github.com/Polymarket/ctf-exchange-v2/blob/main/README.md
- **[P6] CTF Exchange V2 trading implementation:** https://github.com/Polymarket/ctf-exchange-v2/blob/main/src/exchange/mixins/Trading.sol

### Solana protocol and token model

- **[S1] Transactions and limits:** https://solana.com/docs/core/transactions
- **[S2] Transaction pipeline, replay cache, and nonce validation:** https://solana.com/docs/core/transactions/transaction-pipeline
- **[S3] Fees and compute limits:** https://solana.com/docs/core/fees
- **[S4] Durable nonces:** https://solana.com/developers/cookbook/transactions/durable-nonces
- **[S5] Program Derived Addresses:** https://solana.com/docs/core/pda
- **[S6] Token Program CPI and PDA authorities:** https://solana.com/docs/tokens/advanced/cpi
- **[S7] RPC commitments:** https://solana.com/docs/rpc
- **[S8] Transaction confirmation, expiry, and dropped forks:** https://solana.com/developers/cookbook/transactions/confirmation
- **[S9] Solana CLI program authority/immutability reference:** https://solana.com/docs/references/solana-cli
- **[S10] SPL token transfers:** https://solana.com/docs/tokens/basics/transfer-tokens
- **[S11] SPL token minting and mint authority:** https://solana.com/docs/tokens/basics/mint-tokens
- **[S12] Token accounts, ATAs, and account-creation payer:** https://solana.com/docs/tokens/basics/create-token-account

### Solana CLOB precedents

- **[C1] Phoenix Legacy repository:** https://github.com/Ellipsis-Labs/phoenix-v1
- **[C2] OpenBook V2 README, deployments, and licensing:** https://github.com/openbook-dex/openbook-v2/blob/master/README.md
- **[C3] OpenBook V2 IDL/account and instruction surface:** https://github.com/openbook-dex/openbook-v2/blob/master/idl/openbook_v2.json

[P1]: https://docs.polymarket.com/concepts/order-lifecycle
[P2]: https://docs.polymarket.com/concepts/resolution
[P3]: https://docs.polymarket.com/trading/fees
[P4]: https://docs.polymarket.com/resources/contracts
[P5]: https://github.com/Polymarket/ctf-exchange-v2/blob/main/README.md
[P6]: https://github.com/Polymarket/ctf-exchange-v2/blob/main/src/exchange/mixins/Trading.sol
[S1]: https://solana.com/docs/core/transactions
[S2]: https://solana.com/docs/core/transactions/transaction-pipeline
[S3]: https://solana.com/docs/core/fees
[S4]: https://solana.com/developers/cookbook/transactions/durable-nonces
[S5]: https://solana.com/docs/core/pda
[S6]: https://solana.com/docs/tokens/advanced/cpi
[S7]: https://solana.com/docs/rpc
[S8]: https://solana.com/developers/cookbook/transactions/confirmation
[S9]: https://solana.com/docs/references/solana-cli
[S10]: https://solana.com/docs/tokens/basics/transfer-tokens
[S11]: https://solana.com/docs/tokens/basics/mint-tokens
[S12]: https://solana.com/docs/tokens/basics/create-token-account
[C1]: https://github.com/Ellipsis-Labs/phoenix-v1
[C2]: https://github.com/openbook-dex/openbook-v2/blob/master/README.md
[C3]: https://github.com/openbook-dex/openbook-v2/blob/master/idl/openbook_v2.json
