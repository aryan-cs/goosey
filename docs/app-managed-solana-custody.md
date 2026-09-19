# App-managed Solana custody foundation

Goosey can assign an authenticated account a localnet or devnet Solana identity
without wallet-connect UI. This foundation does not submit transactions, fund
accounts, migrate trading, or change the user-facing market flow.

## Security boundary

- `GOOSEY_SOLANA_CUSTODY_ENCRYPTION_KEY` is a dedicated 32-byte, unpadded
  base64url server secret. It has no fallback to `AUTH_SECRET`.
- `GOOSEY_SOLANA_CUSTODY_KEY_ID` is a stable, non-secret identifier used to
  refuse accidental key substitution. Changing it does not rotate existing
  records; a reviewed key-rotation workflow is required first.
- Each Ed25519 secret key is encrypted independently with AES-256-GCM and a
  random 96-bit nonce. Authenticated data binds the ciphertext to its user,
  network, genesis hash, wallet address, key id, and envelope version.
- Database rows store ciphertext, nonce, authentication tag, and public address.
  The public DTO contains only identity metadata and the public address.
- Signer reconstruction is server-internal. Missing configuration, an inactive
  user, a missing identity, altered metadata, altered ciphertext, or a different
  deployment key all fail closed without replacing the identity.

Generate a deployment secret outside source control, convert it to unpadded
base64url if necessary, and place it in the server's secret manager. Never put
the value in `NEXT_PUBLIC_*`, logs, browser responses, fixtures, or Git.

## Current integration point

`ensureAppManagedSolanaIdentity` accepts only a user id obtained from Goosey's
authenticated server session and rechecks that the account remains active. It
idempotently creates one identity per user and pinned Solana deployment domain.
`loadAppManagedSolanaSigner` is reserved for a later server-side settlement
worker. No route or UI exposes either secret material or a signer.

The additive SQLite and PostgreSQL migrations create
`SolanaCustodyIdentity`. The SQLite upgrade runner includes the new migration.
This foundation deliberately does not apply the migration to a live database or
execute against the shared validator.
