# Two-badge wireless proof (not a trading release)

Participants must not need USB. This test checks the first indispensable path:

    unplugged participant badge → LUA1 radio → shared relay badge
    → USB on the shared station only → Mac → public Goosey health API
    → same return path → participant screen

This build accepts only `PING` and `PONG` diagnostics. It does not link accounts,
read balances, transmit secrets, submit trades or replace the installed Goosey
app. Its radio messages are unauthenticated. Seeing a PONG establishes transport,
not identity, integrity or permission to trade. Do not connect this transport
straight to the existing USB trade gateway.

## Install and test

Two badge app directories are included in the release ZIP. Upload each directory's
`manifest.cfg`, `main.lua` and `link.lua` with the official Badge IDE. The client
slug is `goosey_radio_test`; the station slug is `goosey_relay_test`. Both are
separate from `goosey_base`. Exit existing apps before uploading.

1. Install `client` on the participant badge, then unplug it and open **Goosey
   Wireless Test**. The participant badge runs on batteries.
2. Install `relay` on a second badge, leave that badge attached to the Mac, and
   open **Goosey Relay Test**. Close the IDE's serial connection.
3. From the repository, run:

   ```sh
   SSL_CERT_FILE=/etc/ssl/cert.pem python3 badge/scripts/wireless_probe_gateway.py --port /dev/cu.YOUR_RELAY_PORT
   ```

   In the standalone ZIP, run the same command with `scripts/wireless_probe_gateway.py`.
   Select the second badge's actual device port, not a hardcoded participant port.
4. Press A on the unplugged participant badge. Expect `Wireless reply received`
   and `PONG backend OK`. The Mac logs a public health request. No account is used.
5. Move the badges apart and retry, then return them to range. Stop the Mac bridge
   and retry to distinguish radio delivery from a backend reply. Record the
   firmware versions, distances and timing before enabling authenticated work.

Packet-loss, repeated-packet, reordered-packet, timeout and bounded-memory tests
run with `python badge/tests/test_wireless.py` (requires the existing pinned lupa
QA environment). Host lifecycle smoke tests also execute both real app entrypoints.
These do not prove radio compatibility or timing on ESP32 hardware.

## Design and constraints

- Every custom payload is ≤44 bytes, matching the documented LUA1 channel.
- 23-byte header; 21-byte fragments; maximum 504-byte diagnostic message.
- One outgoing and one incoming message per endpoint, plus the last completed
  message for duplicate handling. This is deliberately a single-client probe,
  not a multi-user venue gateway.
- Stop-and-wait fragment acknowledgements, 500 ms retry spacing, eight attempts
  per fragment, ten-second abandoned assembly expiry. Final ACK only after the
  delivery callback accepts the complete message.
- Route/message IDs are routing aids, not credentials. ACKs can be forged. A
  bounded cache is not general replay protection. Restart loses that cache.
- No passwords or participant identity are present. The backend URL is fixed;
  radio messages cannot select arbitrary URLs, serial commands or file paths.

## Gate before account integration

After a real round trip is verified, implement phone pairing and a reviewed,
standard authenticated/encrypted channel with protected per-device credentials,
sequence/replay protection, expiry and revocation. The existing USB scheme cannot
be copied unchanged: its public challenge is not proof that a radio sender owns
an account. Do not use routing IDs, MAC addresses, names or contact emails as
login credentials, and do not broadcast bearer tokens or passwords.

QR generation and durable device session provisioning are not included in this
probe. Neither are wireless quotes, confirmation, trade receipt recovery or
multi-client scheduling. Those must be integrated and tested before calling this
an end-to-end wireless Goosey release. Existing USB app and production data remain
unchanged.
