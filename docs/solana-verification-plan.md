# Solana exchange verification plan

Research date: 2026-09-19. This is an implementation and acceptance contract. The subsequently authorized `scripts/solana-token-e2e.ts` exercises the real SPL Token/ATA programs on the user's isolated loopback validator; its result is recorded below. It does not establish exchange-program correctness. No custom exchange program was built or deployed by this task.

## Scope and authority

The confirmed product is free, nonredeemable feathers on **localnet/devnet only**. The target is a fully onchain central limit order book: issuance, available balances, reservations, matching, fills, cancellation, amendment, expiry enforcement, market closure, resolution, and settlement must be authorized and enforced by the program. An API may construct transactions and index results; it must not decide authoritative fills or maintain a second spendable balance. A trusted resolution signer is compatible with onchain settlement, but its real-world judgment remains a disclosed trust assumption.

Feathers must support real user-to-user Solana transfers. Use a wallet-visible SPL feather mint with **three decimals** and program-controlled escrow for exchange collateral. Free and nonredeemable does not mean nontransferable. Wallet tokens enter exchange buying power only through atomic deposits; escrow-backed program balances and positions are authoritative onchain. Use the custody invariant below and the [wallet integration plan](solana-wallet-integration.md). There is no purchase, cash-out, mainnet deployment, or automatic conversion of legacy database feathers in this scope. Withdrawal from escrow returns play tokens to a wallet; it is not cash redemption.

Existing behavior to preserve is documented in [advanced orders](advanced-orders.md) and implemented in `src/lib/order-exchange.ts`, `src/lib/order-book.ts`, `src/lib/order-book-accounting.ts`, `src/lib/settlement-service.ts`, and `src/lib/settlement-payout.ts`. Those TypeScript helpers are useful independent reference models. Passing their tests is not evidence that a deployed program enforces the same rules.

## Obtainable toolchain and compatibility

Use this pinned candidate baseline for the isolated Rust workspace. Availability and upstream compatibility statements were checked; a clean build of this complete combination has **not** been performed. The main implementation must record its actual successful lockfile and build receipt before claiming compatibility.

| Component | Exact candidate pin | Primary evidence and constraint |
| --- | --- | --- |
| Anchor CLI, `anchor-lang`, optional `anchor-spl` | `1.2.0` for all three; Cargo dependencies `=1.2.0` | Published, non-yanked entries were read from the [CLI](https://index.crates.io/an/ch/anchor-cli), [lang](https://index.crates.io/an/ch/anchor-lang), and [SPL](https://index.crates.io/an/ch/anchor-spl) sparse registry records. Lang declares Rust 1.89 minimum. |
| Agave CLI and `solana-test-validator` | `4.1.2` | [Anchor 1.2.0 release notes](https://www.anchor-lang.com/docs/updates/release-notes/1-2-0) recommend this version. [Agave release](https://github.com/anza-xyz/agave/releases/tag/v4.1.2) has macOS arm64/x64 and Linux x64 archives. |
| SBF platform-tools / architecture | `v1.57` / `v3` | Explicit defaults in [Anchor v1.2.0 CLI source](https://github.com/otter-sec/anchor/blob/v1.2.0/cli/src/lib.rs); [platform-tools release](https://github.com/anza-xyz/platform-tools/releases/tag/v1.57) has macOS and Linux assets. |
| Host Rust | `1.94.0`, minimal profile | [Official distribution manifest](https://static.rust-lang.org/dist/channel-rust-1.94.0.toml) is available. This exceeds the declared Anchor/LiteSVM minimum; full transitive dependency compatibility still needs `cargo test --locked`. Host Rust and the compiler bundled with SBF platform-tools are separate. |
| Primary in-process runner | `litesvm = "=0.16.0"` in a separate harness workspace | [Published registry record](https://index.crates.io/li/te/litesvm) is non-yanked, declares Rust 1.89, and uses Agave 4.2.1-family components. This is **not** exact runtime parity with validator 4.1.2. Run the same artifacts on the validator. |
| Optional instruction runner | `mollusk-svm = "=0.15.1"` in its own harness workspace | [Registry record](https://index.crates.io/mo/ll/mollusk-svm) is non-yanked; [upstream manifest](https://github.com/anza-xyz/mollusk/blob/main/Cargo.toml) inspected at research time uses Agave 4.2.0-family components. Optional; it must not delay the mandatory LiteSVM and RPC lanes. |
| Anchor TypeScript client | `@anchor-lang/core@1.2.0` | [Publisher registry metadata](https://registry.npmjs.org/@anchor-lang%2fcore/1.2.0) was queried with `npm view`; this is the current package name. Do not assume `@coral-xyz/anchor` or `@anchor-lang/anchor` is interchangeable. |
| JavaScript transaction client | `@solana/web3.js@1.98.4`; optional `@solana/spl-token@0.4.14` | [Anchor client docs](https://www.anchor-lang.com/docs/clients/typescript) require the legacy web3.js v1 API. [SPL package metadata](https://registry.npmjs.org/@solana%2fspl-token/0.4.14) requires web3.js `^1.95.5`, which includes this pin. Do not pass Kit/v2 objects directly into Anchor. |

**Main integration selection supersedes the optional client recommendation:** the application now uses `@solana/kit@8.3.0`, `@solana-program/token@0.16.1`, and `@solana-program/system@0.14.1`. The concrete token RPC script uses those installed packages and `src/lib/solana/feather-transfer.ts`. The Anchor/web3.js row describes an alternative client boundary only; do not add it to the Kit implementation unless an Anchor client is actually needed. Generated instructions or an explicitly verified ABI can use Kit without the Anchor TypeScript client.

The crates.io REST API returned HTTP 403 here; sparse registry records succeeded. A repository's main-branch version alone is not proof that a package can be installed. Preserve exact package-manager integrity hashes and Cargo checksums, release asset hashes, host architecture, and `rustc`, `cargo`, `anchor`, `solana`, `solana-test-validator`, and `cargo build-sbf` version output in the implementation receipt. Use isolated `CARGO_HOME`, `RUSTUP_HOME`, installation root, and process-local PATH; never change the user's default Solana cluster or global toolchain for this work.

For provisioning, use `rustup toolchain install 1.94.0 --profile minimal`, and an isolated `cargo +1.94.0 install anchor-cli --version 1.2.0 --locked --root <isolated-tool-root>`. Download the matching Agave release asset for the host. If a supported binary is unavailable, use a pinned supported Linux environment or an exact-tag source build. Report provisioning failure as blocked infrastructure, never substitute arithmetic tests and call them program tests.

Keep program and harness dependency graphs separate. Anchor 1.2.0's [tagged manifest](https://github.com/otter-sec/anchor/blob/v1.2.0/Cargo.toml) uses Solana 3.x interface crates; LiteSVM 0.16.0 uses newer account/message/address types. Exchange raw account bytes, instruction data, and 32-byte addresses across this boundary. Use each runner's compatible types to build account metas and transactions. Do not solve `Pubkey`/`Address` or `Instruction` mismatches with unchecked casts or an unbounded dependency upgrade. Commit the successfully resolved lockfiles and inspect `cargo tree -d`.

## Required test lanes

| Lane | What it must actually execute | What it cannot prove |
| --- | --- | --- |
| Pure model | Independent bigint/integer matching and accounting model; generated sequences and differential comparison | SBF compilation, ownership checks, runtime signing, CPI, RPC, or network finality |
| LiteSVM | Load the newly compiled exchange `.so`; send signed transactions with signature and blockhash checks enabled; inspect resulting account bytes | Validator persistence, real RPC transport, leader scheduling, or consensus forks |
| Mollusk, optional | Execute the same compiled ELF with explicit accounts, sysvars, and real CPI programs; assert instruction errors, output state, and compute usage | Full transaction signature verification, AccountsDB/Bank behavior, RPC, or consensus |
| Agave local validator, mandatory | Load/deploy the same `.so` into a separate `solana-test-validator` process and submit serialized transactions over HTTP RPC; inspect signature status and chain accounts | A single validator does not reproduce multi-validator consensus forks |
| Browser/wallet plus local validator | Actual user journeys, SIWS server verification, real signatures, chain mutations, reload and reconnect | Automated wallet controls alone do not establish every hardware/mobile wallet's behavior |
| Devnet smoke, later explicit execution | Same artifact/configuration, faucet-only funding, supported real wallets, confirmation/reconnection | Reproducible failure injection or a substitute for deterministic local tests |

[LiteSVM upstream](https://github.com/LiteSVM/litesvm) documents compiled-program loading, transactions, sysvar controls, and signature verification switches. [Mollusk upstream](https://github.com/anza-xyz/mollusk) explicitly distinguishes its ELF execution pipeline from a validator and requires explicit accounts. Neither should be described as pure arithmetic simulation, and neither replaces the RPC lane.

### Build and runner acceptance sequence

1. Create the program and harness lockfiles in the isolated workspace. Build with `anchor build --tools-version v1.57 --arch v3` and record SHA-256 of the resulting `.so` and IDL. Make missing or stale artifacts a hard test failure. Where a native Solana program is chosen instead, run the equivalent pinned `cargo build-sbf` invocation and record its ABI/client schema.
2. Run the harness with `cargo +1.94.0 test --locked --manifest-path <harness>/Cargo.toml`. Its configured artifact path must refer to that exact hash. Include a deliberate invalid signer and a deliberate economic invariant violation, proving the harness reaches the program and observes rejection.
3. Launch `solana-test-validator` with a new `mktemp -d` ledger, loopback bind, isolated RPC/faucet ports, and the compiled program at its declared ID. Use the actual binary's `--help` to validate flags. Record process identity, genesis hash, executable program account, artifact association, and health before sending transactions. Never reset an active ledger or another task's validator.
4. Execute the RPC suite against that explicit endpoint. A preload is acceptable for economics tests; upgrade authority and loader tests require a real loader deployment. Assert transaction `meta.err`, program account data, and balances, not just event text. A log emitted before a failed transaction rolls back is not a committed fill.
5. Restart the same validator with the same ledger and verify committed orders and balances persist. Separately create a fresh ledger/deployment and verify stale sessions, transaction intents, and indexer cursors are rejected or namespaced away. Stop only the process owned by this run.
6. Archive sanitized receipts: source commit, dependency locks, artifact hashes, runner/feature-set versions, commands, seeds, transaction signatures, errors/logs, account snapshots, compute use, and invariant report. Never archive wallet secrets or private sandbox credentials.

**Anchor runner trap:** [Anchor CLI docs](https://www.anchor-lang.com/docs/references/cli) document Surfpool as the default and `anchor test --validator legacy` as the Agave path. The v1.2.0 CLI also persists `skip_local_validator` for generated LiteSVM/Mollusk templates. Merely passing `--validator legacy` is therefore insufficient evidence: use a distinct RPC test script/config with that skip disabled, or an explicitly managed validator and an RPC client test process. A green `anchor test` that only invoked `cargo test` does not satisfy step 4. Surfpool can be an additional lane; its default automatic mainnet account loading is unsuitable for this isolated dataset unless explicitly disabled/configured. See [Solana's Surfpool defaults](https://solana.com/docs/intro/installation/surfpool-cli-basics).

Use real instructions to initialize markets, claim authorized free issuance, reserve, fill, cancel, and settle. Local SOL airdrops fund transaction fees and rent only. Do not insert balances/fills directly into program accounts. Handcrafted corrupt accounts are permitted only as labeled adversarial inputs expected to fail; sysvar time manipulation belongs in the deterministic runner, not in claims about validator clock behavior.

## Economic invariants after every successful transition

Use integer atomic feather units; explicitly retain or convert the existing milli-feather scale (1 feather = 1,000 units). Store quantity, tick size, payout `P`, fee basis points, and limits in the immutable market configuration. Use checked arithmetic and sufficiently wide intermediates for products; reject overflow before mutation. Do not use floating point or JavaScript `number` for economic serialization.

Define `A` = sum of available feather balances, `R` = sum of reserved feather balances, `C_m` = market m's collateral, `F` = protocol fees, and `G` = cumulative authorized issuance minus explicit authorized burns. Buckets must be disjoint.

- SPL custody: let `V` be vault token units and `D` unallocated donations/surplus. Require `V = A + R + sum(C_m) + F + D`. Every trade/cancel/amend/settle preserves the vault backing; deposits/withdrawals change vault and internal liabilities together. Never credit unsolicited transfers by matching a UI balance delta. Verify mint, token program, decimals, vault owner/PDA and exact transferred amount.
- Global token supply: `sum(all external token accounts) + V = mint.supply = G`, including any additional authorized custody accounts exactly once. User-to-user transfers preserve supply; issuance increases it only through the actual mint authority/program grant path. Exchange internal balances are liabilities against `V`, not additional tokens to add to this supply equation. Minting grants into a wallet and simultaneously crediting internal buying power is prohibited.
- For an unresolved binary market with complete-set minting, total outstanding YES equals total outstanding NO, counting available and reserved positions, and `C_m = P * outstandingYES`. MINT adds one of each and `P` collateral per set; BURN removes one of each and releases `P`; same-outcome transfers leave supplies and collateral unchanged.
- Reservations partition ownership: `ownedOutcome = availableOutcome + reservedOutcome`; no negative quantity, no short selling, and no reserved share can back two orders. Buy reservations cover the remaining limit-price principal plus the remaining cumulative worst-case fee, respecting already executed notional. Partial fills release price improvement and excess fee reserve immediately.
- Fees telescope: at a fixed fee rate, each fill fee is `ceil((priorNotional + fillNotional)*bps/10000) - ceil(priorNotional*bps/10000)`. Partition counters explicitly if maker/taker rates differ; lock fee schedules for live orders or define and test a safe migration. Fragmentation must not multiply rounding fees. Sell fees cannot exceed sale proceeds.
- Orders conserve original quantity across filled, still-open, and canceled/expired quantities. A filled or released unit cannot reappear. Active buy/sell reservation aggregates equal the account counters. Linked-list/tree/slab membership and per-market order sequence agree with order status.
- After resolution, replace equal-supply assertions with the payout liability invariant: collateral covers all unclaimed winning units. Claims atomically reduce liability and credit available feathers once. Recommended VOID policy is `P/2` per outcome, requiring even `P`; make any alternative rounding/dust rule explicit before deployment. Do not apply unresolved equal-supply assertions after one-sided claims.
- SOL fee/rent changes are a separate ledger. A failed transaction may charge network fees even though exchange state rolls back. Rent refunds cannot mint feathers or subsidize collateral silently. See [Solana transaction atomicity](https://solana.com/docs/core/transactions).

The independent model should implement these equations without importing the program's helper functions. Compare full balances, reservations, supplies, fees, order priority, and terminal states after each generated step, including rejected steps. Persist and minimize failing seeds. At minimum, run 100 deterministic seeds of 100 commands in LiteSVM plus all named boundary cases; this is an acceptance floor, not a security proof.

## Required adversarial cases

Every row requires exact pre/post account comparison and the invariants above; run economic happy paths and critical rejection/race cases against the compiled program in both LiteSVM and the RPC lane.

| Area | Required cases and expected contract |
| --- | --- |
| Initialization and permissions | Wrong signer; substituted market/user/config; wrong PDA seeds/bump; wrong owner/discriminator; truncated/oversized account; aliased mutable accounts; unauthorized reinitialization/close; arithmetic max values. Reject without feather changes. Apply and test [Anchor account constraints](https://www.anchor-lang.com/docs/references/account-constraints), including manually validated remaining accounts. |
| Free issuance | Correct grant once; duplicate, concurrent, stale-epoch and wrong-authority requests; wallet relink; closed/recreated grant receipt; grant cap overflow. Preserve durable claim identity so account closure cannot reopen eligibility. Record the per-wallet/Sybil limits honestly. |
| Wallet transfers | Real three-decimal `TransferChecked`; first transfer creates recipient ATA idempotently, repeat transfer reuses it; wrong mint/decimals, wrong or missing signer, corrupt signature, insufficient token units, insufficient fee/rent SOL. Source debit equals recipient credit, total supply unchanged; exact signed-wire replay never delivers twice. Failed transfer after ATA creation rolls back both token mutation and account creation. |
| Price and size | Zero/negative input at client boundary; zero quantity; price 0 or `P`; tick violations; huge quantity; checked `P*q` and fee overflow; crossed and empty books; canonical NO price `P - YES price`; all MINT/BURN/TRANSFER combinations. |
| Priority and supplied accounts | Better price before worse, FIFO at equal price, expired/self-owned orders skipped under documented rules. Relayer cannot omit the best maker, reorder makers, duplicate an order account, supply foreign-market makers, or choose a favorable subset. The program proves traversal from authoritative book roots. |
| Partial GTC | One fill then rest; many makers; exact completion; price improvement; residual minimum size; final dust release; same owner across opposite outcomes. Check cumulative fees and reservations at each step. |
| IOC | Empty => accepted terminal cancellation, no fill/reserve; partial => fills and remainder cancellation in the same atomic transaction; full => filled. No remainder rests; receipt distinguishes zero fill from partial cancellation. |
| FOK | One unit short, fee shortfall, self-trade removal, expired best maker, omitted next maker, account/compute bound exceeded => zero economic effects. Exact liquidity => full fill. An error rolls back earlier tentative fills. Never split one FOK across independently committing transactions. |
| Post-only | Reject any immediate crossing, including complementary outcome crossing; noncrossing GTC rests. Reject post-only IOC/FOK and expiration on IOC/FOK at the program boundary. |
| Cancellation/expiry | Unauthorized cancellation; double cancellation; cancel after full fill; expiry at `now == expiresAt`; market-close boundary; expired order remains unmatchable before keeper cleanup. Permissionless expiry cleanup releases backing once without owner participation. |
| Amendment | Expected order version; fill races; cancel-and-replace atomicity; changed price/size, invalid expiry and post-only replacement; insufficient extra reserve => old order survives unchanged. Specify time-priority changes; increasing quantity/changing price loses priority. |
| Contention | Two takers consume one maker, fill vs cancel, fill vs expiry, withdrawal vs reserve, simultaneous grant/claim, market close vs submit. At most one valid ordering commits; retry does not duplicate effects. Test actual concurrent RPC sends. |
| Resource bounds | Maximum book size, maximum matches, account count/transaction-size and compute limits, full event queue, account allocation/rent shortage. Fail safely with bounded compute. No silent IOC truncation or FOK partial execution to fit a budget; advertise per-order limits. |
| Replays | Same signed bytes; fresh blockhash with same semantic command ID; same ID/different payload; command replay after order/receipt closure; expired deadline; old deployment domain. Nonce/tombstone state must survive any allowed account reclamation. |
| Resolution | Early/late closure, nonexistent outcome, wrong oracle authority/feed/owner, repeated and conflicting resolution, stale/future attestation, replay across market/deployment, authority rotation, attempted post-finalization rewrite. Resolution is monotonic and all payout checks occur onchain. |
| Settlement | YES, NO, VOID; zero positions; positions partly reserved; canceled-order release; duplicate claims; keeper restart midway; multiple claimants; final dust. Bound cleanup and claims; do not mark fully settled until reservations and liabilities are zero. |
| Required SPL custody | Wrong mint/owner/program/delegate, frozen accounts, insufficient SOL for ATA/rent, transfer failures, unsolicited vault donations; reserve vs withdrawal race, delegated transfer attempts from escrow, and unauthorized mint/grant. Initially reject unsupported Token-2022 extensions such as transfer fees/hooks rather than assuming nominal transfers equal receipts. |

For a feasible first CLOB, explicitly cap book capacity and maximum matches per transaction. If crossing liquidity cannot be processed within that cap, return a deterministic error and roll back. Do not leave a crossed GTC resting to bypass the cap. Offchain account selection is an optimization only; omitting superior liquidity must be detectable onchain.

## Resolution/oracle implementation contract

Persist rules hash, outcomes, close time, payout, and oracle authority/configuration at market creation. An authorized wallet can submit the resolution transaction directly; authorization must derive from signer/PDA configuration, never a database admin role. For offchain signed attestations, include deployment domain, market address, rules hash, outcome, monotonic round/nonce, issued time and expiry, and validate the exact Ed25519 verification instruction/public key/message onchain. Merely including a signature instruction somewhere in a transaction is insufficient.

Recommended lifecycle: `OPEN -> CLOSED -> RESOLUTION_PROPOSED -> RESOLVED -> SETTLED`, with a configured dispute delay if the product requires one. Freeze matching at the onchain close boundary; allow cancellation/cleanup. A bounded cleanup phase releases open reservations before payout claims, or implement and prove an atomic per-user cleanup-and-claim path. An oracle outage leaves liabilities backed and claims unavailable until a valid outcome; any VOID timeout/fallback authority must be fixed in the original rules and tested. A program cannot itself establish that a real-world statement is true.

## RPC ambiguity, restarts, and forks

`sendTransaction` success means submission, not confirmation; Solana documents this explicitly in the [RPC method](https://solana.com/docs/rpc/http/sendtransaction). Persist the semantic command ID, payload hash, deployment domain, serialized signed bytes when available, signature, blockhash, and `lastValidBlockHeight` before broadcast. Inject a dropped HTTP response after the validator accepted the transaction; recovery must discover one command result, not create another order. Inject 429/503, slow/stale endpoints, WebSocket disconnect, process crash before/after indexing, and duplicate/out-of-order notifications.

Resend identical signed bytes while their blockhash is valid. A timeout or null signature status is not proof of failure. Query [signature history](https://solana.com/docs/rpc/http/getsignaturestatuses) and the onchain command receipt; rebuild only with the same semantic ID and renewed explicit signing. Determine blockhash expiry using block height and the original last-valid height, not wall-clock seconds or slot count. A rebuilt transaction must still be rejected/no-op if the command already committed. See [Solana confirmation guidance](https://solana.com/developers/cookbook/transactions/confirmation).

Store finalized projections separately from provisional observations. Index with `(deploymentDomain, signature, instructionIndex, eventIndex)` plus durable market sequence/version; ignore failed-transaction logs. On reconnect, backfill gaps and reconcile program accounts, not just logs. Account snapshots at a later context slot must not overwrite newer state incorrectly; a minimum context slot is not an exact historical snapshot. Use common checkpoints/account versions and repeat reads when reconciling a changing market.

Restarting a single validator tests persistence, not forks. Test provisional-observation removal by feeding the indexer recorded real transaction/account observations and an explicitly labeled rollback transport scenario, then reconciling against canonical accounts. Do not label this a consensus-fork test. Actual fork recovery requires a controlled multi-validator partition/rejoin setup with evidence of the abandoned fork. Keep that advanced lane separately reported if not implemented. Finalized settlement authority remains in program accounts, never in an indexer rollback heuristic.

## Completion gate for the main integration

- Compiled artifact and ABI/IDL match; no stale `.so` or disabled signature checks; exact versions and lockfiles recorded.
- Named edge cases and stateful invariants pass; mandatory RPC tests include concurrent sends, dropped-response replay, and same-ledger restart.
- Wallet link/replay/rejection and accounting migration tests in the companion plan pass, including a chain-only journey with database economic mutation disabled.
- New chain markets work from a second wallet/client without calling a database matching API. Indexer rebuild from chain reproduces holdings and order states; metadata can remain in the database.
- Localnet/devnet configuration rejects mainnet/testnet, foreign genesis/deployment, and stale deployments before signing. Faucet feathers are visibly nonredeemable and wallet-transferable; local/devnet SOL fees and ATA rent are distinct.
- Report each lane as passed, failed, or not run with actual evidence. Pure model, LiteSVM, validator, wallet, devnet, and fork results are separate claims. No production/security-audit claim follows from local tests alone.

## Executed token integration evidence

The main integration task provisioned an isolated validator for the user-authorized localnet work. `scripts/solana-token-e2e.ts` was implemented and run successfully on 2026-09-19 using the **actual** `buildFeatherTransfer` helper for both successful sends. It modifies no existing wallet, writes no private key, starts/stops no validator, and prints sanitized JSON receipts. Each run generates fresh in-memory signers and creates its own mint/token accounts through real System, Token, and Associated Token instructions. The local SOL faucet funds only its ephemeral payer. Test accounts remain in the disposable ledger; their keys are discarded on process exit.

```sh
GOOSEY_SOLANA_RPC_URL=http://127.0.0.1:18999 \
GOOSEY_SOLANA_GENESIS_HASH=Bax5P2GmYBb2P6UjJFmEVys7cpRzY4A85ncAJqtgvSsm \
node --import tsx scripts/solana-token-e2e.ts
```

This actual validator reported `solana-core 4.2.2`, feature set `565236538`; it differs from the recommended Anchor baseline and is not evidence of that whole toolchain's compatibility. Tested clients: Kit 8.3.0, Token 0.16.1, System 0.14.1. Result: **PASS**. Targeted strict TypeScript checking and ESLint also passed. Safety checks rejected a public devnet URL before networking and rejected a wrong genesis pin before generating/funding signers.

| Evidence | Observed result |
| --- | --- |
| Fresh mint | `8SLSMsBP3GbEByK4JsicDxmG8MddhctHaotjpGoEPjhm`, 3 decimals, 1,000,000 base units = 1,000 feathers |
| Source ATA | `FDp3HHAqwzH1xqSwBjR9AkCXSS4EsRexTpd9fx4be7fB` |
| Recipient ATA | `AumjFhjnF12WFj3aAiNoDLRBtz8ngLzVzSdNJhC3Nr23`; absent before the helper transaction |
| First helper send | 123.456 feathers, slot 564, signature `16Z593xPRGrHZQgUL16SJ1cVEuJ2qyw6dse2cPhvtXRStdC7i7eQVxwEHMvu2P1MtP9CzMf3VU28TUwhDGWNg1U` |
| Exact-wire replay | Same signature; unchanged token/mint accounts after two further confirmed blocks; signature appears once in recipient history |
| Second helper send | Existing ATA reused; 0.001 feather, slot 567, signature `fmwq8gBM357RtETEubWcKFTGZU6t4tW9oPnsPPigG2qxhYPkguooStXxq6iTqPN9Go8bxB5682vwgXujKrhUDsk` |
| Wrong decimals / mint / authority / insufficient amount | Actual included failed transactions at slots 568–571, Token custom errors 18 / 3 / 4 / 1; account bytes, token balances, and supply unchanged |
| Missing owner signature / unauthorized mint | Included failures at slots 572–573: `MissingRequiredSignature` / Token custom 4; unchanged account state |
| ATA creation followed by invalid transfer | Slot 574: second instruction failed with custom 18; fresh recipient ATA remained absent, proving atomic rollback |
| Corrupt Ed25519 signature | RPC rejected before inclusion with `-32002`, specifically signature verification failure; unchanged token/mint accounts. The script also accepts the standard `-32003` signature-verification response. |
| Final holdings | Source 876,543 units + recipient 123,457 units = unchanged mint supply 1,000,000 units |

Included failed transactions charged 5,000 or 10,000 local SOL lamports according to signer count; the script records each transaction fee separately from token-state assertions. The initial two development runs exposed an overly narrow assertion expecting only RPC `-32003` for corrupt signatures; both observed actual signature rejection, and the final run passed with the precise error compatibility fix.

These are real token-program/ATA and helper integration checks, not mocks or pure arithmetic. They do **not** prove exchange escrow, deposit/withdrawal, onchain grant caps/Sybil controls, CLOB matching, oracle settlement, wallet UI/rejection, insufficient-SOL behavior, validator restart/forks, or devnet behavior. Those remain separately required. A direct SPL transfer has no semantic command receipt: replay of the exact signed transaction is safe, but a fresh signature/blockhash can transfer again. Do not automatically re-sign an uncertain token send based on a database idempotency key.
