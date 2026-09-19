# Badge account access (0.10.0)

**Product direction:** participants must not need USB. The implemented flow below
is a development transport. See [wireless identity findings](WIRELESS-IDENTITY.md)
for the existing provisioned identity/token system, Lua API boundary, and the
organizer integration needed for cable-free automatic account access.

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

## QR pairing on the connected badge

The USB gateway now generates a small LVGL I1 QR image containing the existing
public SHA-256 pairing challenge, not a bearer token. The app opens a clean
sign-in page on startup and displays the website account after a fresh account
response. The QR is 98×98 at the canonical production origin. The real badge
screen capture was independently decoded successfully after installation.

Install `qrcode==8.2` in the Python environment used to run the gateway. QR decode
QA also uses `zxing-cpp==2.3.0` and the existing Pillow dependency. The native
image is accompanied by a matching private `appdata/qr_challenge.txt` stamp;
sharing app files does not copy that stamp or activate the sender's pairing QR.
The installed firmware's `badge.fs.exists` returned false for an existing app
image, so the UI relies on the stamp written only after successful asset upload.

This QR build still needs the Mac gateway for internet access. QR scanning does
not add wireless transport to the participant badge. No password is stored on
or broadcast by the badge. Account activation remains a user action on the phone.

### Startup memory correction

The physical badge reported an `on_enter` allocator failure at 50,898 Lua bytes
with a 67,547-byte peak, despite a 98,304-byte quota. The system allocator, not
just the Lua quota, was exhausted. The client no longer embeds a second complete
market snapshot in its Lua source or parses stored market history during the
sign-in screen. History is loaded from the authoritative gateway mailbox when
needed, with a streaming row parser rather than a full duplicate token table.
No saved history, holdings or account data are reset.

The installed correction displayed the small QR and the saved Waterloo market
chart on the physical device. Observed free system memory was about 18 KB on
sign-in and 10 KB with the market screen loaded; this is not a guarantee for all
future catalog sizes. Account API access returned READY after the user's link.
The later repeated-start check was interrupted by a USB transfer left incomplete
when its host process was stopped. Console uploads now defer Ctrl-C until the
announced payload and final prompt complete. A badge restart is still needed to
clear the already-interrupted old transfer before further hardware checks.

### Reconnect and stale-link correction

Startup now treats cached account frames as unknown until the gateway sends a fresh
frame. Only a fresh explicit LINK state shows the pairing QR; connection loss or a
stale frame shows Reconnecting instead. Live credentials remain required for orders.
Public chart fetching runs in a worker so slow history requests cannot block account
heartbeats. Serial writes remain on the gateway thread.

Validated Lua account restart, OFFLINE, LINK expiry, restoration, pending-order
preservation and quote expiry; gateway tests pass. Installed on the connected badge
and observed Reconnecting with no Lua error. The prior saved credential returned
HTTP 401, so a fresh link was generated after preserving its local receipt journal.
Phone approval and authenticated trading still require end-to-end confirmation.

### Linked account and market-refresh stability

The physical badge restored the participant account and real balance successfully.
A later investigation captured a native reboot following Lua system-heap exhaustion
while rereading market_snapshot.txt. The app now reads a small generation marker
before opening an unchanged market file. Both USB publishers write that marker
only after the complete frame. Snapshot validation is incremental (one market per
tick), releases the previous in-memory catalog before reading its replacement, and remains
bounded. The UI briefly shows Loading markets during replacement; the database
and on-device snapshot file remain intact, and account/trade state is separate. The exporter requests at most 32 history points across all markets to
leave headroom for both old and new snapshots; all points still come from the
repository database. This reduces chart detail, not market coverage.
