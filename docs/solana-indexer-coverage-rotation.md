# Localnet indexer coverage rotation

This recovery path is intentionally narrow. Use it only when the retained
localnet validator has pruned the cursor's old inclusive signature, no page was
ever committed for that deployment, and a newer finalized creator-enrollment
transaction is available as an honest bounded starting point. It does not
recover missing history and never reports full-history coverage.

The command refuses devnet and mainnet, a running indexer, a completed or
in-progress cursor, or any retained receipt/visit in the deployment domain. It
verifies the RPC genesis, deployed Goosey program/configuration, transaction
signatures and finalized root through the normal finalized receipt reader. The
new boundary must contain exactly one `EnrollmentAuthorized` event for the
explicitly confirmed creator wallet.

## Apply the additive audit migration

Do this before inspection. Stop the application writer and continuous indexer
for the maintenance window. The command below creates a new backup and applies
only reviewed additive Solana migrations; substitute absolute paths. It was not
run as part of implementing this feature.

```sh
DATABASE_PROVIDER=sqlite DATABASE_URL='file:/absolute/goosey.db' \
  npm run db:upgrade:solana:sqlite -- \
  --source /absolute/goosey.db \
  --backup /absolute/backups/goosey-before-coverage-rotation.db
```

For PostgreSQL, review and deploy the additive migration through the normal
deployment path:

```sh
npm run db:migrate:deploy:postgres
```

`SolanaCoverageRotation` is append-only at the database boundary. SQLite has
separate update/delete denial triggers; PostgreSQL has a shared denial trigger.
The cursor snapshot and its SHA-256 digest, deployment identity, old/new
boundaries, verified enrollment event evidence, operator reason and timestamps
are inserted in the same serializable transaction as the cursor CAS update.

## Inspect, confirm, then apply

Use the exact configured localnet genesis, program, old boundary, newer
creator-enrollment signature and creator wallet. First run is read-only:

```sh
npm run chain:index:rotate-coverage -- inspect \
  --confirm-genesis=LOCALNET_GENESIS_HASH \
  --confirm-program=GOOSEY_PROGRAM_ADDRESS \
  --confirm-old-boundary=PRUNED_OLD_SIGNATURE \
  --new-boundary=FINALIZED_CREATOR_ENROLLMENT_SIGNATURE \
  --confirm-new-boundary=FINALIZED_CREATOR_ENROLLMENT_SIGNATURE \
  --confirm-enrolled-wallet=CREATOR_WALLET_ADDRESS \
  --reason='Retained localnet history pruned the prior immutable boundary'
```

Review the complete `oldCursor`, deployment and enrollment evidence. Copy the
reported `oldCursorSha256` and repeat every argument in the mutating invocation:

```sh
npm run chain:index:rotate-coverage -- apply \
  --confirm-genesis=LOCALNET_GENESIS_HASH \
  --confirm-program=GOOSEY_PROGRAM_ADDRESS \
  --confirm-old-boundary=PRUNED_OLD_SIGNATURE \
  --new-boundary=FINALIZED_CREATOR_ENROLLMENT_SIGNATURE \
  --confirm-new-boundary=FINALIZED_CREATOR_ENROLLMENT_SIGNATURE \
  --confirm-enrolled-wallet=CREATOR_WALLET_ADDRESS \
  --reason='Retained localnet history pruned the prior immutable boundary' \
  --confirm-old-cursor-sha256=SHA256_FROM_INSPECT \
  --execute=ROTATE_LOCALNET_BOUNDED_COVERAGE
```

Any cursor change after inspection aborts the operation. A failure leaves both
the cursor and audit table unchanged. The command neither starts the worker nor
submits a transaction.

After a successful apply, resume the worker with the same explicit new boundary:

```sh
npm run chain:index -- \
  --coverage-start=FINALIZED_CREATOR_ENROLLMENT_SIGNATURE \
  --continuous
```

Coverage remains explicitly bounded from that enrollment signature. Earlier
activity is unavailable, not silently repaired.
