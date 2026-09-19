# Wireless account access investigation — September 19, 2026

The product requirement is now explicit: participants must not need a USB
connection or a running laptop to trade. The 0.10 USB gateway is a development
transport, not the intended distribution architecture.

## What the existing identity system does

The public dashboard JavaScript saved during this investigation contains:

- A provisioned profile with `badge_id`, `attendee_id`, `display_name`,
  `account_email`, `claim_id`, social fields and `provisioned_unix`.
- A `badge_profile apply` console operation that writes profile data to the badge.
- `RegisterBadgeUploadToken`, registering a SHA-256 hash of a separate badge
  secret against the attendee, claim, badge code and radio address.
- Sync requests containing `badge_secure_token` plus either the participant's
  dashboard token (`self-upload`) or a station password and claim ID (`upload`).

These are observations of frontend code, not proof of an externally supported
Goosey authentication endpoint. No organizer credentials were obtained, no
participant data was queried through organizer operations, and no sync token
was exported. A later attempt to refresh the dashboard bundle returned HTTP 403.

The [official manual](https://badge.hackthenorth.com/manual) says the boot QR is
the check-in/meal ID, contacts can be exchanged by bumping, and backups use
dashboard USB or the Sync app at a help-desk station. The provisioned profile
explains how the badge can display identity without proving that the home page
performs a live internet request. Firmware implementation of the QR renderer
has not been inspected; the exact QR payload is not established here.

## Current third-party app boundary

The [current Lua guide](https://badge.hackthenorth.com/ide/README.md), downloaded
again for this investigation, explicitly exposes `badge.me.name()`,
`badge.me.badge_id()`, role, colour and provisioning status. It explicitly
excludes email, phone and social fields, and says badge ID is not authentication.

Lua radio is a 44-byte broadcast channel prefixed `LUA1`. Scripts cannot send or
receive system bump/sync frames. The documented runtime has no Wi-Fi/HTTP client
or credential-signing API. Apps cannot use filesystem paths to escape their own
directory. Thus displaying a person's name is supported now; authenticating
their existing Goosey account and reaching its server need additional facilities.

## Preferred integration: organizer-supported wireless identity

Ask the badge team for an official app identity/transport extension and firmware
source or integration documentation. The concrete request is:

> We are building Goosey, a play-feather trading app. Can a foreground Lua app
> obtain a short-lived identity assertion scoped to Goosey, and send requests
> through a supported wireless station or HTTPS bridge? We need a verified
> attendee/account identity, nonce and expiry, public verification keys or a
> server-side verification endpoint, and request/response transport details.
> Please keep the badge's original sync credential inside trusted firmware.
> Is there a supported extension to the existing badge upload-token system?

With such support: app reads owner display name locally; native firmware obtains
an audience-bound proof; Goosey verifies it server-side, resolves an explicitly
linked account, and issues a revocable device session. Account linking must use
the organizer's verified account identity, not a mutable networking email. Do
not silently merge accounts by contact email. Initial user consent may still be
required by the organizer's identity interface.

The backend remains authoritative for quotes, balances and trades. Wireless
requests need acknowledgement, sequencing, expiry, integrity/authentication,
fragmentation, idempotent confirmed orders and pending-order recovery. No raw
bearer credentials should be broadcast in plaintext. Existing USB trade tests
do not establish these wireless properties.

## Alternative without organizer API

A dedicated Goosey radio gateway could bridge nearby participant badges to
HTTPS. Participants carry no cables; one shared station needs power/internet.
This requires compatible gateway hardware, documented or inspected BLE framing,
and an actual two-device round-trip test. Only one badge is currently available.
One-time website pairing can establish account access; automatic name lookup
cannot replace that proof. Existing event stations cannot be assumed to accept
our Lua packets. A phone browser cannot be assumed to support this connectionless
BLE protocol merely because it supports Web Bluetooth.

## Full firmware alternative

The [official HAL guide](https://badge.hackthenorth.com/custom-firmware-hal.md)
identifies ESP32-C3-MINI-1-N4 and documents replacing event firmware. A native
networking app is a separate implementation path, not a shareable stock Lua app.
Network provisioning, TLS/memory, identity access, preservation of event features
and deployment must be proven before selecting it. No firmware replacement or
badge erasure was performed for this investigation.

## Hardware verification blocker

The Mac sees `/dev/cu.usbmodem1101`, but the normal console handshake timed out
again. This prevents checking installed firmware or its home/QR widgets directly.
The conclusions above come from the current public Lua guide, the official
manual and the saved dashboard implementation, not a newly successful device test.
