# Persistent local-only validator

This operator owns one foreground validator and a retained private ledger. It does
not touch the shared validator, port 8080, application environment, database,
participant balances, markets, enrollment or claims. It is not a production
deployment manager. Keys are LOCAL TEST keys: never fund them on public networks.

Use an installed validator supporting the current compiled ELF. Build/review the
ELF separately; creation snapshots those exact bytes. Set
`GOOSEY_SOLANA_VALIDATOR_BIN` (or `GOOSEY_SOLANA_BIN_DIR`) explicitly if not on PATH.
`GOOSEY_SOLANA_PROGRAM_ARTIFACT` optionally selects the actual compiled artifact.
No personal Solana CLI configuration is read.

## Current development instance (2026-09-19)

The local development app now reads a retained instance at
`/Users/aryan/.local/share/goosey-localnet-20260919`, RPC port 20999, genesis
`AjRRXmyGBFhUtVWWp5xYXYKAP4Ha8vyTDRNVrkTVA2DE`. Its pinned compiled artifact is
`d2f3e57d090ab54369068a450c9f2d2f9b4bf6e629a06eb826672d824c770a82`.
The development caps are 10,000 feathers per wallet and 10,000,000 feathers across
the campaign (10,000,000 and 10,000,000,000 base units). Initial authorized,
minted and supply counters were independently observed as zero through the live
application `/api/solana/status`. The status is `foundation_verified`, **not**
on-chain web trading readiness. Following the backed-up additive SQLite upgrade,
browser capability is enabled for the explicit loopback RPC origin; the CSP permits
that exact origin. The wallet interface now has isolated funded-browser evidence
for actual claims, transfers and lost-response recovery; see
`wallet-browser-verification.md`. The main catalog economic cutover remains
unfinished. This retained instance still has no participant funding or markets.
Runtime bindings reside only in ignored
local environment configuration; neither keys nor ledger files belong in Git.

### Observed transaction-history gap

The first attempted application indexer run against this retained instance on
2026-09-19 stopped with `SignatureHistoryGapError`. Its explicit inclusive
boundary was the actual initialization signature
`1aG4f9mk7atNs6vvtG4SMcq6kZvm4pbRxsTRcysbF558Df1uwCGme8ydnC7u7JLuK1tCoMAotcko4NwnVjNcAYt`.
By then `getSignaturesForAddress` returned an empty list and historical signature
status was null; `getFirstAvailableBlock` was 4162. The installed validator's
default retention is only 10,000 shreds. Retaining the ledger directory does not
mean all historical transactions remain queryable.

The stopped run left one initialized cursor at revision 0, with no committed
head and backfill incomplete; zero receipts/events were imported. The ordered
User balance/PnL and LedgerAccount balance projection had identical SHA-256
`18f3ba061a0c3e2233226c69c602b994976fc627ddb5979ad9a50681d954b764`
before and after. No chain was reset, no synthetic transaction was sent, and no
missing history was silently skipped. There is currently **no running indexer**
for this retained deployment. Increasing future retention cannot reconstruct
already-pruned blocks. Resuming from a different actual transaction would need
an explicit new coverage policy and must not be represented as genesis coverage.

The isolated operator rehearsal at
`/private/tmp/goosey-localnet-proof-Qmx0Xp/instance` proved create/start/stop/restart
with the same genesis and initialization receipt, unchanged zero issuance, and
occupied-port refusal without disturbing the listener. This is localnet evidence,
not a devnet deployment or a machine-reboot durability claim.

## Creation and foreground start

Choose a **new, normalized absolute directory under an existing canonical parent**.
For durable development, storage outside the repository and temporary directories
is recommended, not enforced. Private temporary directories are valid for isolated
tests, but the operating system may remove them. Never reuse an existing directory
with `create`; `start` deliberately uses the previously created instance.
Create takes required decimal integer caps in base units (1 feather = 1000 units).
There are no default caps. Substitute deliberately selected values below:

```sh
node --import tsx scripts/solana-localnet.ts create \
  --directory /absolute/private/goosey-localnet \
  --rpc-port PORT --per-wallet-cap BASE_UNITS --campaign-cap BASE_UNITS
node --import tsx scripts/solana-localnet.ts start \
  --directory /absolute/private/goosey-localnet
```

Creation does not start a service. It exclusively writes separate admin/upgrader
and enrollment keys, private CLI config, a read-only ELF snapshot, and manifest.
Startup reserves TCP/UDP PORT through PORT+40, rejecting blocks containing 8080,
18999, 19000 or 19900. RPC is loopback PORT, WebSocket PORT+1. All sockets must be
free; no process is killed to reclaim them. There is a socket-handoff race, so
startup independently verifies the freshly retained authority and exact code.

Startup resumes the same ledger with no reset. It pins actual full genesis and
checks canonical ProgramData, upgrade authority, exact ELF bytes (permitting only
zero allocation padding), validator version and finalized config/mint. On first
startup only, admin signs the real initialize instruction with explicit caps.
Genesis gives admin local SOL for initialization; the enrollment key and
participants are **not** automatically funded. Initialize creates a zero-supply
mint/config, not feather grants. Later starts allow legitimate existing issuance
but verify authorities, caps and the shared configuration invariants.

Readiness prints only public server runtime bindings. It does not enable browser
wallets or restart the app; adopt bindings separately. Foundation readiness is
not exchange readiness. Wallets must genuinely support `solana:localnet` and the
browser must reach this loopback endpoint.

Ctrl-C/SIGTERM stops only the owned validator, retaining state. Start again with
the same command; changed ports, validator version, authority, artifact or genesis
fail closed. A newer source ELF is **not** deployed on restart: validator genesis
program arguments are ignored for existing ledgers. Upgrades require a separate
explicit workflow; this command has no upgrade/reset mode.

## Recovery and limitations

- Files and containing directory are fsynced after exclusive creation. Signed
  initialization receipt (wire bytes, signature, lifetime) is durable **before**
  RPC send. It is sensitive and never printed. Existing finalized matching
  configuration recovers success. Otherwise the same receipt is tracked, never
  replaced or automatically re-signed. Unknown, expired or failed receipts stop
  startup for operator review, including a crash between receipt persistence and
  send. This conservative slice does not offer automatic retransmission.
- Interrupted creation leaves an incomplete private directory; it is never
  overwritten or silently repaired. Keep it for inspection and choose a new name.
- The exclusive `operator.lock` prevents concurrent launchers. An uncatchable
  crash can leave a stale lock or orphan validator. Verify the old process and
  ledger are stopped before manually removing **only that instance's lock**.
  Never kill a process based solely on a recycled PID or a port number.
- Protect/back up the entire directory together while stopped. Do not delete
  ledger files, replace keys, change manifest or edit the private CLI config.
  Missing pinned genesis files are rejected, not regenerated. Local filesystem
  owner and RPC are trusted; this is not a hostile-local-user isolation boundary.
- Agave's default ledger pruning still applies. A durable ledger is not unlimited
  transaction history. Configure/engineer a separate retention policy before
  relying on complete historical indexing. Ledger compatibility across validator
  versions is not assumed.
- A later explicit enrollment operator should use the shipping
  `buildAuthorizeEnrollmentInstruction` with reviewed real identity commitment,
  target wallet, allowance and expiry. It needs explicitly funded operational SOL.
  Participant claim is wallet-signed and needs an explicit fee-funding path. No
  enrollment CLI, hidden issuer funding or participant funding is included here.
