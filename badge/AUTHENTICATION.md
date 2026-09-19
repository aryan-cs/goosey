# Badge account access (0.10.0)

The user now permits one-time sign-in as an alternative to automatic Socials
email authentication. Stock Lua does not expose Socials email or an organizer
identity proof. A mutable contact email or badge ID is not a login credential.

## Implemented USB flow

1. Install the whole cloud bundle (`main.lua`, `cloud_reader.lua`, `trade.lua`,
   `manifest.cfg`, and the existing repository `icon.bin`) under `goosey_base`.
2. Open Goosey. It writes its public provisioned badge ID to private appdata.
3. Run `python3 badge/scripts/usb_trading_gateway.py --port <USB port>`.
4. Open the printed website link. Sign in or create an account normally, compare
   the eight-character code with the badge, and click **Link this badge**.
5. Within ten seconds, the badge displays the website username and balance.
   Reopening needs no additional input while that gateway's access remains valid.
6. Choose a market/outcome, adjust quantity (up/down) or BUY/SELL (left/right),
   press A for a quote, then A to confirm or B to cancel.

The Mac must remain attached and the gateway must keep running. Sharing the app
transfers code/modules/icon, never personal appdata or the Mac's credential.
Each recipient needs their own link and USB gateway. This is not wireless,
zero-input Socials authentication, or a Solana wallet signer.

## Credentials and revocation

The Mac generates a 256-bit random bearer secret. It persists in an ignored,
mode-0600 JSON file under `output/badge-gateway`, bound to the public badge ID and
HTTPS origin. The website URL contains only SHA-256(secret), a public challenge.
After explicit approval using a valid same-origin website session, the server
stores that hash as an `AccountToken` with purpose `BADGE_DEVICE`, owner and
seven-day expiration. It cannot serve as a website session or password-reset
credential. The shared Lua app never receives a bearer secret or email.

Only dedicated badge account, quote and trade routes accept this token. Active
participant status is required; account authorization is checked again inside
trading transactions. `/badge` lists active links and revokes them. Password
reset revokes all badge tokens. After expiration/revocation, rerun the gateway
with `--new-link` and approve a new code. That option refuses unresolved trades.
Never share the gateway state directory or commit it to the repository.

## Request safety

Lua uses bounded, complete private-file frames. It will not trade from a cached
account frame after reopening, or after 35 seconds without fresh account data.
Quotes are bounded to 25 seconds from the original request; reopening discards
unconfirmed quotes. No practice wallet is read, reset, migrated or debited.

A confirmed request is saved before waiting for the server. It blocks further
trades and survives app/gateway restarts. The gateway journals its immutable body
before sending it, and uses `badge:<quoteId>` as the server's idempotency key.
A lost response retries the same request, never a fresh quote or changed bound.
Only an authoritative receipt or definitive business rejection clears it.
Authentication loss, transport failure and server failures leave it pending.
Check website trade history to resolve a pending order if access is revoked;
there is deliberately no automatic override that could hide an uncertain fill.

## Verification and limitations

`scripts/badge-e2e.ts` creates a disposable SQLite database and exercises the real
link/account/quote/trade/revoke APIs plus ledger reconciliation. Python/Lua tests
cover partial frames, account freshness, quote expiry, repeated button presses,
pending restart recovery and durable gateway retries. Never run test trades on
participant accounts in production without a specific authorized order.

The cloud client uses sandboxed require modules to reduce peak compiler memory.
This badge's firmware lacks `pcall` despite newer documentation listing it, so
our Lua does not depend on it. Hardware smoke tests do not establish maximum
catalog/history capacity, flash endurance or wireless compatibility.
