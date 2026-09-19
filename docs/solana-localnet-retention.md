# Localnet retention and indexer coverage

The installed `solana-test-validator 4.2.2` help describes
`--limit-ledger-size <SHRED_COUNT>` as retaining shreds in rooted slots, with a
default of **10,000**. This is a rolling pruning policy, not archival storage.
An operator can have healthy current accounts while old signatures and full
transaction receipts have already disappeared. A successful restart or larger
limit cannot recreate deleted history.

## Explicit bounded policy

New `scripts/solana-localnet.ts create` instances persist `ledgerShredLimit` in
their exclusive immutable `manifest.json`. The default is **1,000,000 shreds**.
The optional create-only `--ledger-shreds COUNT` accepts canonical decimal values
from **10,000 through 10,000,000**. Zero/unlimited, fractions, exponents, leading
zeroes and larger limits are rejected. Choose a value against available storage
and observed traffic; the default is 100 times the validator's built-in default,
not a promise of a particular number of days or transactions.

Every `start` explicitly passes the manifest policy to the owned validator as
`--limit-ledger-size COUNT`, including on ledger resume. Startup checks installed
CLI support and the retained validator version. There is no start-time override
and no environment override that silently changes a retained instance's policy.
Help and successful startup report the rolling-history limitation.

Backward compatibility: version-1 manifests that lack `ledgerShredLimit` are
interpreted as **1,000,000** by this operator on their next manually authorized
restart. Their bytes are not rewritten, and no restart is initiated by this
change. This explicit legacy interpretation raises their former effective 10,000
limit prospectively; it does not recover pruned data. New manifests always record
the number, so future defaults cannot silently change their policy. Changing an
existing explicit manifest's immutable policy is not implemented: do not hand-edit
it or regenerate a genesis to disguise a gap.

The shred limit is **not a strict total-disk quota**: account storage, snapshots,
compaction overhead, retained ELF, operator logs and other validator files are
outside that measure. Monitor filesystem capacity and the rate at which the
earliest available history advances. The operator never disables pruning or
enables unlimited ledger retention. A byte quota, log rotation, historical RPC
archive and archival backup lifecycle remain separate operator work, not features
claimed by this patch. Never delete files from a live ledger to make room.

## Start indexing before subsequent activity

1. Create and start an isolated operator with the chosen retention policy; wait
   for finalized configuration verification. Retain its actual initialization
   signature from `initialize-receipt.json` privately. Do not publish that whole
   file: it also contains signed transaction wire.
2. Before enrollment/markets/trades, start the existing durable indexer using that
   actual signature as the explicit inclusive `--coverage-start` boundary, with
   the matching full genesis, program and database configuration. The indexer
   independently verifies finalized transaction receipts and advances only its
   committed durable coverage. Do not invent an earlier coverage boundary.
3. Keep ingestion running and monitor failures, cursor lag and RPC availability.
   A larger rolling ledger only gives a bounded catch-up window. Same-slot
   signature pagination order is not execution order. Startup success alone is
   not proof that all previous history is available.
4. Back up durable indexer state and operator data under an explicit operational
   policy. A state snapshot, a signature-only list, or a retained signed wire is
   not a substitute for complete historical transaction metadata and logs.
   Longer-lived verifiable historical replay requires an independently retained
   complete archive/receipt source compatible with the verifier, not an assertion
   that this rolling validator is archival.

## Existing pruned history

The reported shared validator at port 20999 returned an empty address signature
page, null signature status and `getFirstAvailableBlock = 4162` when asked to
cover its initialization. This is consistent with its missing early history;
the block boundary alone does not establish completeness for any program.
`SignatureHistoryGapError` is the correct refusal, not a retryable success and
not permission to advance or delete the cursor. This change does not modify
that process, ledger, environment or cursor.

If the original matching-genesis receipts are no longer available locally,
recovery requires a pre-existing complete archive or suitable backup. The signed
initialization receipt alone cannot reconstruct historical execution metadata.
Without such a source, historical completeness is irrecoverable from this RPC.
Any decision to begin explicitly limited later coverage or create a separate new
chain must be an independently authorized, honestly labeled operational choice;
it must not pretend to repair the original gap. Do not reset/replay the shared
chain or fabricate receipts, balances or cursor progress.

## Verification

The opt-in rehearsal passed on 2026-09-19 with the pinned `d2f3e57d…770a82`
artifact. Its retained isolated instance is
`/private/tmp/goosey-localnet-retention-Bnkw6X/instance`, with an explicit
250,000-shred policy. The owned validator was stopped after the test; the shared
20999 process was not restarted or reconfigured.

Ordinary tests (no validator or chain writes):

```sh
npx vitest run src/lib/solana/localnet-manifest.test.ts scripts/solana-localnet.test.ts
```

Opt-in actual validator proof, using an explicitly selected installed toolchain:

```sh
GOOSEY_LOCALNET_RETENTION_E2E=1 GOOSEY_SOLANA_BIN_DIR=/absolute/toolchain/bin \
  npx vitest run scripts/solana-localnet.test.ts src/lib/solana/localnet-manifest.test.ts
```

This test allocates a fresh private temporary instance and reserves an isolated
TCP/UDP port block, creates an explicit 250,000-shred manifest, starts the actual
validator, and verifies its actual process arguments. It permits only the
operator's real config/mint initialization, then checks finalized history through
RPC before and after a clean owned restart. Genesis, immutable manifest and
initialization receipt must stay unchanged. Owned processes stop; private logs,
keys and ledger stay in the reported temporary directory for inspection. It
never reads retained shared keys or uses ports 20999/18999/8080. This short test
proves flag wiring and restart retention, **not** a long-duration pruning horizon
or archive completeness under high traffic.
