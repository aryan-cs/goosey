# Settlement worker operation

The worker and web application are separate processes. Updating application
files or rebuilding Next.js does **not** reload a running worker's JavaScript.
Restart the worker after settlement, matching, expiry or database-runtime code
changes. Keep its database configuration aligned with the web process.

## Local operation

```sh
npm run worker:settlement:continuous
```

The default polling interval is five seconds; `-- --interval-ms=1000` selects
one second. Supported intervals are one through ten seconds. One-shot
`npm run worker:settlement` processes bounded work once and exits nonzero for
order-expiration, market-close or settlement-run failures.

The worker never invents a result. It expires orders, closes elapsed markets and
processes only previously approved settlement runs. The two-person resolution
approval flow remains authoritative.

## Restart sequence

1. Check `/api/ready`, pending settlement runs and the worker's logs. Plan an
   appropriate grace period for an in-flight atomic operation.
2. Send SIGTERM to the identified worker process. It finishes its current
   atomic operation and stops before starting another queued operation. Do not
   terminate unrelated Node processes or the web process.
3. Wait for that process to exit and its persisted `WorkerState` to become
   `STOPPED`. Do not start multiple workers to force an ownership takeover.
4. Start the replacement worker with the intended code and database config.
   Require a fresh `RUNNING` heartbeat and a successful cycle, then confirm
   `/api/ready` is healthy again.

A second worker refuses to claim a fresh active singleton. If the process was
forcibly killed, it cannot persist `STOPPED`; after its heartbeat becomes stale,
a replacement can claim ownership. Settlement-run leases independently fence
in-flight batches. Do not manually clear leases or mark runs completed as a
restart shortcut.

## Local verification (2026-09-19)

Two real-process tests use disposable SQLite databases to verify graceful
SIGTERM shutdown, persisted `STOPPED` state, a replacement instance reaching
`RUNNING`, and rejection of a concurrent contender without changing the active
owner. Unit tests cover stopping between queued operations and retaining prior
health history when a cycle is interrupted.

The local development worker was stopped and restarted with the updated code.
The web process remained available on port 8080. Its readiness endpoint then
reported `ready`, a successful worker cycle, zero consecutive failures, and no
expired-market or active-settlement backlog. This is a local restart check, not
a production supervision or high-load guarantee.

## Failure handling and deployment limits

Continuous mode retries isolated entity failures on later cycles and reports
them through readiness. An uncaught infrastructure error exits with code 1;
automatic restart requires an external process supervisor. Do not run an
unsupervised terminal process as the production worker.

The repository does not yet provide a production hosting/supervisor deployment
or an approved PostgreSQL disaster-recovery setup. This runbook describes the
process contract; it is not evidence that those production requirements exist.
