import { describe, expect, it, vi } from "vitest";

import { GOOSEY_BOOK_BYTES, GOOSEY_BOOK_GROWTH } from "./exchange-client";
import {
  ensureManagedMarketBookCommand,
  marketBookProvisioningIdentity,
  nextManagedMarketBookStep,
} from "./managed-market-book-service";
import { resolveSolanaRuntime } from "./runtime";

const PROGRAM = "Vote111111111111111111111111111111111111111";
const GENESIS = "Stake11111111111111111111111111111111111111";
const MARKET = "SysvarC1ock11111111111111111111111111111111";
const runtime = resolveSolanaRuntime({
  GOOSEY_SOLANA_CLUSTER: "localnet",
  GOOSEY_SOLANA_RPC_URL: "http://127.0.0.1:8899",
  GOOSEY_SOLANA_PROGRAM_ID: PROGRAM,
  GOOSEY_SOLANA_GENESIS_HASH: GENESIS,
});
const base = {
  runtime,
  actorUserId: "admin_12345678",
  marketId: "market_12345678",
  marketSlug: "market-one",
  chainMarketId: "7",
  marketAddress: MARKET,
} as const;

describe("managed market book service", () => {
  it("derives every canonical create, bounded growth, finalize, and ready transition", () => {
    expect(nextManagedMarketBookStep({ ready: false, size: 0 })).toEqual({ kind: "create" });
    expect(nextManagedMarketBookStep({ ready: false, size: GOOSEY_BOOK_GROWTH }))
      .toEqual({ kind: "grow", expectedSize: GOOSEY_BOOK_GROWTH });
    const lastFullGrowth = Math.floor((GOOSEY_BOOK_BYTES - 1) / GOOSEY_BOOK_GROWTH) * GOOSEY_BOOK_GROWTH;
    expect(nextManagedMarketBookStep({ ready: false, size: lastFullGrowth }))
      .toEqual({ kind: "grow", expectedSize: lastFullGrowth });
    expect(nextManagedMarketBookStep({ ready: false, size: GOOSEY_BOOK_BYTES }))
      .toEqual({ kind: "finalize" });
    expect(nextManagedMarketBookStep({ ready: true, size: GOOSEY_BOOK_BYTES })).toBeNull();
  });

  it("rejects noncanonical or contradictory observed account states", () => {
    expect(() => nextManagedMarketBookStep({ ready: false, size: 1 })).toThrow(/noncanonical/);
    expect(() => nextManagedMarketBookStep({ ready: true, size: GOOSEY_BOOK_GROWTH })).toThrow(/wrong size/);
    expect(() => nextManagedMarketBookStep({ ready: false, size: GOOSEY_BOOK_BYTES + 1 })).toThrow(/Invalid/);
  });

  it("uses one immutable idempotency identity per exact provisioning step", () => {
    const create = marketBookProvisioningIdentity({ ...base, step: { kind: "create" } });
    const grow = marketBookProvisioningIdentity({ ...base,
      step: { kind: "grow", expectedSize: GOOSEY_BOOK_GROWTH } });
    const finalize = marketBookProvisioningIdentity({ ...base, step: { kind: "finalize" } });

    expect(create.operation).toBe("PROVISION_MARKET_BOOK");
    expect(create.idempotencyKey).toBe("managed-market-book:v1:create");
    expect(grow.idempotencyKey).toBe(`managed-market-book:v1:grow:${GOOSEY_BOOK_GROWTH}`);
    expect(finalize.idempotencyKey).toBe("managed-market-book:v1:finalize");
    expect(new Set([create.requestHash, grow.requestHash, finalize.requestHash]).size).toBe(3);
  });

  it("creates once and verifies an exact durable replay inside the projection transaction", async () => {
    let prior: Record<string, unknown> | null = null;
    const tx = { chainCommand: {
      findUnique: vi.fn(async () => prior),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => (prior = {
        id: "command_book_123", ...data,
      })),
    } };
    const input = { ...base, step: { kind: "create" } as const };

    const first = await ensureManagedMarketBookCommand(tx as never, input);
    const replay = await ensureManagedMarketBookCommand(tx as never, input);

    expect(first).toEqual(replay);
    expect(tx.chainCommand.create).toHaveBeenCalledOnce();
    expect(tx.chainCommand.create).toHaveBeenCalledWith({ data: expect.objectContaining({
      operation: "PROVISION_MARKET_BOOK",
      scope: "MARKET",
      scopeId: base.marketId,
      actorId: base.actorUserId,
    }) });
  });
});
