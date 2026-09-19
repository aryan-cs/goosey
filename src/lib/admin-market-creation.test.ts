import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  tx: undefined as unknown,
  consumeRateLimit: vi.fn(),
}));

vi.mock("@/lib/market-service", () => {
  class ApiError extends Error {
    constructor(
      public readonly status: number,
      public readonly code: string,
      message: string,
    ) {
      super(message);
    }
  }
  return { ApiError, consumeRateLimit: mocks.consumeRateLimit, prisma: {} };
});

vi.mock("@/lib/serializable-transaction", () => ({
  runSerializableTransaction: vi.fn(
    (_client: unknown, operation: (tx: unknown) => unknown) => operation(mocks.tx),
  ),
}));

vi.mock("@/lib/order-exchange", () => ({ drainMarketOrderBook: vi.fn() }));

import { createAdminMarket, createMarketSchema } from "./admin-service";
import { initialSubsidyMilli } from "./market-maker";
import { jsonStringify } from "./serializers";

const ADMIN = "admin_creation_123";
const KEY = "market-creation-key";
const CLOSES = new Date("2030-09-19T12:00:00.000Z");
const RESOLVES = new Date("2030-09-20T12:00:00.000Z");

function input(pricingModel?: "LMSR" | "ORDER_BOOK") {
  return {
    slug: "admin-created-market",
    title: "Will this admin-created market work correctly?",
    shortTitle: "Admin-created market",
    description: "A sufficiently detailed description for market creation tests.",
    rules: "Resolve YES only when the focused market creation tests pass.",
    resolutionSource: "Focused test suite",
    category: "Testing",
    status: "DRAFT" as const,
    featured: false,
    color: "gold" as const,
    icon: "sparkles",
    closesAt: CLOSES,
    resolvesAt: RESOLVES,
    liquidityParameter: 40,
    payoutMilli: 100_000n,
    feeBps: 100,
    ...(pricingModel ? { pricingModel } : {}),
  };
}

function market(pricingModel: "LMSR" | "ORDER_BOOK") {
  return {
    id: `market_${pricingModel.toLowerCase()}`,
    executionBackend: "DATABASE",
    slug: "admin-created-market",
    status: "DRAFT",
    pricingModel,
    resolution: null,
    version: 0,
    closesAt: CLOSES,
    resolvesAt: RESOLVES,
    resolvedAt: null,
    collateralAccountId: "collateral_account",
    liquidityParameter: 40,
  };
}

function transaction(pricingModel: "LMSR" | "ORDER_BOOK") {
  const journalFind = vi.fn().mockResolvedValue(null);
  const journalCreate = vi.fn().mockResolvedValue({ id: "journal" });
  const requestFind = vi.fn().mockResolvedValue(null);
  const requestCreate = vi.fn().mockResolvedValue({ id: "request" });
  const requestUpdate = vi.fn().mockResolvedValue({ id: "request" });
  const marketCreate = vi.fn().mockResolvedValue(market(pricingModel));
  const marketFind = vi.fn();
  const ledgerUpdate = vi.fn().mockResolvedValue({});
  const treasuryUpsert = vi.fn().mockResolvedValue({ id: "treasury_account" });
  const auditCreate = vi.fn().mockResolvedValue({});
  const tx = {
    user: { findUnique: vi.fn().mockResolvedValue({ role: "ADMIN", status: "ACTIVE" }) },
    journalEntry: { findUnique: journalFind, create: journalCreate },
    idempotencyRequest: { findUnique: requestFind, create: requestCreate, update: requestUpdate },
    market: { create: marketCreate, findUnique: marketFind },
    marketEvent: { count: vi.fn() },
    ledgerAccount: { update: ledgerUpdate, upsert: treasuryUpsert },
    auditLog: { create: auditCreate },
  };
  return {
    tx,
    journalFind,
    journalCreate,
    requestFind,
    requestCreate,
    requestUpdate,
    marketCreate,
    marketFind,
    ledgerUpdate,
    treasuryUpsert,
    auditCreate,
  };
}

describe("admin market creation engines", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.consumeRateLimit.mockResolvedValue(undefined);
  });

  it("keeps omitted pricingModel backward-compatible with LMSR", () => {
    const parsed = createMarketSchema.parse({
      ...input(),
      closesAt: CLOSES.toISOString(),
      resolvesAt: RESOLVES.toISOString(),
      payoutMilli: "100000",
    });

    expect(parsed.pricingModel).toBe("LMSR");
  });

  it("creates an empty ORDER_BOOK without subsidy, journal postings, or synthetic history", async () => {
    const db = transaction("ORDER_BOOK");
    mocks.tx = db.tx;

    const result = await createAdminMarket({
      actorUserId: ADMIN,
      idempotencyKey: KEY,
      market: input("ORDER_BOOK"),
    });

    expect(result).toMatchObject({
      market: { id: "market_order_book", pricingModel: "ORDER_BOOK" },
      subsidyMilli: 0n,
      replayed: false,
    });
    expect(db.marketCreate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        pricingModel: "ORDER_BOOK",
        collateralAccount: { create: { ownerType: "MARKET", purpose: "COLLATERAL", balanceMilli: 0n } },
        priceHistory: undefined,
      }),
    }));
    expect(db.treasuryUpsert).not.toHaveBeenCalled();
    expect(db.journalCreate).not.toHaveBeenCalled();
    expect(db.ledgerUpdate).toHaveBeenCalledTimes(1);
    expect(db.requestCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        userId: ADMIN,
        route: "/api/admin/markets",
        key: KEY,
      }),
    });
    expect(db.requestUpdate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ status: "COMPLETED", responseCode: 201 }),
    }));
  });

  it("durably replays zero-funded creation and rejects the same key across models", async () => {
    const db = transaction("ORDER_BOOK");
    mocks.tx = db.tx;
    const request = { actorUserId: ADMIN, idempotencyKey: KEY, market: input("ORDER_BOOK") };

    const created = await createAdminMarket(request);
    const requestHash = db.requestCreate.mock.calls[0]![0].data.requestHash;
    const responseBody = db.requestUpdate.mock.calls[0]![0].data.responseBody;
    db.requestFind.mockResolvedValue({ requestHash, status: "COMPLETED", responseBody });

    const replay = await createAdminMarket(request);
    expect(replay).toEqual({ ...created, replayed: true });
    expect(db.marketCreate).toHaveBeenCalledTimes(1);

    await expect(createAdminMarket({ ...request, market: input("LMSR") })).rejects.toMatchObject({
      status: 409,
      code: "IDEMPOTENCY_CONFLICT",
    });
    expect(db.marketCreate).toHaveBeenCalledTimes(1);
  });

  it("preserves LMSR subsidy funding, treasury postings, and initial probability", async () => {
    const db = transaction("LMSR");
    mocks.tx = db.tx;
    const expectedSubsidy = initialSubsidyMilli(40, 100_000n);

    const result = await createAdminMarket({
      actorUserId: ADMIN,
      idempotencyKey: KEY,
      market: input(),
    });

    expect(result).toMatchObject({
      market: { pricingModel: "LMSR" },
      subsidyMilli: expectedSubsidy,
      replayed: false,
    });
    expect(db.treasuryUpsert).toHaveBeenCalledTimes(1);
    expect(db.marketCreate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        pricingModel: "LMSR",
        collateralAccount: { create: { ownerType: "MARKET", purpose: "COLLATERAL", balanceMilli: expectedSubsidy } },
        priceHistory: { create: { yesProbabilityBps: 5_000 } },
      }),
    }));
    expect(db.ledgerUpdate).toHaveBeenNthCalledWith(2, {
      where: { id: "treasury_account" },
      data: { balanceMilli: { decrement: expectedSubsidy } },
    });
    expect(db.journalCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        type: "MARKET_SUBSIDY",
        postings: { create: [
          { ledgerAccountId: "treasury_account", amountMilli: -expectedSubsidy },
          { ledgerAccountId: "collateral_account", amountMilli: expectedSubsidy },
        ] },
      }),
    });
  });

  it("replays a pre-request-store LMSR journal using its legacy request hash", async () => {
    const db = transaction("LMSR");
    const legacyInput = input();
    const legacyHash = createHash("sha256").update(jsonStringify(legacyInput)).digest("hex");
    db.journalFind.mockResolvedValue({
      metadata: jsonStringify({ requestHash: legacyHash, subsidyMilli: "12345" }),
      referenceId: "legacy_market",
    });
    db.marketFind.mockResolvedValue({ ...market("LMSR"), id: "legacy_market" });
    mocks.tx = db.tx;

    const replay = await createAdminMarket({
      actorUserId: ADMIN,
      idempotencyKey: KEY,
      market: legacyInput,
    });

    expect(replay).toMatchObject({
      market: { id: "legacy_market", pricingModel: "LMSR" },
      subsidyMilli: 12_345n,
      replayed: true,
    });
    expect(db.requestFind).toHaveBeenCalledTimes(1);
    expect(db.requestCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        requestHash: expect.any(String),
        status: "COMPLETED",
        responseCode: 201,
      }),
    });
    expect(db.marketCreate).not.toHaveBeenCalled();
  });
});
