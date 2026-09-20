import { describe, expect, it } from "vitest";
import { balanceDebitSchema, contributedCapitalDelta } from "./admin-balance-adjustment";

describe("administrative balance debits", () => {
  it("parses exact integer milli-feather amounts", () => {
    expect(balanceDebitSchema.parse({ username: "bubbly", amountMilli: "3000000", reason: "Reverse the event credit", principalTreatment: "REVERSE_GRANT" }).amountMilli).toBe(3_000_000n);
    expect(() => balanceDebitSchema.parse({ username: "bubbly", amountMilli: "3.5", reason: "Reverse the event credit", principalTreatment: "REVERSE_GRANT" })).toThrow();
  });
  it("adjusts contributed capital only for explicit grant reversals", () => {
    expect(contributedCapitalDelta("WELCOME_GRANT", 1_000_000n, "{}")).toBe(1_000_000n);
    expect(contributedCapitalDelta("ADMIN_GRANT", 3_000_000n, "{}")).toBe(3_000_000n);
    expect(contributedCapitalDelta("ADMIN_BALANCE_DEBIT", -3_000_000n, JSON.stringify({ principalDeltaMilli: "-3000000" }))).toBe(-3_000_000n);
    expect(contributedCapitalDelta("ADMIN_BALANCE_DEBIT", -8_000_000n, JSON.stringify({ principalDeltaMilli: "0" }))).toBe(0n);
  });
});
