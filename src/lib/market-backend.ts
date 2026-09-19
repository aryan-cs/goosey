import { ApiError } from "./market-service";

/** Only this exact namespace may use the legacy SQL financial engine.
 * Missing fields are not legacy defaults: callers must load the real columns.
 * Backend and canonical bindings are immutable under the reviewed migrations.
 */
export const DATABASE_MARKET_FILTER = {
  executionBackend: "DATABASE", collateralAccountId: { not: null },
} as const;

type Boundary = { executionBackend?: unknown; collateralAccountId?: unknown; collateralAccount?: unknown };
type DatabaseMarket<T> = T & { executionBackend: "DATABASE"; collateralAccountId: string }
  & (T extends { collateralAccount: infer C } ? { collateralAccount: NonNullable<C> } : unknown);

export function assertDatabaseFinancialMarket<T extends Boundary>(market: T): asserts market is DatabaseMarket<T> {
  if (market.executionBackend !== "DATABASE") {
    throw new ApiError(409, "MARKET_BACKEND_MISMATCH", "This market cannot use database financial operations. Use its configured execution backend.");
  }
  if (typeof market.collateralAccountId !== "string" || market.collateralAccountId.length === 0
    || ("collateralAccount" in market && (!market.collateralAccount || typeof market.collateralAccount !== "object"
      || !("id" in market.collateralAccount) || market.collateralAccount.id !== market.collateralAccountId))) {
    throw new ApiError(409, "MARKET_COLLATERAL_MISSING", "Database market collateral requires reconciliation before financial operations.");
  }
}

/** Expression form for database-only reconciliation and test tooling. */
export function requireDatabaseFinancialMarket<T extends Boundary>(market: T): DatabaseMarket<T> {
  assertDatabaseFinancialMarket(market);
  return market;
}
