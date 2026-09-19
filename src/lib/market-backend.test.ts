import { describe, expect, it, vi } from "vitest";
vi.mock("./market-service", () => ({ ApiError: class extends Error {
  constructor(public status: number, public code: string, message: string) { super(message); }
} }));
import { assertDatabaseFinancialMarket, requireDatabaseFinancialMarket } from "./market-backend";

describe("immutable financial backend boundary", () => {
  it.each(["SOLANA", "UNKNOWN", "database", null, undefined])("rejects backend %s", (executionBackend) => {
    expect(() => assertDatabaseFinancialMarket({ executionBackend, collateralAccountId: "cash" }))
      .toThrow(expect.objectContaining({ code: "MARKET_BACKEND_MISMATCH" }));
  });
  it.each([null, undefined, "", 123])("rejects missing/malformed collateral %s", (collateralAccountId) => {
    expect(() => assertDatabaseFinancialMarket({ executionBackend: "DATABASE", collateralAccountId }))
      .toThrow(expect.objectContaining({ code: "MARKET_COLLATERAL_MISSING" }));
  });
  it.each([null, undefined, {}, { id: "wrong" }])("rejects a loaded invalid relation %j", (collateralAccount) => {
    expect(() => assertDatabaseFinancialMarket({ executionBackend: "DATABASE", collateralAccountId: "cash", collateralAccount }))
      .toThrow(expect.objectContaining({ code: "MARKET_COLLATERAL_MISSING" }));
  });
  it("narrows the actual row without fabricating a collateral account", () => {
    const row = { executionBackend: "DATABASE", collateralAccountId: "cash" as string | null,
      collateralAccount: { id: "cash", balanceMilli: 10n } as { id: string; balanceMilli: bigint } | null };
    assertDatabaseFinancialMarket(row);
    const id: string = row.collateralAccountId;
    const balance: bigint = row.collateralAccount.balanceMilli;
    expect([id, balance]).toEqual(["cash", 10n]);
    expect(requireDatabaseFinancialMarket(row)).toBe(row);
  });
});
