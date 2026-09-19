# Solana wallet and application integration

Research date: 2026-09-19. Design contract for the main integration. The user confirmed **free, nonredeemable, transferable SPL feathers on localnet/devnet only**, with fully onchain CLOB mutations, balances, and resolution. This task owns the two plans and `scripts/solana-token-e2e.ts`; it makes no app/package changes or exchange deployments. The concrete token RPC test uses the main implementation's transfer helper; it does not test a browser wallet. See the [compiled-program verification plan](solana-verification-plan.md) for the toolchain and test gates.

## Responsibility boundary

### Browser configuration and balance contract (implemented)

`GET /api/solana/status` remains uncached and reports `financialBackend: database`
and `exchangeVerified: false`. After server-side foundation verification it adds
`browserRuntime`, built by `buildPublicBrowserRuntime` from **explicit** settings:

```text
GOOSEY_SOLANA_BROWSER_ENABLED=true
GOOSEY_SOLANA_PUBLIC_RPC_URL=<intentionally public RPC endpoint>
```

Neither setting is enabled by this implementation. The server's private
`GOOSEY_SOLANA_RPC_URL` is never a fallback. Public URLs cannot contain userinfo,
queries or fragments. Localnet requires loopback; devnet requires HTTPS. A path
may contain an explicitly public routing identifier, so operators must never
copy a private provider key into it. Invalid enabled configuration fails closed.
The Next.js `connect-src` policy admits only this configured public origin,
including its explicit port; private RPC origins and wildcard hosts are never
added. These headers are config/build-time values: restart development or rebuild
the deployment when changing browser RPC configuration. This does not configure
CORS on the RPC provider, which must separately allow the application's origin.

The wallet UI should parse the whole same-origin status response using
`parsePublicBrowserRuntime`. It returns null when unavailable/disabled and a
frozen runtime only for consistent explicit configuration. `endpointVerified`
is always false: server verification concerns the server endpoint. Probe the
browser endpoint and use verified readers before requesting wallet signatures.

`readGooseyWalletBalance({ runtime, wallet, signal? })` returns exact bigint
`featherAmount` and `solLamports`, canonical mint/ATA, separate present/absent
statuses, and configuration/observation slots. Wallet and ATA are read together
at finalized commitment after mint/configuration verification. Missing accounts
can legitimately mean zero; RPC errors, malformed accounts and wrong bindings
must never be displayed as zero. `ordinaryFeePayerAccount` distinguishes an
ordinary System wallet from arbitrary program-owned SOL accounts. This is not
a fee quote, an airdrop or a claim of signing capability. Do not combine these
balances with the legacy database balance.

The wallet signs user-authorized transactions. SPL Token owns wallet token balances and user-to-user transfers; the exchange program owns escrow-backed balances, reservations, positions, matching, order lifecycle, grants, resolution, and claims. A relayer/keeper may submit already authorized operations or permissionless cleanup, but cannot choose arbitrary fills or move another user's available feathers. SIWS proves control for an application account link; it does not authorize trading, transfers, or grant signing custody.

The database remains suitable for email accounts, profiles, comments, metadata, wallet-link challenges, and rebuildable chain projections. It must never create a spendable balance after a chain transaction, execute a parallel match, or settle a chain market independently. Existing source points requiring explicit routing in the main implementation are:

| Current surface | Required transition |
| --- | --- |
| `src/lib/auth.ts`: `grantWelcomeFeathers` and registration/verification callers | Keep legacy issuance isolated. A chain grant must be a replay-protected program instruction; linking a wallet cannot invoke both issuance paths. |
| `prisma/schema.prisma`: `User.balanceMilli`, `LedgerAccount`, `JournalEntry` | Legacy data or clearly labeled projection only for chain mode; never add these fields to onchain spendable funds. |
| `src/lib/order-exchange.ts`, `order-service.ts`, `market-service.ts` | Chain markets construct/read transactions and accounts; prohibit database reservation, matching, fill, and cancellation writes. |
| `MarketOrder`, `OrderReservation`, `OrderFill`, `Position` | Namespace chain projections by deployment and market address; preserve integer values and chain versions. |
| `src/lib/settlement-service.ts` and settlement workers | Chain branch may submit authorized resolution/cleanup/claim transactions and index their results. It cannot post database payout journals or decide an onchain outcome from a DB role. |
| Trading ticket, portfolio, history, leaderboard | Read one economy at a time. Show wallet, chain, available/reserved units, provisional status, and last synchronized slot; never aggregate legacy feathers into chain buying power. |

These are inspected migration targets, not claims that the transition has already been implemented.

## Wallet discovery and package boundary

Use Wallet Standard discovery/events and capability checks rather than a single injected provider name. Require a selected account with the target chain and the necessary signing feature, and react to account/disconnect events. Connection alone does not prove ownership. The [Wallet Standard repository](https://github.com/wallet-standard/wallet-standard) and [Solana extension repository](https://github.com/anza-xyz/wallet-standard) define this boundary.

Main has selected and installed `@solana/kit@8.3.0`, `@solana-program/token@0.16.1`, and `@solana-program/system@0.14.1`. The actual RPC transfer tests target this combination. `buildFeatherTransfer` returns an idempotent recipient ATA creation plus three-decimal checked transfer instruction. Its mint must come from the validated deployment configuration. The table below records researched Wallet Standard choices and the alternative Anchor client family; the Anchor/web3.js packages are **not required additions** to the selected Kit client.

Publisher metadata confirms both [Token 0.16.1](https://registry.npmjs.org/@solana-program%2ftoken/0.16.1) and [System 0.14.1](https://registry.npmjs.org/@solana-program%2fsystem/0.14.1) declare Kit `^8.0.0` peer compatibility; [Kit 8.3.0](https://registry.npmjs.org/@solana%2fkit/8.3.0) requires Node >=20.18.0. These exact installed clients successfully executed the local RPC test described in the verification plan.

Exact researched pins, verified through publisher npm metadata on the research date:

| Package | Pin | Integration constraint |
| --- | --- | --- |
| `@wallet-standard/app` | `1.1.1` | Discovery; [metadata](https://registry.npmjs.org/@wallet-standard%2fapp/1.1.1) requires Node >=22. |
| `@wallet-standard/base` | `1.1.1` | Wallet/account types; [metadata](https://registry.npmjs.org/@wallet-standard%2fbase/1.1.1) also requires Node >=22. |
| `@solana/wallet-standard-features` | `1.5.0` | [Feature declarations](https://github.com/anza-xyz/wallet-standard/blob/master/packages/core/features/src/signIn.ts); negotiate supported feature versions. |
| `@solana/wallet-standard-util` | `1.1.4` | Server SIWS verification; [published implementation](https://unpkg.com/@solana/wallet-standard-util@1.1.4/lib/esm/signIn.js) inspected, not only a README. |
| `@anchor-lang/core` | `1.2.0` | Match Rust/CLI pins; use generated program IDL and web3.js v1 types. |
| `@solana/web3.js` | `1.98.4` | Compatible API family for Anchor; exact [package metadata](https://registry.npmjs.org/@solana%2fweb3.js/1.98.4). |
| `@solana/spl-token`, alternative web3.js client only | `0.4.14` | Its web3.js peer range includes 1.98.4. The selected Kit implementation uses `@solana-program/token@0.16.1` instead. |

The repository now installs `@wallet-standard/app`, `@wallet-standard/base`, and `@wallet-standard/features` at 1.1.1, plus `@solana/wallet-standard-features` at 1.5.0. Publisher registry metadata was rechecked before installation. Node minimum is now 22.14.0, matching existing CI; the development shell is 24.13.0. Direct versions and the lockfile are pinned. Both Prisma clients were regenerated after installation, typecheck passed, and localhost/readiness recovered successfully. Browser/server bundle and actual wallet-extension checks remain pending. No React wallet adapter was added solely for discovery; the browser boundary uses Wallet Standard directly.

[Anchor's client documentation](https://www.anchor-lang.com/docs/clients/typescript) explicitly limits the client to web3.js v1. Keep bytes/address conversion at a small boundary if another feature uses Solana Kit. Do not combine versioned transaction classes from unrelated API generations. Wallet Standard transaction methods operate on serialized bytes; check the account's supported transaction versions before building v0 messages or address lookup tables. Prefer a small, fully decoded transaction for initial integration.

## Deployment and chain binding

Define a trusted deployment manifest containing allowed app origin, Wallet Standard chain identifier, RPC allowlist, expected genesis hash, program ID, exchange configuration PDA, deployment instance/epoch, ABI version/hash, and optional feather mint/token-program/decimals. Fetch and compare genesis with [getGenesisHash](https://solana.com/docs/rpc/http/getgenesishash); do not infer the cluster solely from an endpoint URL or wallet label. Recheck on endpoint change and before signing after a reconnect.

Use `solana:devnet` or `solana:localnet` for Wallet Standard operations; these are defined in the [Solana chains source](https://github.com/anza-xyz/wallet-standard/blob/master/packages/core/chains/src/index.ts). Treat SIWS `chainId` as a separately explicit signed field: use the selected identifier consistently and test it with supported wallets. Do not assume every wallet accepts all freeform/local identifiers. An unsupported localnet capability disables that wallet's localnet trading; never silently switch to mainnet or omit chain binding.

Bind both SIWS resources and transaction intent to the actual genesis hash plus program/configuration identity and a deployment instance. A reset can reuse the same program address or even an intentionally reused genesis; the deployment instance invalidates old challenges and caches. A normal same-ledger restart preserves the instance. The program validates the configured deployment domain/instance and replay nonce in instructions. Programs do not receive a trustworthy RPC URL or a generic genesis-hash sysvar: genesis verification is an application check, while the program checks its own domain configuration. The application must allowlist only approved localnet/devnet deployments. This is not a claim that anyone is technically prevented from deploying a copy of the code elsewhere.

## SIWS link protocol

Prefer `solana:signIn` when supported. Use the maintained SIWS input/output types and `verifySignIn` rather than an ad hoc signed address string. [The SIWS proposal](https://github.com/phantom/sign-in-with-solana) explains the structured message, and [the verifier source](https://github.com/anza-xyz/wallet-standard/blob/master/packages/core/util/src/signIn.ts) shows field comparison and signature checking. The following are additional application requirements, not guarantees supplied by the verifier.

1. Require an authenticated Goosey session and fresh reauthentication for linking/replacing an existing account wallet. Validate CSRF and the exact allowlisted request origin. Create a challenge server-side tied to that session, user, requested public key, purpose `link-wallet`, and deployment domain. Reject linking a wallet already assigned to another user under the chosen uniqueness policy; no automatic account merge.
2. Generate at least 128 bits of cryptographically random nonce (e.g. 32 hex characters, satisfying the SIWS alphanumeric requirement), an opaque request ID, server `issuedAt`, and a short expiry (recommended five minutes). Store the full canonical expected input with a nonce hash and `consumedAt = null`. Rate-limit issuance and verification. Never accept a client-supplied expected input as the verification authority.
3. Populate domain from configured hostname **including port**, URI from the configured full origin/link route, version `1`, exact intended wallet address, chain ID, nonce, issued/expiry times, purpose statement, request ID, and resources identifying genesis/program/configuration/deployment. The statement must say this links a wallet and authorizes no transaction. Reject untrusted Host/Forwarded headers; use explicit localhost origins in development and HTTPS for hosted deployment.
4. Ask the selected wallet to sign that challenge on an explicit user gesture. The output may report a different account; reject it for this link attempt and start a fresh challenge for a deliberate account change. Do not silently link the returned alternative account.
5. Server parses bounded input, reconstructs `Uint8Array` values, requires a 32-byte public key and 64-byte Ed25519 signature, rejects unsupported signature/message formats, and verifies `base58(publicKey) == output.account.address == expected.address == parsed signed address`. Call `verifySignIn(storedInput, output)`. A successful signature over an address string is not enough unless the signed address equals the verifying public key.
6. Independently enforce server current time against expiry/not-before/issued-at policy, session ownership, challenge purpose, current deployment, exact domain/URI/resources/chain, and unused nonce. The published verifier compares the timestamp strings; it does not implement an application clock, nonce store, session ownership, or link uniqueness.
7. In one database transaction, conditionally consume the still-valid unused challenge and insert/update the wallet link under a unique key. Only one concurrent verification wins. On conflict, roll back the entire link mutation. Rotate the relevant authenticated session after privilege/link changes. Store an audit record without private keys; a consumed challenge is never reusable after unlink/relink.

The current feature types expose optional offchain message formats, but the inspected util 1.1.4 SIWS parser handles the text message format. Initially do not request `useOffchainMessage`; reject unknown returned formats. Support another format only after its exact verification implementation and wallet interoperability are tested. If the wallet only supports `solana:signMessage`, use `createSignInMessage` with the same complete stored input, verify the exact returned message/signature, and apply the same checks. This fallback is explicit capability handling, never an empty transaction or a transfer to prove ownership.

Keep link identity separate from chain authority. A valid cookie or linked address cannot sign a program instruction. Unlinking affects the application association; it does not transfer positions, cancel orders, or revoke previously signed transactions. Account switches invalidate unsigned drafts and pending link challenges; previously broadcast transactions remain tracked under their original wallet.

Current challenge requests require `{ walletAddress, password }`. The server
reverifies the current password, checks its hash again transactionally, and marks
the short-lived challenge `LINK_WALLET_REAUTH_V1`. Verification atomically consumes
that original-session challenge, inserts the wallet link and rotates/revokes the
session. The new token is cookie-only; the consumed nonce tombstone remains.
Legacy challenges cannot satisfy this purpose. A lost success response requires
sign-in and reading the existing link, not replaying the old challenge.

The explicit-env `test:chain:wallet-api` runner passed with real Ed25519 signatures,
cookie authentication, password reauthentication, replacement-cookie checks and
temporary SQLite against the retained validator at finalized slot 484. It verified
conflict rollback, stale-session rejection and unchanged database economics. This
is direct route-handler integration, not a browser signing or HTTP end-to-end proof.

### Existing SQLite database upgrade

Fresh databases receive the wallet-link tables from the Prisma schema. An existing SQLite database must receive the additive `prisma/sqlite-upgrades/20260919210000_solana_wallet_links.sql` upgrade before wallet-link routes are enabled. Do not run `prisma db push` against a participant database as a substitute for this reviewed upgrade.

The reviewed `npm run db:upgrade:solana:sqlite -- --source /absolute/app.db
--backup /absolute/new-backup.db` runner handles all three Solana migrations
(wallet links, event journal and ingestion visits). It requires existing WAL mode,
creates a verified private backup, rejects partial/drifted schema, and rechecks
the entire schema under one bounded immediate transaction before applying pending
DDL. Readers remain available; writers may briefly encounter busy errors. It
performs no financial DML. The backup precedes concurrent writes and must never be
automatically restored over the live database. Twelve real SQLite tests cover
rollback, schema mismatch, contention and an existing writer connection.

The local development database received these three upgrades on 2026-09-19.
Backup: `/Users/aryan/.local/share/goosey-db-upgrade-7wATB3/before-solana.sqlite`,
SHA-256 `1e2a2b739a08d13d7ec3246f70d61d1ba663451639408c367ca1f60bffcce176`.
Post-upgrade integrity/FK checks passed; bidirectional comparisons of user
balances and every ledger-account row against that backup showed no changes.
This is not a PostgreSQL deployment migration.

For the manual alternative below, stop web/worker writers first; the runner's
schema race checks do not apply to arbitrary manual commands.

Create a verified online snapshot at a new absolute path before changing the database:

```sh
npm run db:backup:sqlite -- \
  --source /absolute/path/to/goosey.db \
  --output /absolute/path/to/goosey-before-wallet-links.db
```

Then apply the checked-in file as one immediate transaction. The command below enables foreign-key checking, aborts on the first error, ignores user SQLite initialization files, and verifies both referential integrity and file integrity afterward:

```sh
sqlite3 -batch -bail -init /dev/null /absolute/path/to/goosey.db <<'SQL'
PRAGMA foreign_keys = ON;
BEGIN IMMEDIATE;
.read prisma/sqlite-upgrades/20260919210000_solana_wallet_links.sql
COMMIT;
PRAGMA foreign_key_check;
PRAGMA integrity_check;
SQL
```

`PRAGMA foreign_key_check` must print no rows and `PRAGMA integrity_check` must print exactly `ok`. The upgrade deliberately fails if it is applied twice; record its application in the deployment change log rather than rerunning it. Regenerate both Prisma clients with `npm run db:generate`, then start the application with the same database. PostgreSQL deployments use `npm run db:migrate:deploy:postgres`, which applies the corresponding timestamped migration through Prisma's migration ledger.

## Transaction intent and wallet failures

Create an immutable semantic intent before asking for a signature: operation, wallet, deployment domain, market, outcome, side, limit, quantity, time-in-force, post-only, expiry, expected order version, fee schedule version, deadline, and unique command ID. Hash a canonical integer encoding. Derive its receipt/nonce scope onchain from the wallet and deployment; include market/operation in the payload. An HTTP idempotency key alone is insufficient.

The client must decode and validate any server-built transaction against that intent: exact allowed program IDs, account ownership/addresses, signer, fee payer, mint/destination if applicable, compute/priority fee cap, and no extra transfers/approvals. A sponsor may pay SOL fees but must not become the authority for the user's feather account. Simulation can preview failures; it is not an execution guarantee. Request the supported Wallet Standard signing method with the selected account and chain. Revalidate the draft if either changes while the wallet prompt is open.

| State/event | Required application behavior |
| --- | --- |
| No wallet, locked wallet, missing signing capability | Explain the supported action; preserve the draft; do not create a DB order or grant. |
| User rejects signature before broadcast | Mark that signing attempt rejected; no reservation, fill, payout, or successful activity entry. Retain the draft for an explicit fresh attempt. |
| Signed, not yet sent | Preserve signed bytes/signature and blockhash context. If a signing method may have sent the transaction before erroring, treat it as uncertain instead. |
| RPC timeout/429/503, wallet sign-and-send transport error | Mark `unknown/pending`, not failed. Check signature when known and program receipt by semantic ID, including after browser reload. Do not create a fresh economic command automatically. |
| Submitted or processed | Show pending/provisional status; no offchain credit. Fetch chain state at an appropriate commitment. |
| Confirmed | Display confirmation with its slot; retain tracking until finalized. Derived UI values remain labeled with commitment. |
| Finalized success | Project chain receipt/account state once; dispatch idempotent notifications keyed by deployment and event identity. |
| Onchain failure (`meta.err` non-null) | Explain the program error and no economic changes; SOL transaction fees may have been charged. Do not index logs as committed fills. |
| Blockhash expired with no established result | Reconcile receipt and signature history. A renewed signature uses the same semantic ID and payload; the program prevents duplicate effects even if an earlier attempt is later discovered. |
| Definitive FOK/post-only rejection | Complete this attempt without an accepted order. A deliberate retry against changed liquidity uses a fresh command ID, preserving the existing UX contract. |
| Cancel requested | Keep the order live until chain cancellation/fill is established. A fill can win the race. Render the actual remainder and receipt, not optimistic zero ownership. |

Wallet Standard `signAndSendTransaction` may not expose signed bytes if it errors after transmission. That makes durable onchain semantic receipt lookup particularly important. Prefer `signTransaction` plus application broadcast where the wallet supports it and the product needs pre-broadcast signature persistence; support sign-and-send-only wallets with the same uncertainty semantics. Durable nonce transactions are outside the initial recent-blockhash flow and need a separate expiry/replay design if introduced.

Retries use identical signed bytes while valid. Save all signatures associated with the same command, and never change its body under the same ID. Retain onchain consumed-nonce/tombstone protection after order closure. Rebuilding with a recent blockhash and forgetting that the command already executed is not idempotency. Solana's [sendTransaction contract](https://solana.com/docs/rpc/http/sendtransaction), [confirmation guide](https://solana.com/developers/cookbook/transactions/confirmation), and [signature-history RPC](https://solana.com/docs/rpc/http/getsignaturestatuses) define the relevant transport limits.

**Direct SPL transfer exception:** `buildFeatherTransfer` currently creates only ATA and Token instructions; classic `TransferChecked` has no Goosey command receipt or semantic nonce. The same-signed-bytes replay test proves transaction-signature deduplication only. A rebuilt/re-signed transfer can deliver again even if a DB intent ID or memo is unchanged. For an ambiguous direct transfer, track the original signature/history and do not automatically rebuild/re-sign. If the RPC cannot establish its result, retain an unknown state and require reconciliation before proposing a new transfer. Durable exactly-once semantics across fresh signatures require an actual onchain transfer wrapper/receipt mechanism; the exchange receipt policy in the preceding table cannot be attributed to this helper.

## One accounting authority per market

The required representation is a wallet-visible SPL mint with three decimals, authorized capped free issuance, and program-controlled escrow. UI distinguishes wallet feathers, available exchange feathers, reserved exchange feathers, collateral, and local/devnet SOL for fees/rent. Include send and escrow deposit/withdraw controls; there is no purchase or cash-out. Escrow withdrawal returns the same nonredeemable play currency, not money.

External wallet token balances become exchange credit only through an atomic deposit transfer into the program-controlled vault. A deposit increments the internal onchain available balance by verified received units; a withdrawal decrements it and transfers tokens out in the same transaction. The DB indexes these facts. Token units in an external wallet and their later vault-backed internal units must not be counted together. Never mint an additional wallet token merely because an internal fill or claim credited a balance. [Solana token documentation](https://solana.com/docs/tokens) describes mint/account ownership and authority; the accounting policy here is Goosey's proposed design.

For a user-to-user send, derive both ATAs using the pinned mint and classic Token Program, create the recipient ATA idempotently, and execute `TransferChecked` with exactly three decimals. Parse decimal display amounts into bigint units without floating point. Authenticate the source owner through the actual transaction signature. Creating an ATA may require additional SOL rent even when the recipient has no SOL; the explicit payer sponsors that cost. Feathers cannot pay Solana network fees. Verify mint/program, source ownership, amount, destination, and fee/rent estimate in the review screen; a valid-looking recipient address alone is insufficient. Sending wallet tokens must never debit exchange escrow or database balances.

Free issuance still needs an onchain claim receipt, authorized mint authority, immutable grant cap/policy, and concurrency/replay protection. Transferring all tokens away, closing an empty ATA, unlinking/relinking, or receiving tokens back cannot reset eligibility. Wallet-based limits alone cannot prevent Sybil identities; do not describe them as one grant per human. SPL Token rejects unauthorized mint authorities, but application grant caps require separate exchange/grant-program tests.

The operator-only `prepareEnrollment` helper now builds the unsigned authorization
from explicit issuer, wallet, identity digest, allowance and expiry inputs. It
reads configuration, mint, both association PDAs and Clock in one finalized batch;
rejects existing wallet/identity associations; checks lifetime authorized allowance
against campaign/per-wallet caps; and requires expiry after that chain Clock.
Burning feathers cannot replenish enrollment allowance. The configured issuer is
the sole signer and fee payer. Preparation neither establishes human eligibility
nor signs, sends, funds SOL, claims tokens or changes database balances. Its 55
mocked tests prove preparation validation, not actual execution of this helper.
Runtime proof and the explicit enrollment operator are separate integration gates.

### Read-only chain market API

`GET /api/solana/markets/{marketId}?wallet={address}` reads a complete finalized
market/book/resolution/terms/escrow snapshot on the server-pinned deployment.
Market IDs are canonical decimal u64 strings, not database slugs. The selected
wallet is public chain data, not authenticated ownership. Requests cannot select
an RPC or override network/program identity. Missing or unverifiable accounts
return 503, never a database-market fallback. The route rate-limits reads, bounds
RPC time, rechecks genesis, and returns decimal-string quantities with no-store.
Terms contain a digest commitment, not proof that manifest contents are available
or understood; `manifestVerified` and `exchangeVerified` remain false.

Twenty-two route tests cover malformed inputs, u64 precision, throttling, network
change, incomplete snapshots and sanitized failures. Actual local HTTP checks
confirmed invalid-ID 400 and absent-chain-market 503. Successful market snapshot
runtime behavior is covered by the underlying exchange reader suite, but a
successful HTTP market response still requires a published market on that network.

Append `&format=terms` to retrieve exact canonical UTF-8 manifest bytes. The server
uses `GOOSEY_SOLANA_TERMS_DIRECTORY` (an existing private directory) and verifies
retained bytes against digest, length, deployment, market identity, economics and
reviewer addresses from that same finalized account batch. No arbitrary file path
or source URL is accepted. Missing/corrupt retention returns `TERMS_UNAVAILABLE`,
not reconstructed text. `X-Goosey-Terms-Digest` uses the codec's domain-separated
hash (not raw SHA-256); clients must independently use `verifyMarketTerms` before
signing. Headers also state the observed slot and whether terms were sealed.

`retainMarketTerms` validates before exclusive staging, fsyncs bytes, publishes
with an atomic no-overwrite link, and fsyncs the directory. Identical concurrent
writes are idempotent; changed rules for the same market/deployment conflict.
The private filesystem and ancestors remain operator-trusted. Every read verifies
content again; this is not replication or a guarantee against disk loss. Twenty-
three filesystem tests plus 28 route tests cover retention and delivery boundaries.

The isolated compiled-program terms suite also retained/retrieved its actual
manifest against the finalized sealed commitment at slot 70, preserving all 72
transaction cases. Exact bytes/digest and idempotent replay passed; altered rules
and a self-consistent conflicting digest were rejected without replacing the
retained file. Evidence: `/tmp/goosey-solana-runner-BVsl8s/program-e2e.log`, genesis
`EamEdnmL7coXj5XEqsSPXhTYqtL6BDUGr5DnbVCdiVfL`, artifact
`d2f3e57d090ab54369068a450c9f2d2f9b4bf6e629a06eb826672d824c770a82`.
This proves store integration with real finalized commitments, not successful
HTTP delivery from a published market on the shared development deployment.

Market YES/NO positions should likewise have one representation. If positions are program-owned quantities, no second independently spendable outcome-token balance exists. If outcome tokens are later adopted, escrow/reserve or burn/mint them atomically and reconcile their supply against positions and collateral. Supporting arbitrary transfer-fee/hook extensions is not part of the initial contract.

Transition the application in this order:

1. Identify each market's immutable execution backend and deployment namespace. Keep existing LMSR/database markets in the legacy economy. Create fresh chain markets and fresh, separately identified grants. No user balance snapshot is automatically spendable onchain.
2. Before enabling a chain market's mutations, route every write surface by backend: public APIs, admin actions, settlement worker, expiry keeper, market maker, signup/verification grants, and scripts. Chain routes must fail closed if chain configuration is missing; no fallback to database cash on RPC failure.
3. Attach read projections to `(genesis, deployment instance, program, config, market, wallet)` identities. Store decimal integer strings/bigints and transaction/sequence metadata. Exclude chain projections from legacy reconciliation totals; do not post offsetting DB money journals to make the two economies appear balanced.
4. Switch ticket, portfolio, orders, activity, and leaderboard to the same selected economy. Available balance excludes reservations; total owned balance is not buying power. A chain grant pending confirmation cannot be spent based on an optimistic DB value.
5. Demonstrate create/grant/place/partial-fill/amend/cancel/expire/resolve/claim entirely through signed program instructions with DB economic mutation disabled. Stop/rebuild the indexer and obtain the same balances and orders from chain accounts. A second independent client must observe and enforce the same book.
6. Archive the legacy economy as a separate product choice when desired. Moving live DB orders/positions would require a dedicated, explicitly authorized snapshot/migration protocol with frozen writes and one-time claims; it is not implicit in wallet linking or this fresh-chain rollout.

When the chain/indexer is unavailable, show the last observed state and its freshness, and disable actions that cannot be constructed/verified safely. Never compensate an uncertain transaction by locally releasing a reservation or adding feathers. Recovery follows the chain command receipt and account state.

## Required integration tests

Use real cryptographic signatures for auth tests and real compiled-program transactions for economic journeys. A controllable test wallet may exercise rejection/timeout states, but it must use actual local keypairs and cannot invent fills. Add a supported real-wallet manual/devnet pass with recorded wallet versions; do not claim broad wallet compatibility from a test adapter alone.

- SIWS success; altered nonce/domain/URI/chain/resources/purpose/address; valid signature by a different key; expired and not-yet-valid input; malformed/oversized bytes; unsupported signature/message format; replay in another session/user/deployment; parallel verification; link uniqueness conflict; relink after consumption; CSRF and untrusted proxy host handling.
- Wallet account switch while signing, disconnection/reconnect, unsupported localnet, legacy/v0 capability mismatch, hardware message-signing refusal, user reject, insufficient SOL, simulation failure, chain failure, and sign-and-send error after actual chain acceptance.
- RPC response dropped after commitment; same bytes resent; rebuilt transaction with same semantic ID; receipt found after browser/server restart; wrong-payload replay rejected; old command after receipt/order close rejected; stale indexer and duplicate logs do not change totals.
- All four economic fill kinds plus partial/FOK/IOC/post-only, cancel/fill race, expiry, and resolution/claim. Assert the visible status matches authoritative account state and every rejected transaction preserves feather accounting.
- Registration/link/grant cannot credit both economies; repeat wallet links, transfers away, and closed/recreated ATAs cannot bypass the onchain grant receipt; SPL deposit/withdrawal cannot count wallet tokens and vault credit twice; settlement cannot run in both the legacy worker and program.
- Actual SPL sends create/reuse recipient ATAs, conserve supply, and reject wrong mint/decimals, unauthorized/missing/corrupt signatures, insufficient feathers, and insufficient local/devnet SOL. Failure rolls back token/account changes, while included failed transactions may still cost SOL. Exact signed transaction replay delivers only once.
- Wrong genesis, program ID, mint, IDL/config version, or reset deployment instance blocks signing. A normal validator restart preserves the valid namespace; a fresh ledger cannot inherit the previous deployment's optimistic balances.
- Visually inspect desktop and mobile wallet selection, chain indicator, signature-pending/unknown/rejected states, order results, and portfolio freshness. Close test browser tabs when finished. Record real screenshots from those journeys; do not substitute fabricated liquidity or balance data.

The main integration is complete only when these tests and the companion compiled-program gates produce recorded results. Package publication, an IDL, wallet connection, or a passing arithmetic test alone is not a functioning onchain exchange.
