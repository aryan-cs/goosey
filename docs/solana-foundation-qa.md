# Deployed Solana foundation: verification checkpoint

Date: 2026-09-19. This verifies free feather issuance and transfers on a **real isolated local validator**. It does not certify a finished on-chain exchange or web-wallet integration.

## Artifact and deployment

- Source foundation: commit `009f11e`; Anchor 1.2.0; locked Rust dependencies.
- Host Rust 1.98.1; SBF compiler Rust 1.89 / platform-tools v1.54; cargo-build-sbf 4.1.0; Agave validator/CLI 4.2.2, feature set 565236538.
- Command: `cargo-build-sbf --manifest-path chain/programs/goosey-exchange/Cargo.toml --arch v3`.
- ELF SHA-256: `e5161c7aa327fd3048f27f03c1b2c3b22555c54b05efb9d38428a9cb8438864b`.
- Program: `CgEGAD3EGLm63YaSx58sRiNPQmmxg8RqvqcxE3xThX8Q`.
- Genesis: `Bax5P2GmYBb2P6UjJFmEVys7cpRzY4A85ncAJqtgvSsm`.
- Actual loader deployment transaction: `5BDbBDw5pnPJSsDjdJT3U3ViYXTcZfnb1U8c2jm5Gaz1mCbYzPNFGcDJsaKG4naK1cL7NPcKdG9eHgwNRQHDTXUe`.

The initial default-v0 build compiled but deployment failed: this validator has SIMD-0500 active, disabling new v0/v1/v2 deployments. Explicit SBPF v3 fixed deployment. No validator features were disabled, no ledger was reset, and no failed deployment was counted as a success.

The finalized read-only preflight subsequently passed. It still reports `exchangeVerified: false`, correctly: an executable program is not evidence that every exchange requirement works.

## Real instruction results

`scripts/solana-program-e2e.ts` passed all 22 executed instruction cases, including:

- Only the actual upgrade authority can initialize. Unsupported environment, zero caps and repeat initialization fail without replacing state.
- Initialization creates a real classic SPL mint with three decimals, no freeze authority and a program-derived mint authority.
- Wrong issuer, excessive allowance and expired authorization fail atomically.
- Both wallet and opaque identity have unique permanent enrollment records. Neither can be reused to authorize a second grant.
- The wallet claims the exact allowance through program-signed Token CPI. Another wallet cannot claim it.
- A repeated claim with a fresh signature is a no-op; sending claimed feathers away does not replenish eligibility.
- The application transfer helper sends **123.456 feathers** from the claimed supply into another wallet's real ATA.
- An unpaid claim fails after the actual validator clock reaches its deadline. No clock sysvar or account balance was fabricated.
- Lifetime campaign authorization stops exactly at its cap.

Evidence examples:

| Action | Actual signature |
| --- | --- |
| Initialize | `36YHc8CteU6oNHaJmxnM9CTDzFRjjTRvUHRb9bGSoHt1eJN7XAzrveL4NuSUSViYbA6KszP56VbrQtaxpZSGs3kW` |
| Claim | `biqXHWhAZvT51j5n2J13Qu8YxLaqL7D1AJi8HNbp7qY7E2njfAuJBkkdmTjAxTDtrFvKxf2ga8L7Xh9xKDaYjHQ` |
| Transfer claimed feathers | `BFX8s4esYTezWw6u6ufADfamoPo4mg5xHNpXM7fnHV7LJNfxRuxbJKLLFnCceD2i5HmC2E2WR6mgy6wE9tS69rR` |

Mint: `EPXKTspQpNsYjw8khbTawjXeUJdVknL1iDrxVq7itvaw`. Final minted supply: 1,000,000 base units; sender 876,544 and recipient 123,456. Authorized lifetime allowance: 2,000,000 units, including unpaid/expired authorization. No burning or sending reopens the cap. All transaction fees were local faucet SOL, separately accounted from feather supply.

The independent SPL token suite also passed twice with fresh ephemeral mints, covering exact signed-byte replay, wrong decimals/mint/owner, insufficient balance, missing/corrupted signatures, unauthorized minting and atomic ATA rollback. See [token evidence](solana-verification-plan.md#executed-token-integration-evidence).

### Finality tracker follow-up

A subsequent live RPC check reproduced `Minimum context slot has not been reached` when a finalized block-height request used the moving processed slot returned by signature status. The tracker now reads finalized height without that incompatible minimum and still rechecks signature history before declaring the signing lifetime expired. Nineteen tracker contract tests pass, including a lagging-finality regression. A live absent-history/past-height probe now returns `expired` with `historicalOutcome: unknown`, rather than starving until timeout. This does **not** establish that the original transfer failed: the local node no longer returned its historical status. Expiration never authorizes an automatic freshly signed replacement or a database refund; persisted receipts/reconciliation remain necessary.

## Reproduction and limitations

Run `npm run test:chain:program` only against a fresh, already deployed and uninitialized program on a dedicated loopback validator. It requires explicit `GOOSEY_SOLANA_RPC_URL`, the actual `GOOSEY_SOLANA_GENESIS_HASH`, and `GOOSEY_SOLANA_TEST_ADMIN_KEYPAIR` pointing to a newly generated `goosey-admin-keypair.json` in a dedicated `/tmp/goosey-solana-*` directory. It checks the real loader upgrade authority before using that key. Do not use personal wallets. The script deliberately exhausts this test campaign and refuses to reinitialize an existing config; use a new isolated ledger for another full run, never reset the shared website/sandbox.

Only this dedicated test upgrade key is read from disk; participant and issuer keys exist only in memory and are discarded. No private keys are committed. Public signatures refer to this local ledger, not devnet or mainnet explorers.

## Escrow execution follow-up

The expanded suite subsequently passed **53 real transaction cases** on a separate temporary validator at port 24999, genesis `HomMa9mEuscMn8i4qEjnpLrHijWR65EXb5QhMZdFTZtu`, using the same program artifact. The shared validator at 18999 was not reset. The isolated validator was stopped after testing; its full receipt log is retained locally at `/tmp/goosey-solana-escrow.ZzRxMI/program-e2e.log`.

The shipping `escrow-client.ts` builders created two markets, allocated the large Seats accounts, registered a participant, deposited claimed tokens, and withdrew through the market PDA. Actual execution rejected unauthorized market creation, invalid market parameters, foreign enrollment/wallet/vault/seats, missing funds, zero amounts, skipped/replayed nonces, over-withdrawal, and direct admin spending from the vault. A second failing instruction rolled back a preceding successful token CPI and nonce update in the same transaction.

An unsolicited 1,000-base-unit vault donation did not increase available cash. After withdrawing all legitimate deposits, the wallet held 875,544 units, the transfer recipient 123,456, and the vault 1,000: exactly 1,000,000 minted units. Available cash was zero and next nonce was three. The shipping `readGooseyEscrow` independently verified the finalized account snapshot at slot 93, including the donation surplus and all-seat cash reconciliation.

Not yet proven here: CLOB matching, oracle and feather payout, reserved-position handling, seat-capacity exhaustion, concurrent sends, account/wallet linking with durable one-use nonces, browser signing/rejection flows, indexer rebuild, restart/fork recovery, or devnet execution. The website remains database-backed until those integrations are implemented and tested.

### Independently repeated prepare/sign/submit path

`npm run test:chain:isolated` now owns a fresh validator lifecycle. An independent main-agent run passed all 53 cases on genesis `8B5kFZ4Ep445nFCka77Q6mh3ochizCJqcswtoczsdwdF`, RPC port 54619. Evidence and the binary-hash manifest are retained under `/tmp/goosey-solana-runner-oElw0p/`. The runner stopped its owned children after success and left shared ports 18999/8080 untouched.

The real transfer used `prepareFeatherTransfer` after finalized claim state, signed with the ephemeral participant wallet, and sent using `submitSignedFeatherTransfer`. Its receipt callback ran before submission; actual transaction metadata and token balances then verified the result. Transfer signature: `3Xg3pr8PY7DUMViBKVMHmZkFzjnsxJQvna6AvjDj5oVwbCiR2wXxCZh6yP4PD8cfhiAjoJT2bSQjDPwMKquCq3qm`. The finalized escrow reader independently passed at slot 122. This verifies the shipping preparation/submission code, not a browser extension or crash-durable browser receipt store: the test callback records its receipt in memory.

### Regression after integrating placement instructions

After wiring book bootstrap and `place_order`, the newly built SBPFv3 ELF (`da9809206f856402ffb37003ec06ebba2404e3277219501d0ec7303d9640d9c7`) passed the same 53-case foundation suite on a fresh isolated validator. Genesis: `4mojgA1zamwXERzHVZ565NG9Auc5irCZ7UH2FQwjCfJH`; evidence: `/tmp/goosey-solana-runner-SCClCw/`. Finalized reader passed at slot 121, and owned children stopped normally. This is regression coverage of existing instructions on the new artifact, **not actual placement-instruction verification**. The shared validator at 18999 remains on its previous deployment.

## Actual exchange execution

`npm run test:chain:exchange` selects the exchange suite in the same isolated lifecycle runner. On 2026-09-19 it passed **109 actual transaction cases**, plus identical-wire replay and finality checks. The main agent reviewed the complete harness and its recorded output. Evidence: `/tmp/goosey-solana-runner-qTYC9P/`, genesis `Feh2yTUhoB4SpD5CGmFfC6P4g7HL55gpZnUqpdAkF891`, using the same SBPFv3 artifact hash above. Runner processes exited afterward; the shared app and validator were not reset.

The suite claims real program-issued SPL feathers for four ephemeral wallets, deposits them, constructs the canonical 69,720-byte book through real rent-funded growth, and executes the shipping order builders. No account data or positions are injected. Execution covers complete-set creation/burning, YES/NO transfers, maker-price and FIFO priority, partial GTC/IOC, FOK rollback, post-only rejection, all self-trade modes, expiry, bounded matching, fee rounding across partial fills, nonce/signature replay, substituted accounts, and atomic multi-instruction rollback. After every placement it reconciles actual heap/free-list membership, all resting reserves, holdings, collateral, fees, vault and total token supply.

Final accounted vault and actual vault were both 3,003,222 base units, including 26,000 collateral and 429 fees; token supply remained 4,000,000. One wallet withdrew its available cash while its positions remained backed. Final successful withdrawal was at slot 148, signature `5VvRpzhWPTeX95KdBS1ypVYSPWEydpwjrtACRSSvj33RRPpJcF7XLt2xKyKGBfLbEboHcasoEDrFJ99FKvu6dSfv`; the run waited until that slot finalized. Maximum observed CU was 76,200 for nine makers, **not a worst-case bound**.

Remaining gates include cancellation/replacement/result-payout lifecycle, integrated full-capacity stress, market-close boundary, browser wallets and HTTP flows, indexer recovery/forks, and devnet rehearsal. The suite uses privileged ephemeral local test funding for SOL/rent; it does not prove a production fee-sponsorship system. Successful local matching does not switch the website's financial backend.

### Finalized readers and real market-close boundary

The expanded suite passed **132 actual transactions** on genesis `8CK27P75NjUhGmhRW1oaayZfazi3Go1iUE2ReyDNZwHX`, with receipts in `/tmp/goosey-solana-runner-rA3xR0/`. Loaded artifact SHA-256: `17719e98ad055d69d4bc6f9eb6dba79c7cd0550be2e2f5875c2cc34449dde878` (includes cancellation entrypoints; this run does not execute those entrypoints).

Fourteen shipping `readGooseyEscrow` snapshots with `includeOrderBook: true` verified real finalized states, including a live 1,435-unit cash reserve, minted positions, accrued fees, and post-withdrawal balances. Each reader reconciles the canonical full book and token backing from one RPC batch. Exact successful signatures were checked for finality, not merely compared with an advancing slot counter.

A second market was funded from actual withdrawn/transferred feathers. Its real Clock close was `1789847430`: a fill executed before close, then otherwise fillable FOK, GTC and IOC requests were rejected at/after close. A preceding withdrawal CPI and nonce update rolled back when a later instruction attempted a closed-market trade. Unreserved cash remained withdrawable after close, while the live order's 101-unit reserve stayed protected. The final closed-market reader observed slot 274, 2,505 accounted/vault units, 1,000 collateral and 10 fees. No Clock warp or account rewrite was used. Exact equality-second scheduling is not guaranteed across runs; the assertions establish pre-close success and at/after-close rejection.

This closes the earlier basic market-close and finalized trading-reader gates. Resolution/payout-aware reading, cancellation execution, wallet-extension flows, fork recovery and devnet remain separate work.

## Actual cancellation and cleanup execution

The isolated `--suite cancellation` run passed **88 transaction cases** against artifact `17719e98ad055d69d4bc6f9eb6dba79c7cd0550be2e2f5875c2cc34449dde878`, genesis `38NPCDZZ43ZPcw5j5eDFagPf9BrYrpfcPvUAfB92mBpb`, RPC port 51070. Evidence is retained at `/tmp/goosey-solana-runner-MtYRJq/`. The runner stopped its validator; shared services were untouched.

All feathers and positions came from actual enrollment claims, deposits and matched orders. Shipping cancellation/cleanup builders exercised wrong-owner, stale-nonce, stale-heap-hint and recycled-ID rejection; exact cash/YES/NO releases; a 40,005-unit remaining fee-chain reserve refund; identical signed replay; and rollback when a second cancellation or cleanup instruction failed. Live cleanup was rejected, while real-Clock expiry and post-close permissionless cleanup succeeded without consuming owners' nonces. Owner cancellation remained available after close. Exact-signature finality and the shipping full-book reader verified both books empty and all reserves reconciled.

Small-book observed CU: owner cancellation 13,352–17,849; expired cleanup 15,456; closed cleanup 10,406–10,956. These are measurements, not worst-case bounds. Full-capacity runtime stress, higher-level wallet preparation/submission, fork recovery and resolution remain separate gates. Run with `GOOSEY_SOLANA_BIN_DIR=<installed-bin-dir> npm run test:chain:isolated -- --suite cancellation`.

### Resolution-enabled artifact and wallet-prepared cancellation

The updated suite passed **94 real transactions** on artifact `3f13ad17511e14c5403b1870f581692a2ec0f68ad40fb6a28bbc42061fbcb9af`, genesis `cMMLYyaDWR9Czjj8p5L1U9yoxK2ujWcgBPTWksL28jz`. Evidence: `/tmp/goosey-solana-runner-cgZRGo/`; owned validator stopped. Two distinct nontrading reviewers were enrolled with one-unit allowances (no claims), and the shipping resolution builder initialized each market before trading. The earlier 88-case evidence remains unchanged.

The additional cancellation used `prepareCancelOrder` against finalized state, the actual participant as sole signer/fee payer, and `submitSignedWalletTransaction`. The receipt callback wrote a private mode-0600 file before RPC saw the signature. Execution refunded exactly 24,693 units, incremented only the owner's nonce, and reached exact-signature finality. Signature: `3kJHPE7v85uz12ztXk5eAsLyt7Bw7J4wKHge68JTrZidnCE64VVo5MsNaH4DBn1cbse55rQvfF1utymh1JWKcuDB`; measured 17,690 CU. This proves the high-level local transaction path, not browser-extension approval, browser storage recovery, or outcome payouts.

### Resolution admission and wallet-prepared matching

The exchange suite passed **142 actual RPC transaction cases** (101 successes and 41 expected rejections) on the same resolution-enabled artifact, genesis `NQCj8u86TndHSGbtSWxKo9rdi3BSNtLdpFGxK6BgpYz`. Evidence and artifact manifest: `/tmp/goosey-solana-runner-irjTN2/`. Eighteen finalized shipping reader snapshots included the canonical resolution account in the same nine-account financial batch. Trading without initialized resolution, legacy seven-account placement, and duplicate reviewer identities were rejected.

The shipping `prepareOrder` constructed an order from finalized balances, nonce, book and Open resolution state. The participant alone signed and paid its 5,000-lamport fee; `submitSignedWalletTransaction` submitted the exact signed message. Actual finality, seat balances, eight units of exchange fees, unchanged SPL custody/collateral and all order reserves were reconciled. The receipt callback was checked before submission, but used memory: this is **not** browser persistence/recovery evidence. Real Clock pre-close success and at-close rejection also passed. These results do not establish the subsequent outcome approval/claim lifecycle or switch the website from its database financial backend.
