import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  transaction: vi.fn(),
  runner: undefined as undefined | ((callback: (tx: unknown) => unknown) => unknown),
  consumeRateLimit: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/market-service", () => {
  class ApiError extends Error {
    constructor(
      public readonly status: number,
      public readonly code: string,
      message: string,
      public readonly details?: unknown,
    ) {
      super(message);
    }
  }

  return {
    ApiError,
    consumeRateLimit: mocks.consumeRateLimit,
    prisma: {
      $transaction: (...args: unknown[]) => {
        mocks.transaction(...args);
        if (!mocks.runner) throw new TypeError("transaction runner missing");
        const callback = args.find((value): value is (tx: unknown) => unknown => typeof value === "function");
        if (!callback) throw new TypeError("transaction callback missing");
        return mocks.runner(callback);
      },
    },
  };
});

vi.mock("@/lib/order-exchange", () => ({ drainMarketOrderBook: vi.fn() }));

import {
  approveResolutionProposal,
  assertAdmin,
  createAdminMarket,
  createResolutionProposal,
  transitionAdminMarket,
} from "./admin-service";

const ADMIN_A = "admin-alpha";
const ADMIN_B = "admin-bravo";
const MARKET_ID = "market-hostile";
const KEY = "shared-hostile-idempotency-key";

function runWith(tx: unknown): void {
  mocks.runner = async (callback) => callback(tx);
}

function activeAdmin(id = ADMIN_A) {
  return { id, role: "ADMIN", status: "ACTIVE" };
}

function marketInput() {
  const closesAt = new Date(Date.now() + 86_400_000);
  return {
    slug: "hostile-authorization-market",
    title: "Will hostile authorization tests pass?",
    shortTitle: "Authorization tests",
    description: "A real market description long enough for strict validation.",
    rules: "Resolve YES only when the hostile authorization suite passes.",
    resolutionSource: "Goosey test suite",
    category: "Security",
    status: "DRAFT" as const,
    featured: false,
    color: "gold" as const,
    icon: "shield",
    closesAt,
    resolvesAt: new Date(closesAt.getTime() + 3_600_000),
    liquidityParameter: 40,
    payoutMilli: 100_000n,
    feeBps: 0,
  };
}

describe("hostile admin service authorization", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.runner = undefined;
  });

  it.each([
    { role: "USER", status: "ACTIVE" },
    { role: "ADMIN", status: "INACTIVE" },
    { role: "ADMIN", status: "BANNED" },
  ])("rejects role/status escalation at the exported guard ($role/$status)", ({ role, status }) => {
    expect(() => assertAdmin({ role, status })).toThrow(expect.objectContaining({
      status: 403,
      code: "ADMIN_REQUIRED",
    }));
  });

  it.each([
    { role: "USER", status: "ACTIVE" },
    { role: "ADMIN", status: "INACTIVE" },
    { role: "ADMIN", status: "BANNED" },
  ])("rechecks the actor in the service transaction before market mutation ($role/$status)", async ({ role, status }) => {
    const marketFind = vi.fn();
    const marketUpdate = vi.fn();
    runWith({
      user: { findUnique: vi.fn().mockResolvedValue({ role, status }) },
      market: { findUnique: marketFind, updateMany: marketUpdate },
    });

    await expect(transitionAdminMarket({
      actorUserId: ADMIN_A,
      marketId: MARKET_ID,
      action: "PAUSE",
      reason: "Hostile authorization check",
      expectedVersion: 0,
    })).rejects.toMatchObject({ status: 403, code: "ADMIN_REQUIRED" });

    expect(marketFind).not.toHaveBeenCalled();
    expect(marketUpdate).not.toHaveBeenCalled();
  });

  it("scopes market-creation idempotency to the acting administrator", async () => {
    const journalFind = vi.fn().mockResolvedValue(null);
    runWith({
      user: { findUnique: vi.fn().mockResolvedValue(activeAdmin(ADMIN_B)) },
      journalEntry: { findUnique: journalFind },
      ledgerAccount: {
        upsert: vi.fn().mockRejectedValue(new Error("stop after idempotency lookup")),
      },
    });

    await expect(createAdminMarket({
      actorUserId: ADMIN_B,
      idempotencyKey: KEY,
      market: marketInput(),
    })).rejects.toThrow("stop after idempotency lookup");

    expect(journalFind).toHaveBeenCalledWith({
      where: {
        idempotencyScope_idempotencyKey: {
          idempotencyScope: `ADMIN_MARKET_CREATE:${ADMIN_B}`,
          idempotencyKey: KEY,
        },
      },
    });
  });

  it("keeps equal proposal keys isolated by proposer identity", async () => {
    const findUnique = vi.fn().mockResolvedValue(null);
    const market = {
      id: MARKET_ID,
      createdById: "different-admin",
      status: "OPEN",
      closesAt: new Date(Date.now() + 86_400_000),
      resolvesAt: new Date(Date.now() + 172_800_000),
    };
    runWith({
      user: { findUnique: vi.fn().mockResolvedValue(activeAdmin(ADMIN_B)) },
      marketResolutionProposal: { findUnique },
      market: { findUnique: vi.fn().mockResolvedValue(market) },
    });

    await expect(createResolutionProposal({
      actorUserId: ADMIN_B,
      marketId: MARKET_ID,
      idempotencyKey: KEY,
      resolution: { outcome: "YES", reason: "Evidence supports the stated outcome.", evidence: "https://example.invalid/evidence" },
    })).rejects.toMatchObject({ status: 409, code: "MARKET_NOT_RESOLVABLE" });

    expect(findUnique).toHaveBeenCalledWith({
      where: { proposerId_idempotencyKey: { proposerId: ADMIN_B, idempotencyKey: KEY } },
    });
  });

  it("does not let another administrator replay an approved resolution by reusing its key", async () => {
    runWith({
      user: { findUnique: vi.fn().mockResolvedValue(activeAdmin(ADMIN_B)) },
      marketResolutionProposal: {
        findUnique: vi.fn().mockResolvedValue({
          id: "proposal-hostile",
          proposerId: "admin-proposer",
          marketId: MARKET_ID,
          outcome: "YES",
          reason: "Evidence supports the result.",
          evidence: "https://example.invalid/evidence",
          status: "APPROVED",
          approverId: ADMIN_A,
          approvalIdempotencyKey: KEY,
          approvalRequestHash: "not-relevant-to-cross-user-check",
          settlementRun: { id: "run-hostile" },
          market: {},
        }),
      },
    });

    await expect(approveResolutionProposal({
      actorUserId: ADMIN_B,
      proposalId: "proposal-hostile",
      idempotencyKey: KEY,
    })).rejects.toMatchObject({ status: 409, code: "PROPOSAL_ALREADY_REVIEWED" });
  });

  it("forbids creator proposal and proposer self-approval before settlement mutation", async () => {
    const creatorTx = {
      user: { findUnique: vi.fn().mockResolvedValue(activeAdmin(ADMIN_A)) },
      marketResolutionProposal: { findUnique: vi.fn().mockResolvedValue(null) },
      market: { findUnique: vi.fn().mockResolvedValue({ id: MARKET_ID, createdById: ADMIN_A }) },
    };
    runWith(creatorTx);
    await expect(createResolutionProposal({
      actorUserId: ADMIN_A,
      marketId: MARKET_ID,
      idempotencyKey: KEY,
      resolution: { outcome: "NO", reason: "The creator must not decide this result.", evidence: "Source record" },
    })).rejects.toMatchObject({ status: 403, code: "CREATOR_CANNOT_PROPOSE" });

    const runCreate = vi.fn();
    runWith({
      user: { findUnique: vi.fn().mockResolvedValue(activeAdmin(ADMIN_A)) },
      marketResolutionProposal: {
        findUnique: vi.fn().mockResolvedValue({
          id: "proposal-self",
          proposerId: ADMIN_A,
          marketId: MARKET_ID,
          outcome: "YES",
          reason: "Self approval must fail.",
          evidence: "Source record",
          status: "PENDING",
          settlementRun: null,
          market: { createdById: "different-admin" },
        }),
      },
      marketSettlementRun: { create: runCreate },
    });
    await expect(approveResolutionProposal({
      actorUserId: ADMIN_A,
      proposalId: "proposal-self",
      idempotencyKey: KEY,
    })).rejects.toMatchObject({ status: 403, code: "SELF_APPROVAL_FORBIDDEN" });
    expect(runCreate).not.toHaveBeenCalled();
  });

  it("forbids the market creator from serving as the resolution approver", async () => {
    const runCreate = vi.fn();
    runWith({
      user: { findUnique: vi.fn().mockResolvedValue(activeAdmin(ADMIN_A)) },
      marketResolutionProposal: {
        findUnique: vi.fn().mockResolvedValue({
          id: "proposal-creator-review",
          proposerId: "different-proposer",
          marketId: MARKET_ID,
          outcome: "YES",
          reason: "Independent review is required.",
          evidence: "Source record",
          status: "PENDING",
          settlementRun: null,
          market: { createdById: ADMIN_A },
        }),
      },
      marketSettlementRun: { create: runCreate },
    });

    await expect(approveResolutionProposal({
      actorUserId: ADMIN_A,
      proposalId: "proposal-creator-review",
      idempotencyKey: KEY,
    })).rejects.toMatchObject({ status: 403, code: "CREATOR_CANNOT_RESOLVE" });
    expect(runCreate).not.toHaveBeenCalled();
  });

  it("forbids an administrator with legacy trading exposure from proposing a result", async () => {
    const proposalCreate = vi.fn();
    runWith({
      user: { findUnique: vi.fn().mockResolvedValue(activeAdmin(ADMIN_A)) },
      market: {
        findUnique: vi.fn().mockResolvedValue({
          id: MARKET_ID,
          createdById: "different-admin",
          status: "CLOSED",
          closesAt: new Date(Date.now() - 7_200_000),
          resolvesAt: new Date(Date.now() - 3_600_000),
        }),
      },
      trade: { count: vi.fn().mockResolvedValue(1) },
      orderFill: { count: vi.fn().mockResolvedValue(0) },
      marketResolutionProposal: {
        findUnique: vi.fn().mockResolvedValue(null),
        findFirst: vi.fn().mockResolvedValue(null),
        create: proposalCreate,
      },
    });

    await expect(createResolutionProposal({
      actorUserId: ADMIN_A,
      marketId: MARKET_ID,
      idempotencyKey: KEY,
      resolution: { outcome: "YES", reason: "A trader cannot propose this outcome.", evidence: "Source record" },
    })).rejects.toMatchObject({ status: 403, code: "PROPOSER_CONFLICT" });
    expect(proposalCreate).not.toHaveBeenCalled();
  });

  it("forbids an administrator with CLOB exposure from approving settlement", async () => {
    const marketClaim = vi.fn();
    const runCreate = vi.fn();
    runWith({
      user: { findUnique: vi.fn().mockResolvedValue(activeAdmin(ADMIN_B)) },
      marketResolutionProposal: {
        findUnique: vi.fn().mockResolvedValue({
          id: "proposal-trader-review",
          proposerId: ADMIN_A,
          marketId: MARKET_ID,
          outcome: "NO",
          reason: "An exposed reviewer must be rejected.",
          evidence: "Source record",
          status: "PENDING",
          settlementRun: null,
          market: {
            id: MARKET_ID,
            version: 3,
            createdById: "different-admin",
            status: "CLOSED",
            closesAt: new Date(Date.now() - 7_200_000),
            resolvesAt: new Date(Date.now() - 3_600_000),
          },
        }),
      },
      trade: { count: vi.fn().mockResolvedValue(0) },
      orderFill: { count: vi.fn().mockResolvedValue(1) },
      market: { updateMany: marketClaim },
      marketSettlementRun: { create: runCreate },
    });

    await expect(approveResolutionProposal({
      actorUserId: ADMIN_B,
      proposalId: "proposal-trader-review",
      idempotencyKey: KEY,
    })).rejects.toMatchObject({ status: 403, code: "RESOLVER_CONFLICT" });
    expect(marketClaim).not.toHaveBeenCalled();
    expect(runCreate).not.toHaveBeenCalled();
  });
});
