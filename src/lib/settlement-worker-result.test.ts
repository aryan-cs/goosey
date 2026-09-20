import { describe, expect, it } from "vitest";
import { settlementWorkerCycleFailed } from "./settlement-worker-result";

describe("settlement worker process result", () => {
  const healthy = { orderExpirationFailures: 0, marketCloseFailures: 0, failedRuns: 0, failedAttestations: 0 };
  it("accepts an entirely successful cycle", () => {
    expect(settlementWorkerCycleFailed(healthy)).toBe(false);
  });
  it.each(["orderExpirationFailures", "marketCloseFailures", "failedRuns", "failedAttestations"] as const)("rejects an isolated %s", (field) => {
    expect(settlementWorkerCycleFailed({ ...healthy, [field]: 1 })).toBe(true);
  });
});
