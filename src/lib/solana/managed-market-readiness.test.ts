import { address } from "@solana/kit";
import { describe, expect, it, vi } from "vitest";

import { planManagedMarketReadiness } from "./managed-market-readiness";

const wallet = address("EnKKVxU5bicr61K8gNsUAAj6ibYDXLWUdXi6KKFyA47W");
const runtime = { cluster: "localnet" as const, rpcUrl: "http://127.0.0.1:20999",
  programAddress: address("CgEGAD3EGLm63YaSx58sRiNPQmmxg8RqvqcxE3xThX8Q"),
  genesisHash: "AjRRXmyGBFhUtVWWp5xYXYKAP4Ha8vyTDRNVrkTVA2DE" };

function snapshot(patch: Record<string, unknown> = {}) {
  return { wallet, finalizedSlot: 50n, registered: true,
    seat: { availableCash: 200n, reservedCash: 300n, nextNonce: 7n },
    walletTokenAmount: 10_000n, marketState: { feeBps: 100 },
    orderBook: { reservesReconciled: true }, ...patch };
}

describe("managed market readiness planner", () => {
  it("requests seat registration before considering market funding", async () => {
    const read = vi.fn(async () => snapshot({ registered: false, seat: null }));
    await expect(planManagedMarketReadiness({ runtime, walletAddress: wallet, marketId: 7n,
      action: "BUY", limitPriceMilli: 500n, quantity: 2n }, { read: read as never }))
      .resolves.toEqual({ status: "register-seat", observedSlot: 50n });
  });

  it("plans only the exact finalized BUY cash deficit and ignores reserved cash", async () => {
    const read = vi.fn(async () => snapshot());
    await expect(planManagedMarketReadiness({ runtime, walletAddress: wallet, marketId: 7n,
      action: "BUY", limitPriceMilli: 500n, quantity: 2n }, { read: read as never }))
      .resolves.toEqual({ status: "deposit", amount: 810n, requiredCash: 1_010n, availableCash: 200n,
        walletTokenAmount: 10_000n, expectedNonce: 7n, observedSlot: 50n });
  });

  it("is ready when finalized cash covers a BUY and never cash-funds a SELL", async () => {
    const read = vi.fn(async () => snapshot({ seat: { availableCash: 2_000n, reservedCash: 3_000n, nextNonce: 8n } }));
    await expect(planManagedMarketReadiness({ runtime, walletAddress: wallet, marketId: 7n,
      action: "BUY", limitPriceMilli: 500n, quantity: 2n }, { read: read as never }))
      .resolves.toMatchObject({ status: "ready", requiredCash: 1_010n, availableCash: 2_000n });
    await expect(planManagedMarketReadiness({ runtime, walletAddress: wallet, marketId: 7n,
      action: "SELL", limitPriceMilli: 500n, quantity: 2n }, { read: read as never }))
      .resolves.toMatchObject({ status: "ready", requiredCash: 0n });
  });

  it("fails closed when the wallet cannot cover the exact deficit", async () => {
    const read = vi.fn(async () => snapshot({ walletTokenAmount: 809n }));
    await expect(planManagedMarketReadiness({ runtime, walletAddress: wallet, marketId: 7n,
      action: "BUY", limitPriceMilli: 500n, quantity: 2n }, { read: read as never }))
      .rejects.toThrow("Insufficient free feathers");
  });

  it.each([
    { wallet: address("11111111111111111111111111111111") },
    { finalizedSlot: -1n },
    { orderBook: { reservesReconciled: false } },
  ])("rejects an incomplete or mismatched finalized snapshot %#", async patch => {
    const read = vi.fn(async () => snapshot(patch));
    await expect(planManagedMarketReadiness({ runtime, walletAddress: wallet, marketId: 7n,
      action: "BUY", limitPriceMilli: 500n, quantity: 2n }, { read: read as never })).rejects.toThrow("snapshot");
  });
});

