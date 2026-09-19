# Chain catalog discovery

The server-rendered `/chain` page uses this same catalog read helper and is linked
from the Markets browse page. It distinguishes disabled, unavailable, empty and
invalid-cursor states, preserves exact integer feather precision, and links each
entry to its canonical chain market route. It does not calculate prices from SQL
defaults. Desktop dark and mobile light/dark disabled states were visually checked
at 1280px/390px with no console errors or horizontal overflow. Populated rendering
has an explicitly mocked fixture test, not a claim of a shared published market.

`GET /api/solana/catalog` is the dedicated metadata discovery endpoint. It is
disabled unless `GOOSEY_SOLANA_CATALOG_ENABLED=true`. The server's configured
localnet/devnet cluster, genesis hash and program select the namespace; request
parameters cannot override them. This read makes no chain transaction or RPC call.

Only SOLANA entries with OPEN visibility, null SQL collateral, disabled SQL
order acceptance and an exact deployment binding are returned. Each chain market
ID must be canonical u64, and each market address is independently re-derived
from the program and ID. DRAFT entries and other deployments are excluded.

The response is `{items, nextCursor, hasMore}`. Each item contains editorial and
committed market metadata, a canonical `/chain/markets/<u64>` link and a `chain`
identity object. There are no SQL price, probability, volume, balance, position
or order fields. OPEN means discoverable, not currently tradeable: clients must
read the finalized market account and verify the exact terms before signing.

Optional `limit` is 1–50 (default 25). Optional `cursor` is the exact opaque cursor
from a previous response. Pagination uses descending creation time and ID;
same-time rows remain addressable without offset pagination. Unknown/duplicate
parameters and malformed cursors are rejected. Responses are always no-store,
including errors, and reads are limited to 60 per request identity per minute.

Verification includes mocked-boundary query/route tests and actual disposable
SQLite tests of draft exclusion, publication visibility, deployment isolation,
absence of financial defaults, same-time pagination, and unchanged financial
tables. SQLite tests mock chain verification explicitly; the separate publication
runtime suite proves actual chain-to-catalog registration without those mocks.
