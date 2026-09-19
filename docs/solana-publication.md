# Explicit chain market publication

This creator operator publishes **existing canonical terms**, never invented
market content. It does not start validators, deploy programs, change app env/DB,
enroll reviewers, mint feathers, seed liquidity, or approve terms for anyone.
Admin spends real localnet/devnet SOL for rent and fees. No automatic faucet use.

## Required inputs

- An already initialized, verified Goosey deployment on pinned localnet/devnet.
- A canonical manifest file produced/validated by the shipping `market-terms`
  codec. Exact UTF-8 bytes, key order and formatting matter: no pretty printing or
  trailing newline. Supply real reviewed question/rules/sources/times. Market ID,
  economics, creator and both reviewer/enrollment addresses come only from this
  manifest. Reviewer enrollments must already exist before `init`; their actual
  canonical account bindings are checked in the finalized snapshot before rent
  is spent creating the market. No enrollment is created by this operator.
- An explicit runtime JSON file with exactly `cluster`, `rpcUrl`,
  `programAddress`, `genesisHash`. These are the actual deployment bindings, not
  placeholders copied from tests. No `.env` or default RPC is consulted. Protect
  this file if the URL contains provider credentials.
- Creator/admin keypair JSON (64 byte integers), owned regular file mode 0600.
  This is never a reviewer key. Signer must match manifest creator/config admin.
- A new absolute signing-state directory under an existing canonical parent.
  `prepare` creates it 0700. Store it durably; never share its Seats key/receipts
  with the web app or reviewers.
- A **separate, non-nested**, pre-existing owned 0700 terms-store directory,
  configured explicitly with `--terms-directory`. This must be the serving
  backend's retained-terms store. `retainMarketTerms` verifies and durably retains
  exact bytes before commitment; same content is idempotent, conflicting terms
  for the same deployment/market are rejected. Signing state is not a substitute
  for this immutable serving store. Back it up/replicate separately.

## Staged commands

Every command receives the same `--runtime`, `--manifest`, `--state`, and
`--terms-directory` absolute paths. Creator commands additionally require
`--admin-key`. Example invocation, substituting actual reviewed paths:

```sh
node --import tsx scripts/solana-publish-market.ts prepare \
  --runtime /absolute/runtime.json --manifest /absolute/canonical-terms.json \
  --state /absolute/private/publication --terms-directory /absolute/private/terms \
  --admin-key /absolute/private/admin.json
```

1. **`prepare`** verifies network/config/PDA bindings, refuses an existing market,
   retains canonical terms, generates and fsyncs the unique Seats key, and retains
   immutable inputs. No transaction is sent. Reusing an existing state directory
   is refused rather than overwriting keys. Interrupted preparation needs manual
   inspection; incomplete state is not silently regenerated.
2. **`init`** requires both matching reviewer enrollments and creates Seats+market+vault in one real transaction using actual RPC
   rent, then creates/grows/finalizes the canonical book, confirming each size
   step. Finally initializes the immutable terms commitment. No trading activation
   or reviewer acceptance is performed. The 1.4M CU limit is an explicit cap,
   not a claim about measured usage or a priority fee.
3. **`review-instructions`** takes **no admin key** and emits unsigned instructions
   for both designated reviewers: exact program, ordered account addresses/roles,
   instruction data, digest, and genesis. It never signs, submits, or claims
   acceptance. Each reviewer must independently read the exact retained manifest,
   verify finalized bindings, and use their own wallet integration to construct
   `buildAcceptMarketTermsInstruction({programAddress, marketId, seats, reviewer,
   expectedDigest})`, supply a current pinned blockhash and their own fee payer,
   sign and submit. The shipping builder is in `market-terms-client.ts`; existing
   wallet transaction submission/tracking can be reused. The CLI intentionally
   does **not** accept reviewer key files. Instructions are not a signed
   transaction or a substitute for that independent review. Until an independent
   reviewer signing surface is used, the workflow remains awaiting approvals.
4. **`seal`** requires both real finalized acceptance bits and only signs the
   creator's seal instruction. Missing approvals fail closed.
5. **`activate`** requires sealed exact terms and initializes resolution with the
   same immutable reviewer pair. It does not place orders. Admission remains
   subject to chain clock, close time, enrollment and balances; initialized
   resolution alone is not a promise of executable liquidity or an open market.
6. **`status`** takes no admin key, validates the finalized state and reports
   current book/terms/acceptance/resolution fields. It never manufactures a
   probability, balance or approval.

For `init`, `seal`, `activate`, rerun the same command/inputs after interruption.
All stages re-read finalized configuration, market economic bindings, custody,
Seats, and available book/terms/resolution in a coherent batch. Draft book sizes
and tags are checked; ready books use the shipping reserve reconciler. RPC trust
remains necessary; this operator verifies loader ownership/configuration, not
the deployed ELF hash. Independently verify deployment code before publication.

## Receipts, restart and limits

Every signed transaction (including initial multi-signer Seats creation) has an
exclusive private receipt containing exact wire bytes, signature, validity
height, step, manifest digest and genesis. File and directory are fsynced **before
send**. Do not log or publish signed wire bytes. On restart, an exact finalized
expected state skips that stage; otherwise an existing receipt is tracked, not
re-signed or sent again. Unknown, expired, failed or pre-send-crash receipts stop
the workflow for manual reconciliation. Recovery validates canonical transaction
wire, every Ed25519 signature, signer set, and exact shipping instruction/account
ABI recompiled with the retained blockhash. Sole-signer stages reuse the existing
wallet receipt validator; market creation additionally verifies the Seats
co-signature. If current rent requirements differ from the retained market-create
instruction, recovery refuses rather than silently changing its intent.
Never delete a receipt just to force a
retry; replacement/retransmission policy is intentionally not automated here.

An exclusive `operator.lock` serializes each signing directory. Uncatchable
termination may leave a stale lock; verify the prior operator is stopped before
removing only that lock. Retain the Seats key and state together, never regenerate
them for the same market ID. Different directories targeting the same market can
still race: on-chain PDA constraints prevent duplicate creation, and this tool
refuses mismatched Seats rather than adopting another creator's attempt.

SIGINT/SIGTERM abort pending RPC/tracking but cannot retract sent transactions.
Rerun to reconcile. Commands have a ten-minute overall bound and 90-second
per-signature finality tracking. Chain clock enforces deadlines; missed close,
missing enrollment, insufficient SOL or immutable terms conflicts require an
explicit operational decision—not fictional fallback content/approvals.

Unit fixtures/mocked orchestration tests are not real-chain publication evidence.
No actual participant market is published by tests. Real end-to-end publication
requires the operator-supplied canonical manifest and independent reviewer wallets.
# Verified isolated operator rehearsal

On 2026-09-19, `scripts/solana-publication-e2e.ts` completed 15 actual
CLI/RPC checks against a fresh local ledger and the compiled artifact
`d2f3e57d090ab54369068a450c9f2d2f9b4bf6e629a06eb826672d824c770a82`.
Run it with `npm run test:chain:isolated -- --suite publication`.

The explicit TEST manifest was prepared, initialized, independently accepted by
both test reviewer keys, sealed and activated. Read-only commands succeeded
without access to private-key paths. Tampered receipts and manifests were
rejected. Restarted processes preserved all 12 receipts and finalized state,
without duplicate transactions or further changes to the admin balance.
Reviewer acceptance bits were 3; resolution was open; mint supply remained zero.

Evidence: `/private/tmp/goosey-solana-runner-ROPwvL/publication-evidence/result.json`.
Genesis: `5HHaN5AynNEX6eH39huGfyEjeYQBf1jVLWWJ2vdDMYWF`.
This is an isolated runtime proof, not publication of a real shared market or
approval by real event reviewers.
