import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));

import { ManagedTransferForm, normalizeTransferUsername, validTransferAmount } from "./managed-transfer-form";

describe("managed username transfer form", () => {
  it("renders ordinary play-money transfer language without chain or wallet details", () => {
    const html = renderToStaticMarkup(createElement(ManagedTransferForm, { availableMilli: "12500" }));
    expect(html).toContain("Send feathers");
    expect(html).toContain("another Goosey user by username");
    expect(html).toContain("13 available");
    expect(html).not.toMatch(/solana|on-chain|wallet|spl|crypto/i);
  });

  it("normalizes exact usernames and accepts at most three decimal places", () => {
    expect(normalizeTransferUsername("  @BUBBLY  ")).toBe("bubbly");
    expect(validTransferAmount("0.001")).toBe(true);
    expect(validTransferAmount("25")).toBe(true);
    expect(validTransferAmount("0")).toBe(false);
    expect(validTransferAmount("1.0001")).toBe(false);
    expect(validTransferAmount("01")).toBe(false);
  });
});
