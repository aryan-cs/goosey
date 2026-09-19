import type { Prisma } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth", () => ({ requiresEmailVerification: vi.fn() }));
vi.mock("@/lib/market-service", () => ({
  ApiError: class ApiError extends Error {
    constructor(public status: number, public code: string, message: string) { super(message); }
  },
  consumeRateLimit: vi.fn(),
  prisma: {},
}));

import { drainMarketOrderBook } from "./order-exchange";

describe("market lifecycle command keys", () => {
  it.each(["MARKET_PAUSED", "MARKET_CLOSED", "MARKET_RESOLVING"] as const)(
    "%s persists distinct keys for the same actor and version across markets",
    async (reason) => {
      const actorUserId = "admin_same_actor";
      const marketIds = ["market_first", "market_second"];
      const version = 7;
      const persisted = new Map<string, Prisma.OrderCommandUncheckedCreateInput>();
      const tx = {
        market: {
          findUnique: vi.fn(async ({ where }: { where: { id: string } }) => ({
            id: where.id, pricingModel: "ORDER_BOOK", version, commandSequence: 3n, bookSequence: 5n,
          })),
          updateMany: vi.fn().mockResolvedValue({ count: 1 }),
          update: vi.fn().mockResolvedValue({}),
        },
        marketOrder: {
          findMany: vi.fn().mockResolvedValue([]),
          count: vi.fn().mockResolvedValue(0),
        },
        orderReservation: { count: vi.fn().mockResolvedValue(0) },
        position: { count: vi.fn().mockResolvedValue(0) },
        orderEvent: { create: vi.fn().mockResolvedValue({}) },
        orderCommand: {
          create: vi.fn(async ({ data }: { data: Prisma.OrderCommandUncheckedCreateInput }) => {
            // Mirror the persisted unique constraint, not just a key-building helper.
            const unique = JSON.stringify([data.actorUserId, data.scope, data.idempotencyKey]);
            if (persisted.has(unique)) throw new Error("Duplicate actor/scope/idempotencyKey");
            persisted.set(unique, data);
            return data;
          }),
        },
      };

      for (const marketId of marketIds) {
        await expect(drainMarketOrderBook(tx as unknown as Prisma.TransactionClient, {
          marketId, actorUserId, reason, operationAt: new Date("2026-09-19T12:00:00Z"),
        })).resolves.toEqual({ canceledOrders: 0, canceledQuantity: 0, commandSequence: 4n });
      }

      expect(tx.orderCommand.create).toHaveBeenCalledTimes(2);
      expect([...persisted.values()]).toEqual(marketIds.map((marketId) => expect.objectContaining({
        marketId,
        actorUserId,
        scope: "MARKET_LIFECYCLE",
        idempotencyKey: `${marketId}:${reason}:${version}`,
        commandType: "LIFECYCLE",
        status: "COMPLETED",
      })));
    },
  );
});
