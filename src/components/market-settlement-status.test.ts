import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { MarketSettlementStatus, marketSettlementRecordState } from "./market-settlement-status";

const render = (status: string, attestation?: { signature: string; slot: string } | null) =>
  renderToStaticMarkup(createElement(MarketSettlementStatus, { status, attestation }));

describe("MarketSettlementStatus", () => {
  it("calls a settlement recorded only when both finalized evidence fields exist", () => {
    const recorded = render("RESOLVED", { signature: "finalized-signature", slot: "808" });

    expect(recorded).toContain("Settlement recorded");
    expect(recorded).toContain("verified settlement record");
    expect(marketSettlementRecordState("RESOLVED", { signature: "", slot: "808" })).toBe("pending");
    expect(marketSettlementRecordState("RESOLVED", { signature: "finalized-signature", slot: "" })).toBe("pending");
    expect(marketSettlementRecordState("RESOLVED", { signature: "finalized-signature", slot: "-1" })).toBe("pending");
  });

  it.each(["RESOLVED", "VOID"])("shows a pending record for a completed %s market without attestation", status => {
    const markup = render(status);

    expect(markup).toContain("Settlement record pending");
    expect(markup).not.toContain("Settlement recorded");
  });

  it.each(["OPEN", "PAUSED", "CLOSED", "RESOLVING", "DRAFT"])("describes unresolved %s markets without claiming a record exists", status => {
    const markup = render(status);

    expect(markup).toContain("Verified settlement");
    expect(markup).not.toContain("Settlement recorded");
    expect(markup).not.toContain("Settlement record pending");
  });

  it("states the play-money boundary without exposing chain plumbing", () => {
    for (const markup of [
      render("OPEN"),
      render("RESOLVED"),
      render("RESOLVED", { signature: "finalized-signature", slot: "0" }),
    ]) {
      expect(markup).toContain("Feathers are free play money with no cash value");
      expect(markup).not.toMatch(/solana|cryptocurrency|wallet|slot/i);
    }
  });
});
