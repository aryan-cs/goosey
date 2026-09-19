# Canonical market terms v1

This is an implemented offline codec/hash contract, **not an installed on-chain
admission rule**. Rust, existing layouts and current clients are unchanged.
No fixture in the unit tests is a live market or source-availability claim.

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

## Proposed future on-chain ABI (not active)

Keep Market/Seats/vault layouts unchanged. Canonical PDA seeds:
`[b"market_terms", market_pubkey_bytes]` under the exchange program. Proposed
Anchor `MarketTerms` fixed layout (240 bytes including discriminator): version
u8, market pubkey, creator pubkey, digest [u8;32], manifest_len u32 LE,
proposer wallet/enrollment pubkeys, approver wallet/enrollment pubkeys,
acceptance_bits u8 (bit0 proposer, bit1 approver), sealed bool, bump u8.
The content commitment is immutable from creation; acceptance bits may only grow
before seal. No editor, reset, close/recreate or post-seal reviewer substitution.
Digest and length identify separately retained canonical bytes; this small account
does not claim to store or make the entire manifest available on-chain.

Proposed instructions:

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
Add canonical sealed terms readonly to initialize_resolution and all new-order
admission (including replacement) and result proposal/review contexts. Cross-check
the frozen reviewer identities and market. Bind proposal records/fingerprints to
the digest. Finalized readers must batch terms with market/book/resolution;
client preparation verifies retrieved bytes against that account before approval.
Re-measure message size/CU; do not assume the manifest fits in one transaction.

No-fallback policy is explicit: designated proposer plus distinct approver,
wait if unavailable, no replacement and no automatic timeout VOID. Objective VOID
criteria remain separate from reviewer unavailability. Signed acceptance cannot
guarantee future liveness; prevent appointed reviewers trading themselves out of
eligibility. New governance/fallback semantics require a separately approved version.
Only pristine legacy markets may attach terms; do not retroactively certify traded
markets. Withdrawals and existing settlement must not be stranded by this migration.
