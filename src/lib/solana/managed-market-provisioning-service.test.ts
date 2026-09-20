import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ tx: undefined as unknown, rateLimit: vi.fn() }));
vi.mock("@/lib/market-service", async () => {
  class ApiError extends Error {
    constructor(public readonly status: number, public readonly code: string, message: string) { super(message); }
  }
  return { ApiError, consumeRateLimit: mocks.rateLimit, prisma: {} };
});
vi.mock("@/lib/serializable-transaction", async () => {
  const actual = await vi.importActual<typeof import("@/lib/serializable-transaction")>("@/lib/serializable-transaction");
  return { ...actual, runSerializableTransaction: vi.fn((_db, operation) => operation(mocks.tx)) };
});

import { acceptManagedMarketProvisioning } from "./managed-market-provisioning-service";

const env = {
  GOOSEY_SOLANA_CLUSTER: "localnet",
  GOOSEY_SOLANA_RPC_URL: "http://127.0.0.1:8899",
  GOOSEY_SOLANA_PROGRAM_ID: "Vote111111111111111111111111111111111111111",
  GOOSEY_SOLANA_GENESIS_HASH: "Stake11111111111111111111111111111111111111",
};
const dates = { closesAt: new Date("2030-09-19T12:00:00.000Z"), resolvesAt: new Date("2030-09-20T12:00:00.000Z") };
const marketInput = {
  slug: "managed-chain-market",
  title: "Will this market be provisioned on Solana?",
  shortTitle: "Managed chain market",
  description: "A complete editorial description for managed market provisioning.",
  rules: "Resolve YES only when the stated authoritative source confirms the event.",
  resolutionSource: "https://example.invalid/source",
  category: "Testing",
  status: "OPEN",
  featured: false,
  color: "gold",
  icon: "sparkles",
  closesAt: dates.closesAt,
  resolvesAt: dates.resolvesAt,
  pricingModel: "ORDER_BOOK",
  liquidityParameter: 40,
  payoutMilli: 100_000n,
  feeBps: 25,
} as const;

function fixture() {
  const commandDate = new Date("2026-09-19T22:00:00.000Z");
  let market: Record<string, unknown> | null = null;
  let binding: Record<string, unknown> | null = null;
  let command: Record<string, unknown> | null = null;
  let request: Record<string, unknown> | null = null;
  const tx = {
    user: { findUnique: vi.fn(async () => ({ role: "ADMIN", status: "ACTIVE" })) },
    idempotencyRequest: {
      findUnique: vi.fn(async () => request),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => (request = { ...data, status: "PENDING", responseBody: null })),
      update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => (request = { ...request, ...data })),
    },
    marketEvent: { count: vi.fn(async () => 1) },
    market: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => (market = {
        id: "market_managed_123", slug: marketInput.slug, resolution: null, version: 0,
        resolvedAt: null, createdById: "admin_123", payoutMilli: 100_000n, feeBps: 25,
        closesAt: dates.closesAt, resolvesAt: dates.resolvesAt, ...data,
      })),
      findUnique: vi.fn(async () => market && ({ ...market, solanaBinding: binding })),
    },
    solanaMarketBinding: { create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => (binding = data)) },
    chainCommand: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => (command = {
        id: "command_market_123", status: "ACCEPTED", revision: 0, attemptCount: 0,
        acceptedAt: commandDate, preparedAt: null, signedAt: null, submittedAt: null,
        confirmedAt: null, finalizedAt: null, projectedAt: null, unknownSince: null,
        updatedAt: commandDate, ...data,
      })),
      findUnique: vi.fn(async () => command),
    },
    auditLog: { create: vi.fn(async () => ({})) },
  };
  return { tx, get market() { return market; }, get binding() { return binding; }, get command() { return command; } };
}

describe("managed market provisioning acceptance", () => {
  beforeEach(() => { vi.clearAllMocks(); mocks.rateLimit.mockResolvedValue(undefined); });

  it("atomically creates only a hidden SOLANA order-book draft, binding, and durable command", async () => {
    const f = fixture(); mocks.tx = f.tx;
    const result = await acceptManagedMarketProvisioning({ actorUserId: "admin_123", idempotencyKey: "create-market-123", market: marketInput },
      { database: {} as never, env });
    expect(result).toMatchObject({ accepted: true, pending: true, replayed: false, subsidyMilli: 0n,
      market: { executionBackend: "SOLANA", status: "DRAFT", pricingModel: "ORDER_BOOK" },
      command: { operation: "PROVISION_MARKET", status: "ACCEPTED" } });
    expect(f.tx.market.create).toHaveBeenCalledWith({ data: expect.objectContaining({
      executionBackend: "SOLANA", collateralAccountId: null, acceptingOrders: false,
      status: "DRAFT", pricingModel: "ORDER_BOOK",
    }) });
    const data = f.tx.market.create.mock.calls[0]![0].data;
    expect(data).not.toHaveProperty("collateralAccount");
    expect(data).not.toHaveProperty("priceHistory");
    expect(f.tx.chainCommand.create).toHaveBeenCalledWith({ data: expect.objectContaining({
      scope: "MARKET", scopeId: "market_managed_123", operation: "PROVISION_MARKET",
    }) });
    expect(JSON.parse(String((f.command as Record<string, unknown>).requestJson))).toMatchObject({
      request: { requestedVisibility: "OPEN", payoutMilli: "100000", feeBps: 25 },
    });
  });

  it("replays the same durable identities and rejects changed editorial intent", async () => {
    const f = fixture(); mocks.tx = f.tx;
    const first = await acceptManagedMarketProvisioning({ actorUserId: "admin_123", idempotencyKey: "create-market-123", market: marketInput },
      { database: {} as never, env });
    const replay = await acceptManagedMarketProvisioning({ actorUserId: "admin_123", idempotencyKey: "create-market-123", market: marketInput },
      { database: {} as never, env });
    expect(replay.replayed).toBe(true);
    expect(replay.market.id).toBe(first.market.id);
    expect(replay.command.id).toBe(first.command.id);
    expect(f.tx.market.create).toHaveBeenCalledOnce();
    await expect(acceptManagedMarketProvisioning({ actorUserId: "admin_123", idempotencyKey: "create-market-123",
      market: { ...marketInput, title: "Will changed editorial intent be rejected safely?" } }, { database: {} as never, env }))
      .rejects.toMatchObject({ status: 409, code: "IDEMPOTENCY_CONFLICT" });
  });

  it("fails closed instead of silently translating an LMSR request into another financial engine", async () => {
    const f = fixture(); mocks.tx = f.tx;
    await expect(acceptManagedMarketProvisioning({ actorUserId: "admin_123", idempotencyKey: "create-market-123",
      market: { ...marketInput, pricingModel: "LMSR" } }, { database: {} as never, env }))
      .rejects.toMatchObject({ status: 422, code: "CHAIN_ORDER_BOOK_REQUIRED" });
    expect(f.tx.market.create).not.toHaveBeenCalled();
    expect(f.tx.chainCommand.create).not.toHaveBeenCalled();
  });
});
