# Canonical market terms v1

The codec, client builders/decoder and Rust initialize/accept/seal handlers are
implemented. The program now requires canonical sealed terms before new resolution
activation and order placement, with 42 passing crate tests including nine terms
tests. Activation binds both frozen reviewer identities to the accepted terms;
placement rechecks that binding and prohibits either designated reviewer from
trading. Existing Market/Seats layouts are unchanged. PlaceOrder appends terms as
account nine; initialize_resolution appends terms after System as account ten.
No fixture in the unit tests is a live market or source-availability claim.
The integrated program built successfully for SBPFv3 with SHA-256
`d2f3e57d090ab54369068a450c9f2d2f9b4bf6e629a06eb826672d824c770a82`.
This is compilation evidence, not validator execution or a web-backend cutover.

Mandatory-admission runtime regression subsequently passed **153 exchange cases**
(`/tmp/goosey-solana-runner-vNhlyf/`, genesis
`8rQMw3NndpLMCdnkCjDsypkV1NCcLSNKJ2efAKjmyMEq`) and **112 cancellation cases**
(`/tmp/goosey-solana-runner-jW2eCg/`, genesis
`H2Ww2FpTWFi1RRCuSfrGgzGmXGbS26S2forXGBevUYtm`) against that exact artifact.
These executed actual initialization, both signatures, sealing, missing/unsealed/
foreign terms rejection, frozen-role mismatch, digest mismatch, and rejection of
both reviewers' orders using their real registered seats. The exchange suite's
18 finalized snapshots now include terms in the same ten-account batch; the
shipping prepared order finalized at slot 355. Cancellation retained all 94
prior cases plus eight terms setup transactions and ten admission cases.
Canonical manifests are clearly labeled local test specifications, not live
Hack the North market content. These checks do not prove browser display,
independent content availability, legacy migration, or web financial cutover.

The resolution regression also passed **147 actual transaction cases** on this
same artifact (`/tmp/goosey-solana-runner-ADao7p/`, genesis
`8N4LAmwmtdVrxMac4WW6Y7AqadJ3q76S6fBfa2CnuUCR`). All 127 earlier YES/NO/VOID,
prepared claim, and deposit/withdrawal cases remain, plus 20 terms setup and
admission cases. Each reviewer verifies retained canonical test-manifest bytes
against the actual commitment before signing; missing, unsealed, and foreign
market terms fail activation. This does not add a new browser-flow proof.

The dedicated `npm run test:chain:terms` suite independently passed **72 actual
transaction cases** with the same binary after loader/authority preconditions
were strengthened (`/tmp/goosey-solana-runner-JqUQVH/`, genesis
`3trMSeL2awhkWCaEDhsDfkQjAM4Y6zLJRL6ifoBfyp22`). It verifies exact commitment
bytes, separate reviewer signatures, one-way sealing, rejected reinitialization,
post-close rejection, reviewer trading exclusion and ordinary-user admission.
A finalized ten-account read observes matching market/book/resolution/terms.
This disposable isolated ledger is not the shared development deployment.

The TypeScript implementation also includes unsigned initialize/accept/seal
builders and a strict 240-byte account decoder. `readGooseyEscrow` can request
`includeMarketTerms: true`, forcing a single finalized ten-account batch with
the book and resolution. It validates the commitment against that batch's market
and frozen reviewer identities; a missing or malformed requested commitment
fails, without a legacy fallback. It reports unsealed commitments as unsealed.
This does not fetch or verify the manifest content, nor prove that the deployed
program requires a commitment before trading. `prepareOrder` now requires the
ten-account read, sealed dual acceptance and matching reviewers. Other read-only
callers may explicitly request legacy snapshots; they cannot bypass program
admission by omitting terms from a transaction.

## Exact bytes

`encodeMarketTerms` validates unknown input and emits UTF-8 JSON without BOM,
whitespace or trailing newline. Key order is the declaration/construction order
in `market-terms.ts`: version, binding, question, rules, observation, sources,
sourcePolicy, economics, oracle. Nested order is likewise explicit in that file.
JSON escaping is ECMAScript `JSON.stringify`; source array order is significant.
Other-language implementations must reproduce those bytes, not arbitrary JSON.
`decodeMarketTerms` uses fatal UTF-8 decoding, validates fields, re-encodes, and
requires byte equality: duplicate keys, alternate escapes, reordering, numeric
spellings, whitespace and trailing bytes are rejected.

SHA-256 input is exactly `UTF8("goosey:market-terms:sha256:v1\0") || manifestBytes`.
The final domain byte is NUL. Output is 64 lowercase hex characters; a future
account stores the equivalent 32 raw bytes. This is not a hash of a locator.

All integer quantities/timestamps/IDs are canonical unsigned decimal strings
(`0` or a nonzero digit followed by digits), never JSON numbers. IDs fit u64;
timestamps are nonnegative i64 Unix seconds. Payout is 2..1,000,000 milli-feathers,
fee bps 0..10,000, decimals exactly 3. Observation start <= end <= resolution;
close <= resolution. V1 requires explicit UTC, avoiding platform-dependent IANA
timezone databases and ambiguous local timestamps. A different timezone model
requires a new schema version, not silent normalization.

Text must be nonempty NFC, valid Unicode, without leading/trailing whitespace,
CR, disallowed controls or directional/format controls; internal LF is allowed.
Limits are UTF-8 bytes: question 512, each YES/NO/VOID rule 2048, each policy 2048,
source ID 32, URI 512, source selection 1024; 1..8 unique ordered sources;
total encoded manifest <=24,576 bytes. Unknown fields and coercions are rejected.
The codec cannot judge whether prose is objective, exhaustive or truthful.

Source URIs are canonical HTTPS locators without credentials/fragments. An
optional `snapshotSha256` commits exact source snapshot bytes (ordinary SHA-256);
null means only the source-selection rule is committed, not future content.
Missing-source and revision policies are mandatory. A retriever must separately
verify snapshot bytes; this codec fetches nothing. Manifest bytes and evidence
need retained independently retrievable replicas; a hash alone gives no availability.

The manifest binds cluster, pinned genesis, program, config, market PDA, u64
market ID, creator and feather mint, plus economics and the two reviewer
wallet/enrollment pairs. `verifyMarketTerms` requires trusted expected digest,
binding, economics and reviewers, checks all equality and canonical identity PDAs.
Obtain expectations from a coherent finalized chain snapshot—not this same
untrusted document. No RPC, signature, eligibility, source truth or finality is
proved by a successful codec call.

## Terms account ABI and admission integration

Keep Market/Seats/vault layouts unchanged. Canonical PDA seeds:
`[b"market_terms", market_pubkey_bytes]` under the exchange program.
Anchor `MarketTerms` fixed layout (240 bytes including discriminator): version
u8, market pubkey, creator pubkey, digest [u8;32], manifest_len u32 LE,
proposer wallet/enrollment pubkeys, approver wallet/enrollment pubkeys,
acceptance_bits u8 (bit0 proposer, bit1 approver), sealed bool, bump u8.
The content commitment is immutable from creation; acceptance bits may only grow
before seal. No editor, reset, close/recreate or post-seal reviewer substitution.
Digest and length identify separately retained canonical bytes; this small account
does not claim to store or make the entire manifest available on-chain.

Implemented handlers (actual validator execution is still a verification gate):

- `initialize_market_terms(version:u8,digest:[u8;32],manifest_len:u32)`:
  accounts creator signer/writable, config readonly, market readonly, seats
  readonly, canonical book readonly, proposer enrollment readonly, approver
  enrollment readonly, terms writable/init, System readonly. Require pristine
  untraded market, ready book, distinct eligible noncreator reviewers and bounds.
- `accept_market_terms(expected_digest:[u8;32])`: reviewer signer, config,
  market, seats, reviewer enrollment readonly; terms writable. Verify role,
  historical nontrading status, exact digest and set only that role's bit.
- `seal_market_terms(expected_digest:[u8;32])`: creator signer, config,
  market, seats, book readonly; terms writable. Require both acceptance bits,
  pristine market, future close, exact binding. Never rewrite commitment.

Reviewers must retrieve and validate the manifest before signing acceptance;
on-chain signatures bind their consent to the commitment, not objective truth.
Canonical sealed terms are readonly in initialize_resolution and place_order,
with market and frozen reviewer equality enforced. The manifest commitment is
immutable for that market PDA. Existing proposal/review, payout, withdrawal and
cancellation instructions remain available to legacy markets; a missing terms
account must never be displayed as verified rules. Any future replacement-order
instruction must apply the same admission guard. Finalized readers batch terms
with market/book/resolution. Fetching and validating retained manifest bytes in
the UI before approval remains an integration gate. Re-measure message size/CU;
do not assume the manifest fits in one transaction.

No-fallback policy is explicit: designated proposer plus distinct approver,
wait if unavailable, no replacement and no automatic timeout VOID. Objective VOID
criteria remain separate from reviewer unavailability. Signed acceptance cannot
guarantee future liveness; prevent appointed reviewers trading themselves out of
eligibility. New governance/fallback semantics require a separately approved version.
Only pristine legacy markets may attach terms; do not retroactively certify traded
markets. Withdrawals and existing settlement must not be stranded by this migration.
