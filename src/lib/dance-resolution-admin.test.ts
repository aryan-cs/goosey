import { beforeEach, describe, expect, it, vi } from "vitest";

const { tx } = vi.hoisted(() => ({ tx: {
  user: { findUnique: vi.fn() },
  market: { findUnique: vi.fn(), findMany: vi.fn() },
  marketEvent: { updateMany: vi.fn() },
  marketResolutionProposal: { findUnique: vi.fn(), findFirst: vi.fn(), create: vi.fn() },
  trade: { count: vi.fn() },
  orderFill: { count: vi.fn() },
  position: { count: vi.fn() },
} }));
vi.mock("./serializable-transaction", () => ({ runSerializableTransaction: (_client: unknown, operation: (client: unknown) => unknown) => operation(tx) }));
vi.mock("./market-service", async (importOriginal) => ({ ...await importOriginal<typeof import("./market-service")>(), consumeRateLimit: vi.fn() }));

import { approveResolutionProposal, createResolutionProposal } from "./admin-service";

const market = {
  id: "dab", slug: "htn-2026-winner-first-dance-dab", eventId: "event", createdById: "creator",
  status: "CLOSED", closesAt: new Date(0), resolvesAt: new Date(0), version: 1,
};

beforeEach(() => {
  vi.clearAllMocks();
  tx.user.findUnique.mockResolvedValue({ role: "ADMIN", status: "ACTIVE" });
  tx.market.findUnique.mockResolvedValue(market);
  tx.trade.count.mockResolvedValue(0);
  tx.orderFill.count.mockResolvedValue(0);
  tx.marketEvent.updateMany.mockResolvedValue({ count: 1 });
  tx.market.findMany.mockResolvedValue(["worm", "dab", "floss", "none"].map((key) => ({
    id: key, slug: `htn-2026-winner-first-dance-${key}`, resolution: key === "worm" ? "YES" : null, resolutionProposals: [],
  })));
});

describe("admin resolution first-dance hooks", () => {
  it("blocks a second winner before persisting its proposal", async () => {
    tx.marketResolutionProposal.findUnique.mockResolvedValue(null);
    tx.marketResolutionProposal.findFirst.mockResolvedValue(null);
    await expect(createResolutionProposal({ actorUserId: "proposer", marketId: "dab", idempotencyKey: "proposal-2", resolution: { outcome: "YES", reason: "Observed on stage", evidence: "Official recording" } })).rejects.toMatchObject({ code: "DANCE_OUTCOME_CONFLICT" });
    expect(tx.marketResolutionProposal.create).not.toHaveBeenCalled();
  });
  it("revalidates old pending proposals before approving or scheduling payouts", async () => {
    tx.marketResolutionProposal.findUnique.mockResolvedValue({
      id: "proposal", marketId: "dab", proposerId: "proposer", status: "PENDING", outcome: "YES",
      reason: "Observed on stage", evidence: "Official recording", market, settlementRun: null,
    });
    await expect(approveResolutionProposal({ actorUserId: "reviewer", proposalId: "proposal", idempotencyKey: "approve-2" })).rejects.toMatchObject({ code: "DANCE_OUTCOME_CONFLICT" });
    expect(tx.position.count).not.toHaveBeenCalled();
  });
});
