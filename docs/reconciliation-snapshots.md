# Reconciliation consistency

`npm run reconcile` reads journals, postings, accounts, participants, markets,
positions, orders, fills, and reservations inside one serializable transaction.
Validation runs after the snapshot is materialized, without further database
reads. A trade committed during reconciliation cannot make one query see the
old wallet and another query see the new position.

The snapshot reader uses the shared bounded transaction retry policy. Query
failure or transaction timeout fails the command instead of reporting partial
data as a successful reconciliation. This remains an in-memory whole-database
check, with the shared 20-second transaction deadline; very large deployments
need a separately designed consistent streaming/reconciliation process.

Cash escrow validation independently compares reserved principal plus fees
with the account balance, owner, and purpose. Missing accounts, shared escrow,
negative reservations, and nonzero orphan escrow are discrepancies even when
ledger caches happen to balance.

Active sell orders must also reserve exactly their remaining quantity in the
selected outcome, with zero shares reserved in the opposite outcome. Matching
order and position caches alone are not proof that an order is fully backed.

Local verification uses disposable databases. The order-book journey also
creates and restores SQLite archives, compares logical records, then reconciles
the restored database. The settlement journey exercises YES/NO/VOID payouts
and the same restore/reconciliation path. These checks do not establish a
production monitoring schedule or certify a PostgreSQL disaster-recovery plan.
