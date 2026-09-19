# Cable-free badge streaming architecture

Status: research-backed design and HTTPS recovery foundation, September 19, 2026.

## Decision

Goosey can support a badge that receives live probabilities and submits confirmed
trades without a USB connection. It cannot do so inside the badge's current Lua
runtime. The release needs either an organizer-supported native extension or a
native ESP-IDF application for the badge's ESP32-C3-MINI-1-N4.

The recommended production transport is:

1. A transactionally durable, globally sequenced market feed in Goosey's database.
2. MQTT over TLS and WebSockets on port 443 for immediate public market updates.
3. Authenticated HTTPS snapshots for boot, cursor recovery and broker outages.
4. The existing HTTPS quote and idempotent trade-confirmation endpoints for private
   account operations. Public market delivery must never authorize a trade.

The new `GET /api/badge/v1/markets/snapshot` route is the first recovery primitive.
It returns one bounded, coherent account/catalog replacement state, supports a
strong ETag and `If-None-Match`, rejects catalogs larger than the firmware limit,
and uses the existing revocable badge credential. It is a conditional polling
fallback, not a live stream.

## Confirmed platform boundary

The official [Hack the North custom firmware HAL](https://badge.hackthenorth.com/custom-firmware-hal.md)
identifies an ESP32-C3-MINI-1-N4 with 4 MB flash and documents ESP-IDF 5.5.3.
The official [Lua guide](https://badge.hackthenorth.com/ide/README.md) exposes a
restricted 44-byte `LUA1` broadcast channel. It does not expose Wi-Fi, HTTP, TLS,
credential signing or arbitrary BLE/GATT. Badge ID, name and MAC address are not
authentication credentials.

Physical testing of the current event firmware also found too little native heap
for a reliable Lua radio bridge: a minimal radio app reached about 2.9 KB free
after initialization and its first advertisement failed with
`BLE_ERR_MEM_CAPACITY`. Native Wi-Fi therefore is not a hidden Lua feature that
can be enabled with a different script.

This is a runtime limitation rather than a silicon limitation. Espressif's
[ESP32-C3 RAM baseline](https://docs.espressif.com/projects/esp-techpedia/en/latest/esp-friends/advanced-development/system/ram-usage.html)
reports roughly 210 KB free after Wi-Fi station plus one MQTTS connection with
default settings, and roughly 300 KB after its documented optimizations. That
proves the native stack fits a C3 in isolation; it does not prove fit alongside
this badge's display, input and application code.

Replacing the event firmware is technically possible, but it also replaces event
apps and features. No badge should be erased until the native build has a restore
image, complete hardware drivers, OTA rollback and a bench-tested provisioning
flow.

## Why MQTT plus HTTPS

MQTT matches an intermittently connected constrained client: ordered topic
delivery, persistent sessions, keepalive, reconnect and QoS retransmission are
implemented by [ESP-MQTT](https://docs.espressif.com/projects/esp-mqtt/en/latest/esp32/).
MQTT 5 sessions may persist across network connections, but Goosey must still
deduplicate messages and recover gaps because QoS 1 is at-least-once delivery
([MQTT 5 specification](https://docs.oasis-open.org/mqtt/mqtt/v5.0/mqtt-v5.0.html)).
WSS on port 443 is preferred at the venue because outbound 443 is commonly
available where native MQTTS on 8883 is filtered.

HTTPS remains the source of recovery truth. ESP-IDF's
[HTTP client](https://github.com/espressif/esp-idf/blob/master/docs/en/api-reference/protocols/esp_http_client.rst)
supports TLS, persistent connections and streamed response callbacks. Its
[TLS layer](https://github.com/espressif/esp-idf/blob/master/docs/en/api-reference/protocols/esp_tls.rst#client-session-tickets)
supports session tickets, which reduce reconnect work without replacing the
application cursor.

An indefinite SSE connection is useful for a browser or USB gateway, but it is a
poor sole device path. [RFC 6202](https://www.rfc-editor.org/rfc/rfc6202)
documents intermediary buffering and timeout problems, and
[Vercel function duration is finite](https://vercel.com/docs/functions/limitations).
If an MQTT broker is not ready, a 20–25 second bounded HTTPS long poll can carry
the same event contract temporarily.

## Evidence and its limits

The available empirical literature supports testing MQTT first, but none of the
papers substitutes for measurements on this badge:

- An ESP32-C6/S3 comparison reported lower latency for MQTT and CoAP than HTTP in
  its controlled non-TLS telemetry setup. Its devices, payloads and security mode
  differ from Goosey's: [Engineering Proceedings 2026, 150(1), 126](https://www.mdpi.com/2673-4591/150/1/126).
- A Lund University ESP32 study found TLS/DTLS handshakes costly and showed that
  batching reduces energy. It supports persistent sessions and measured reconnect
  policy, not disabling TLS: [Energy Consumption for Securing Lightweight IoT Protocols](https://www.lunduniversity.lu.se/publication/7fc36cb5-adc5-4e12-bdd3-d2f0ac3a14f7).
- A DAIS 2022 study found publish/subscribe substantially cheaper than synchronous
  request/response in its setup and HTTP more expensive than MQTT for pub/sub.
  Network, radio and workload differences mean the percentages are not badge
  forecasts: [Energy Consumption of Application-Layer Protocols](https://www.inf.telecom-sudparis.eu/dissem/greenit-paper-dais-2022/).
- A 2026 battery-powered ESP32-C3 experiment observed low tens-of-milliseconds
  MQTT and raw-WebSocket round trips over a dedicated access point, but used one
  node, no TLS, no energy measurement and no interference. It demonstrates basic
  C3 feasibility rather than venue readiness: [Yamin et al.](https://conference.ut.ac.id/index.php/saintek/article/download/8014/3054).
- A 2026 ESP32-WROOM experiment measured material TLS cost in RAM, current and
  latency. Its hardware and power configuration differ from Goosey's, so the
  absolute values cannot predict battery life; they justify measuring the secure
  build rather than extrapolating from plaintext:
  [Del-Valle-Soto et al.](https://airus.unisalento.it/retrieve/7ad9acb5-35e3-4ca4-a357-c68e95eea1b3/Research%20Article%20Digital%20MDPI_Del-Valle-Soto%20Visconti%20et%20al_Maggio%202026_Published%20Version.pdf).

Espressif's own [ESP32-C3 Wi-Fi power measurements](https://docs.espressif.com/projects/esp-idf/en/v5.5/esp32c3/api-guides/low-power-mode/low-power-mode-wifi.html)
show that modem sleep and DTIM settings strongly affect average current and that
transmit peaks remain high. Goosey must measure the complete badge at its battery
rail; chip-only figures do not include the display, LEDs, regulator or peripherals.

## Durable feed

Every committed price, lifecycle or resolution change needs an event written in
the same serializable database transaction as the market update. Publishing
directly from a request handler creates a lost-event window. Use the
[transactional outbox pattern](https://docs.aws.amazon.com/prescriptive-guidance/latest/cloud-design-patterns/transactional-outbox.html):

```prisma
model PublicMarketFeed {
  id             String   @id // "badge-v1"
  epoch          String
  headSequence   BigInt   @default(0)
  retentionFloor BigInt   @default(1)
  updatedAt      DateTime @updatedAt
}

model PublicMarketFeedEvent {
  epoch       String
  sequence    BigInt
  kind        String
  marketId    String?
  payload     String
  occurredAt  DateTime
  createdAt   DateTime  @default(now())
  publishedAt DateTime?
  @@id([epoch, sequence])
  @@index([publishedAt, sequence])
  @@index([createdAt])
}
```

The relay publishes unpublished rows in sequence. A crash after broker publish
and before `publishedAt` produces a duplicate, which is safe because clients
deduplicate by cursor. A market revision is the last global feed sequence that
touched that market. `Market.version` alone is insufficient because order-book
fills advance `tradeSequence` without necessarily representing all live-price
semantics.

## Bounded wire contract

A cursor is `<epoch>:<uint64-sequence>`. Sequence values are decimal JSON strings
to avoid JavaScript integer loss. A full snapshot contains the epoch, head,
retention floor, authenticated server time and no more than 16 compact market
states. A delta contains a full replacement for one market plus at most one
authoritative observed point:

```json
{
  "schema": 1,
  "kind": "market",
  "epoch": "uuid",
  "sequence": "43",
  "baseSequence": "42",
  "serverTimeMs": 1789851600000,
  "market": { "slug": "...", "revision": "43", "yesBps": 6400 },
  "point": { "id": "...", "atMs": 1789851595000, "yesBps": 6400, "source": "LMSR_TRADE" }
}
```

Bounds apply on both sides: snapshot 16 KiB and 16 markets; delta 1 KiB; catch-up
batch 32 events and 12 KiB; selected history 96 points and 8 KiB. Firmware parses
incrementally and rejects duplicate IDs, invalid UTF-8, overlong fields, unsafe
integers, invalid basis points or a response larger than its declared bound.

The MQTT topic is `goosey/v1/public/market-feed`, QoS 1, with read-only device
ACLs. A heartbeat every 10 seconds carries authenticated server time and head
sequence, but has no event sequence and never advances the durable cursor.

## Recovery algorithm

1. On boot, fetch snapshot and selected-market history into an inactive buffer.
   Validate the complete response, atomically swap it into view, then checkpoint
   the cursor.
2. Ignore an event at or below the saved cursor. Apply only the same epoch with
   `sequence == cursor + 1` and `baseSequence == cursor`.
3. On a gap, changed epoch, expired cursor, lost broker session or invalid frame,
   stop applying deltas and recover from HTTPS.
4. Save the cursor in alternating NVS slots with generation and CRC. Checkpoint
   after apply; replay after a power loss is safe.
5. Reconnect with full-jitter exponential backoff from 1 to 60 seconds. If MQTT
   remains unavailable, issue conditional snapshots every 10 seconds.

The private bearer credential belongs in encrypted NVS, with TLS hostname and CA
validation required. Espressif documents
[NVS encryption](https://docs.espressif.com/projects/esp-idf/en/latest/esp32/api-reference/storage/nvs_encryption.html),
[Security 2 provisioning](https://docs.espressif.com/projects/esp-idf/en/v5.5-rc1/esp32c3/api-reference/provisioning/wifi_provisioning.html)
and [Wi-Fi security modes](https://docs.espressif.com/projects/esp-idf/en/v5.5/esp32c3/api-guides/wifi-security.html).
Use an organizer IoT SSID or allowlisting. A captive portal is not a dependable
headless-device onboarding path ([RFC 8952](https://www.rfc-editor.org/info/rfc8952/)).

## Correct live graph semantics

Store only real observations: the opening mark, committed LMSR trades, committed
order-book executions and resolution. Never add scheduled flat rows to the
database.

Between observations the market probability is a step function. Every 10 minutes,
and on a verified heartbeat or tab focus, the renderer advances its visible
`endAt` to authenticated server time and creates an in-memory held endpoint at the
last real price. Hovering at a 10-minute instant shows that held price. It must not
linearly or cubically interpolate between two real prices, because that displays
prices that never existed. Real observations remain separately labeled.

Opening a chart, changing its range or recovering a cursor gap reloads canonical
history. A stream event adds its real point ordered by `(occurredAt, sequence)`.
The current website also needs to fetch events on its timer; merely advancing a
local clock cannot discover new trades.

## Release gates

The design is ready for staged implementation, not for flashing participant
badges. Release requires all of the following:

- A restoreable native firmware build with display, buttons, power, Wi-Fi,
  provisioning, encrypted credential storage and OTA rollback working.
- Transactional feed tests proving rollback emits nothing, each committed command
  emits one contiguous event and a concurrent snapshot cannot lose the next event.
- Duplicate, reorder, gap, epoch reset, expired cursor and power-cut convergence
  tests; malformed and oversized frames must leave active state unchanged.
- Physical AP roam, TLS rejection, broker outage/fallback and 100-reconnect tests.
- A 24-hour hardware soak with no declining heap watermark and measured battery
  life. Target p95 event-to-screen latency is under 2 seconds while connected and
  recovery is under 10 seconds after connectivity returns.
- Comparative measurements of MQTTS/8883, MQTT-over-WSS/443, bounded SSE and
  10-second conditional polling from the same firmware and payload. Keep QoS 1 as
  the correctness-first default, but record QoS 0/1 latency, loss and power before
  freezing the transport profile.
- Quote/trade idempotency and receipt recovery over Wi-Fi, plus revocation that
  blocks a cached credential before any state disclosure.
- A signed, reproducible factory/restoration image before replacing event firmware.

The stock Lua/USB application remains the safe operational path until these gates
pass. The HTTPS snapshot route can be exercised now without changing or erasing a
badge.

## Delivery phases and migration risks

1. Build a native read-only transport proof: secure Wi-Fi provisioning, bounded
   HTTPS, then MQTT/TLS on two badges. Record heap, battery and reconnect data.
2. Add feed tables to both SQLite and PostgreSQL, initialize one epoch from a
   serializable snapshot, then deploy writers before readers. Do not backfill
   timestamp-derived synthetic events.
3. Centralize `recordPublicMarketState` and call it from every database-market
   mutation: LMSR trade, order-book match, publish, pause/resume/close,
   auto-close, resolve and void. Outbox coverage is all-or-nothing.
4. Fix the web chart against the feed contract. This provides live behavior and
   validates semantics before firmware distribution.
5. Deploy an always-on outbox relay and managed broker. A request-scoped Vercel
   function is not the broker or relay.
6. Ship the native public client, then add private quote/trade and receipt recovery
   only after the read path passes its soak tests.

Database markets ship first. Solana/indexer state needs its own finalized,
monotonic revision and reorganization policy before joining this feed. JSON
sequences and volumes remain decimal strings, and migration tests must cover both
supported databases. If a seventeenth market becomes eligible, the server fails
closed until a deterministic curated badge catalog exists; it must not silently
drop a user's active holding.
