# Actual order-book capacity verification

Run `npm run test:chain:isolated -- --suite capacity` with the documented
Solana toolchain. The runner creates its own ledger, keys and loopback ports;
it never resets the retained development chain. All participants and market
terms in this suite are explicitly isolated test fixtures, not public markets.

On 2026-09-19, the compiled program with SHA-256
`d2f3e57d090ab54369068a450c9f2d2f9b4bf6e629a06eb826672d824c770a82`
passed 251 actual transaction cases. Retained local evidence is
`/tmp/goosey-solana-runner-Qg7GZV/program-e2e.log` and `manifest.json`.
The isolated genesis was `95oFyp3VLgSxr4pUoSmebm1xMqYZ7vrStXQFYwzqz8aF`.

- Filled all 1,024 canonical order slots with signed placements.
- Rejected the 1,025th order atomically without corrupting existing reserves.
- Cancelled an order and reused exactly the freed slot, returning to capacity.
- Rolled back a fill-or-kill order that needed 16 maker touches but allowed 15.
- Filled 16 distinct makers with a 16-touch allowance, using 154,401 compute units.
- Reconciled 16,000 base units of outcome collateral and 17 of fees, with total
  SPL supply of 340,000 exactly equal to all participant and vault token balances.

The finalized maximum-touch transaction was
`3xBW6T6k32j5CfU3B9xyiDoMwwAwGU7CpJTMk9iVi2GxYTa841pN1uQakp3arWdBrrLW8u9EZL9Gg2utFvtjGfjJ`.
These are runtime boundary checks, not proof of arbitrary network throughput,
devnet deployment, extension-wallet compatibility or completed web integration.
