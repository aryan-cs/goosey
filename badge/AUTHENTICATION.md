# Required experience: automatic badge account sign-in

The user requires recipients to open the shared app and automatically use their
own Goosey account, using the email already associated with their badge. They
must not retype an email, password or pairing code. Existing website usernames,
balances and positions must come from the database; never make a separate local
wallet look like that account. This experience is **not implemented**.

## Verified platform constraints, September 19, 2026

- The official [Lua API guide](https://badge.hackthenorth.com/ide/README.md)
  explicitly excludes email, phone and social fields from `badge.me` and contacts.
  Public badge IDs and radio MAC addresses are not authentication credentials.
- The public implementation of the [attendee portal](https://my.hackthenorth.com/badge)
  distinguishes registered `account_email` from contact `net_email`. The latter
  is networking information, not proof of owning a Goosey account. Do not treat
  a mutable contact field as an authentication factor.
- The portal's shipped client supports a private `badge_token get` USB command
  and registers a SHA-256 hash of that token during provisioning. That token
  exists for the organizer's badge backup/profile sync service.
- The client calls `/v3/badge-data/self-upload` with **both** a portal user token
  and the badge token. Its organizer upload alternative also requires organizer
  authorization. Neither observed flow is a standalone third-party identity
  assertion or an endpoint Goosey can use to validate badge ownership alone.
  No badge secret, portal session or full device backup was collected to research
  this. Do not repurpose an upload credential without an issuer-supported flow.

Source inspected: portal bundle `main.bb9a0245.chunk.js`, particularly profile
construction, `readSyncCredentials`, `registerBadgeUploadToken`, and badge-data
upload calls. Absence of an integration in this client does not establish that
organizers have no private API; request their supported integration contract.

## Integration gate

Zero-input sign-in needs an organizer-supported assertion or token-validation
endpoint binding a device to its **verified registered account email**, with
Goosey audience, expiry, replay protection and revocation. A profile contact
email can be used only if the issuer attests that it is verified for that owner.

Once available, Goosey's server validates that proof, maps its verified email
to the account, issues narrowly scoped device credentials and returns the
existing username/balance/positions. Credentials must stay out of shared app
files. New accounts must follow the approved onboarding requirements rather
than silently claiming an existing account with an arbitrary email.

The one-badge USB public-data transport is physically verified. It carries no
account credentials and is not authentication. Wireless distribution separately
requires a relay and secure per-device authorization; sharing the Lua source
does not distribute a working internet connection or another user's session.

Until the issuer integration exists, the badge remains a public market client.
Do not implement `email -> session`, display a fake logged-in username, or describe
the app as automatically logged in. Manual pairing would be a changed product
requirement and must not silently replace the requested automatic experience.
