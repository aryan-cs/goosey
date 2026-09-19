# Explicit operator enrollment

`scripts/solana-enroll.ts` authorizes one on-chain feather enrollment using the
configured enrollment authority. It is an operator tool, **not a public API or
self-service eligibility endpoint**. The operator must independently establish
eligibility and supply the target wallet, identity digest, allowance, and expiry.
The tool does not infer any of these, generate identity digests, assign default
grants, or replace an existing wallet/identity association.

Only localnet and devnet are supported. Feathers are free, transferable, and
nonredeemable. This command does not mint/claim feathers, fund SOL, purchase
tokens, write financial database records, or change validator/application state
outside the explicitly submitted enrollment transaction. The target wallet
later authorizes its own separate claim.

## Before running

- Explicitly set **all four** variables: `GOOSEY_SOLANA_CLUSTER`,
  `GOOSEY_SOLANA_RPC_URL`, `GOOSEY_SOLANA_PROGRAM_ID`, and
  `GOOSEY_SOLANA_GENESIS_HASH`. Use values from the intended running deployment;
  there is no fallback to Solana CLI configuration or a default keypair.
- Obtain the existing issuer's Solana CLI JSON keypair file (64 integer bytes).
  Its public key must match the actual on-chain `enrollmentAuthority`, not merely
  the administrator. The issuer must already have enough SOL for account rent
  and transaction fees. There is no automatic airdrop or funding request.
- Both the keyfile and receipt parent directories must be canonical absolute
  paths, owned by the current OS user, without group/other permissions (normally
  mode `0700`). Keyfiles must be private regular files (normally `0600`), not
  symlinks or hardlinks. On macOS use canonical `/private/tmp/...` paths rather
  than the `/tmp` symlink when storing private disposable files there.
- Choose a **new absolute receipt filename** in an existing private directory.
  Existing paths, including symlinks, are refused. The tool never overwrites,
  deletes, rotates, or automatically replaces a receipt.
- Provide the authorized nonzero identity digest as exactly 64 hexadecimal
  characters (32 bytes). Maintain the identity-to-digest mapping privately;
  do not derive eligibility from arbitrary wallet/session input. Account seeds
  and identity commitments are public, so do not use guessable personal data as
  an unsalted digest. This tool does not design or implement identity policy.
- Allowance is a positive integer in **base units**; feathers have three decimal
  places. Expiry is a positive signed-64-bit Unix timestamp in seconds. No
  decimal display amounts, exponents, relative expiry, or default amounts are
  accepted. Expiry is checked against finalized on-chain Clock, not local time.

Read usage without network access or keys:

```sh
node --import tsx scripts/solana-enroll.ts --help
```

## Authorize and submit once

After explicitly exporting the deployment's four runtime variables, substitute
your independently approved values below. Uppercase placeholders are not defaults:

```sh
node --import tsx scripts/solana-enroll.ts submit \
  --authority-keyfile /ABSOLUTE/PRIVATE/issuer.json \
  --wallet TARGET_WALLET_ADDRESS \
  --identity-digest APPROVED_64_HEX_CHARACTERS \
  --allowance APPROVED_BASE_UNITS \
  --expires-at APPROVED_UNIX_SECONDS \
  --receipt /ABSOLUTE/PRIVATE/new-enrollment-receipt.json
```

The explicit `submit` command authorizes signing; there is no second prompt.
Protect shell history/process visibility as appropriate for your identity policy.
No secret key bytes appear in command arguments, receipts, or CLI output.

Preparation verifies the deployed program/network, then reads configuration,
mint, target enrollment, identity record, and Clock in one finalized batch. Both
associations must be absent. It checks the actual issuer, per-wallet cap,
`campaignCap - totalAuthorized` (not remaining mint supply), lifetime issuance
counters, and future expiry. It obtains a finalized signing lifetime and uses the
shipping enrollment instruction with the issuer as the only signer and fee payer.
Concurrent changes can still make execution fail; preparation is advisory.

After signing, the shipping submission helper checks the exact message and
signature. Before its single send, the CLI validates and writes the exact signed
wire, signature, blockhash/lifetime, network/program domain, and enrollment intent
to a create-only `0600` receipt. It fsyncs the file **and its directory entry**.
A persistence failure prevents sending. Even a partially written receipt is
retained for inspection rather than overwritten automatically.

Output `submitted` means the RPC returned the expected signature, **not** that the
transaction finalized. A transport/preflight ambiguity produces `unknown`; it
does not cause another signature or retry. The CLI never prints the signed wire
or identity digest. Treat receipts as private: they include identity commitments
and signed transaction bytes that could be rebroadcast while valid.

## Inspect an existing receipt

With the same explicit runtime domain:

```sh
node --import tsx scripts/solana-enroll.ts status \
  --receipt /ABSOLUTE/PRIVATE/existing-enrollment-receipt.json
```

This mode needs no authority keyfile and performs no signing or submission. It
validates the receipt's canonical signed wire/signature using the shared recovery
validator, reconstructs the exact enrollment message from the retained intent,
and requires a matching runtime domain. Genesis is checked before and after
bounded status inspection. The receipt is not modified.

Status inspection searches transaction history and waits up to 15 seconds for
finality. `finalized` establishes success as reported by the pinned RPC;
`confirmed` is not finality. `failed` reports an observed finalized execution
failure. `unknown` is unresolved. `expired` means the bytes cannot newly land at
the observed finalized height, **not** proof that they never executed: historical
RPC data may be unavailable. The retained last-valid block height is RPC metadata,
not cryptographically signed transaction content; preserve receipt integrity.

Do not rerun `submit` with a different filename or fresh signature to recover an
uncertain result. Inspect the original signature and canonical enrollment/identity
accounts and reconcile the outcome first. Any later authorization is a separate
explicit operator decision. This CLI deliberately offers no rebroadcast,
replacement, receipt deletion, or association-overwrite command.

Exit codes: `0` for help, accepted submission, or finalized status; `2` for unknown
submission or any non-finalized status; `1` for validation/I/O/preparation failure.
On a failure, inspect whether the chosen receipt exists before taking further
action. Logs deliberately avoid raw provider errors and private material.

## Verification scope

`scripts/solana-enroll.test.ts` uses disposable private files, real Solana key and
signature codecs, and mocked RPC/preparation. It covers strict arguments/runtime,
exclusive private persistence, receipt/intent verification, write-before-send,
unknown outcomes, and read-only recovery. It is not a live-chain enrollment test.

```sh
npx vitest run scripts/solana-enroll.test.ts
```

The separate actual-runtime suite uses the isolated runner, a fresh ledger/admin,
and an immutable snapshot of the compiled program. It never adopts a shared
validator, reads existing operator keys, or builds/replaces the compiled artifact:

```sh
GOOSEY_SOLANA_BIN_DIR=/ABSOLUTE/TOOLCHAIN/bin \
  node --import tsx scripts/solana-program-e2e-isolated.ts --suite enrollment
```

It bootstraps the fresh test program, runs the real CLI subprocess through a
transparent loopback RPC observer, checks the private exact receipt before its
first send, and verifies finalized enrollment/identity fields. Repeated receipt,
wrong issuer, per-wallet/campaign cap, and identity/wallet replay cases must fail
before sending and leave watched on-chain accounts unchanged. The status command
must report finality without sending or modifying the receipt. These rejection
cases exercise CLI preparation against real chain state, not failed on-chain
instruction executions. Private evidence is retained in the runner directory as
`enrollment-cli-evidence.json`; the runner stops only its owned processes.

Runtime checkpoint on 2026-09-19: eight cases passed on a fresh isolated ledger
using ELF SHA-256
`d2f3e57d090ab54369068a450c9f2d2f9b4bf6e629a06eb826672d824c770a82`.
This is separate from the mocked tests above and does not certify another build
or deployment. The suite deliberately does not exercise the target's later claim.
