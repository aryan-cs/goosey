# First closing-ceremony dance

The event `htn-2026-winner-first-dance` groups four binary markets: Worm, Dab,
Floss, and None of these. Only the first qualifying dance by a confirmed overall
winning team member counts. One option wins and three lose when evidence is
complete. If no qualifying dance occurs, None of these wins. Unresolvable timing
ties, missing evidence, or cancellation void the whole group.

The authoritative editorial definitions are in `src/lib/dance-market.ts`. They
preserve the original close and resolution schedule. The existing binary pricing
engine supplies each child's price independently. These prices need not sum to
100%; never normalize them in presentation or represent them as a shared
multivariate automated market maker.

## Publishing

Configure the normal PostgreSQL runtime environment privately, then preview with
an existing active administrator's username:

```sh
node --import tsx scripts/publish-dance-markets.ts --username <existing-admin>
```

Alternatively use `--system-operator` to provision or reuse the dedicated
non-interactive market publisher; its randomly generated login secret is
discarded. No participant account is promoted. Add `--apply` to publish.
It validates existing event and child contracts, creates missing records through
the normal audited event and market services, and uses stable idempotency keys.
Rerun with the same operator after an interrupted publication. It does not
alter existing contract terms or move positions between markets. Publication
after the close is rejected if any child is missing.

The old `htn-2026-winner-stage-dance` contract asks whether **any** qualifying
dance occurs. It is a different contract. If it has trading or settlement
activity, retain it unchanged and settle its positions under its original rules.
The publisher pauses only an untouched, open LMSR original using an optimistic
version check. A concurrent trade changes that version and aborts the pause.
Even when paused, its ID, contract, collateral, and ledger history remain intact.
Never repurpose its ID for one of the new options or automatically void traded
positions merely because the interface now groups the replacement options.

Fresh local seeds consume `prisma/htn-2026-markets.ts`: five other ceremony
questions plus these four children, divided into the main ceremony event and
the first-dance event. Existing seeded markets retain their contract terms.
`scripts/launch-selected-markets.ts` remains the historical six-market publisher;
use the new first-dance publisher for this group. Do not run the SQLite-only
legacy replacement script against the live database.

## Resolution

Use one shared evidence review and one group outcome. That maps the winning
child to YES and all other children to NO, or all four to VOID. The ordinary
two-person proposal approval and settlement accounting still apply. Publishing
creates no outcome and performs no settlement; the group resolution guard must
remain enabled so contradictory individual resolutions cannot be approved.

Resolve the winning option YES first, then the remaining three NO, using distinct
creator, proposer, and approver accounts. For cancellation or ambiguous evidence,
propose VOID for all four instead. Proposal and approval both serialize on the
event row and inspect sibling pending/final decisions, rejecting multiple YES,
all-NO, mixed VOID/decided results, or an incomplete group. Approval and payouts
remain per-option operations; this is not an atomic group settlement.

The grouped trading page is `/events/htn-2026-winner-first-dance`. Named option
buy/sell controls quote and execute that child's YES contract through the normal
API, with balance, holding, fee, version, and idempotency checks. Selling requires
existing holdings. Switching options discards the old quote. Each child retains
its own history and discussion page. The untouched paused original market links
to the group; `?legacy=1` retains access to the original contract.

## Verification

```sh
npx vitest run src/lib/dance-resolution.test.ts src/lib/dance-resolution-admin.test.ts
npx tsx scripts/dance-market-e2e.ts
```

The economic integration check creates and removes its own temporary SQLite
database. It executes real quotes, buys, sells, resolution approvals and payouts;
checks separate option holdings and a single winning payout; and reconciles all
journals and ledger accounts. It never connects to the configured live database.
