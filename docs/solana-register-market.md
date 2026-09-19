# Register an existing chain market in the catalog

`scripts/solana-register-market.ts` is a trusted operator command, not a public
authentication interface. The explicit actor ID must belong to an existing
ACTIVE ADMIN. Possession of database/server credentials is the operator trust
boundary; passing an ID does not authenticate an interactive user.

Run `node --import tsx scripts/solana-register-market.ts --help` from the project
root. No package script or dotenv loading is implicit. Supply the existing server
database configuration (`DATABASE_PROVIDER` and its corresponding database URL)
and all four explicit `GOOSEY_SOLANA_CLUSTER`, `GOOSEY_SOLANA_RPC_URL`,
`GOOSEY_SOLANA_PROGRAM_ID`, `GOOSEY_SOLANA_GENESIS_HASH` values. Only localnet/devnet
are supported. Set `GOOSEY_SOLANA_TERMS_DIRECTORY` to the existing canonical,
private absolute retention directory. The shipping store validates filesystem
safety and exact canonical bytes; this command does not create or repair it.
Apply required schema upgrades separately using the established operator process.

Invoke the script with all six separate option/value pairs:

- `--actor-user-id`: existing administrator ID, not a wallet address.
- `--chain-market-id`: canonical unsigned decimal u64 (including zero), without
  signs, leading zeroes, exponent notation, or numeric rounding.
- `--slug`: 3–120 lowercase alphanumeric/hyphen characters, no empty segments.
- `--short-title`: 3–90 characters.
- `--description`: 20–5000 characters.
- `--category`: 2–60 characters.

Quote multiword values in the shell. Use genuine operator-approved metadata;
there are no sample markets or default metadata. Text must have no outer
whitespace and satisfy the service's control-character restrictions. Unknown,
duplicate, incomplete, positional, and `--option=value` arguments are rejected.
RPC/database/terms-path overrides are not accepted as CLI arguments.

After argument/config validation, the command runs the database startup guard
and calls `registerSolanaMarket`. The service verifies the active administrator,
finalized chain accounts, sealed terms with both reviewer acceptances, canonical
retained content and economic/network bindings, and a final genesis recheck.
It atomically creates only a DRAFT/SOLANA catalog Market with null collateral,
its Solana binding and its audit record. It does not create/open a chain market,
sign/send transactions, fund wallets, grant feathers, create financial accounts,
trade, or enable public listing. Startup guards use the existing server database
hardening conventions; this is not a migrations command.

An identical request returns `created:false` without new catalog/audit rows.
Conflicting metadata, slug or binding fails. Existing rows are not demoted to
DRAFT: output reports the actual stored status. The small JSON success result
contains `created`, catalog `marketId`, `chainMarketId`, `status`, and
`executionBackend`, not RPC URLs, manifests, passwords, or database credentials.
CLI error output uses fixed stages or allowlisted service codes, never raw
exception messages. Exit status is 0 for success/help, 1 for failure. Cleanup
failure can occur after commit; inspect the result and retry only the identical
request if needed. No automatic retry or conflict-bypass is performed.

Verification: `npx vitest run scripts/solana-register-market.test.ts` exercises
strict parsing, environment/startup gates, exact service arguments, idempotent
output, sanitized errors and cleanup with a **mocked service/database boundary**.
A subprocess verifies real help execution without database/runtime configuration.
The separate catalog integration suite proves actual isolated SQLite transactions;
these CLI tests do not claim RPC or on-chain execution. Do not run registration
against a shared database merely to test this command.
