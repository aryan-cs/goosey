import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  users: vi.fn(),
  wallets: vi.fn(),
  grants: vi.fn(),
  reservations: vi.fn(),
  activity: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  db: {
    user: { findMany: mocks.users },
    ledgerAccount: { findMany: mocks.wallets },
    journalEntry: { findMany: mocks.grants },
    orderReservation: { findMany: mocks.reservations },
  },
}));

vi.mock("@/lib/trading-activity", () => ({
  loadTradingActivity: mocks.activity,
}));

vi.mock("@/lib/serializable-transaction", () => ({
  runSerializableTransaction: vi.fn(
    (client: unknown, operation: (transactionClient: unknown) => unknown) => operation(client),
  ),
}));

import { getLeaderboardRows } from "./leaderboard";

function user(id: string, username: string) {
  return {
    id,
    username,
    displayName: username,
    balanceMilli: 0n,
    realizedPnlMilli: 0n,
    positions: [],
    _count: { trades: 0 },
  };
}

describe("leaderboard reserved cash", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.users.mockResolvedValue([
      user("alice_id", "alice"),
      user("bob_id", "bob"),
    ]);
    mocks.wallets.mockResolvedValue([
      { ownerId: "alice_id", balanceMilli: 400_000n },
      { ownerId: "bob_id", balanceMilli: 900_000n },
    ]);
    mocks.grants.mockResolvedValue([
      { actorUserId: "alice_id", metadata: JSON.stringify({ amountMilli: "1000000" }) },
      { actorUserId: "bob_id", metadata: JSON.stringify({ amountMilli: "1000000" }) },
    ]);
    mocks.reservations.mockResolvedValue([]);
    mocks.activity.mockResolvedValue(new Map([
      ["alice_id", { trades: 0, marketsTraded: 0 }],
      ["bob_id", { trades: 0, marketsTraded: 0 }],
    ]));
  });

  it("ranks active players even when their legacy leaderboard preference and public profile are disabled", async () => {
    mocks.users.mockResolvedValue([
      { ...user("alice_id", "alice"), role: "USER", status: "ACTIVE", leaderboardVisible: false, profilePublic: false },
      { ...user("bob_id", "bob"), role: "USER", status: "ACTIVE", leaderboardVisible: true, profilePublic: true },
    ]);

    const rows = await getLeaderboardRows();

    // The database must still exclude inactive and non-player accounts, without
    // requiring a privacy preference or a first trade to participate.
    expect(mocks.users.mock.calls[0][0].where).toEqual({ status: "ACTIVE", role: "USER" });
    expect(rows.map(row => row.userId)).toEqual(["bob_id", "alice_id"]);
    expect(rows.find(row => row.userId === "alice_id")).toMatchObject({
      username: "alice", rank: 2, trades: 0, marketsTraded: 0,
      equityMilli: 400_000n, pnlMilli: -600_000n,
    });
  });

  it("keeps principal and fees held in BUY escrow in equity, PnL, and rank", async () => {
    mocks.reservations.mockResolvedValue([
      // This is the actual reservation ledger balance: 500 feathers of
      // principal plus 100 feathers of reserved fees.
      { userId: "alice_id", cashAccount: { balanceMilli: 600_000n } },
    ]);

    const rows = await getLeaderboardRows();

    expect(mocks.reservations).toHaveBeenCalledWith({
      where: {
        userId: { in: ["alice_id", "bob_id"] },
        cashAccountId: { not: null },
      },
      select: {
        userId: true,
        cashAccount: { select: { balanceMilli: true } },
      },
    });
    expect(rows).toEqual([
      expect.objectContaining({
        rank: 1,
        userId: "alice_id",
        equityMilli: 1_000_000n,
        pnlMilli: 0n,
      }),
      expect.objectContaining({
        rank: 2,
        userId: "bob_id",
        equityMilli: 900_000n,
        pnlMilli: -100_000n,
      }),
    ]);
  });

  it("keeps the public leaderboard available when a participant buys a zero-liquidation-value LMSR position", async () => {
    mocks.users.mockResolvedValue([
      {
        ...user("alice_id", "alice"),
        positions: [{
          id: "position-a", userId: "alice_id", marketId: "market-a",
          yesShares: 0, noShares: 1,
          market: {
            id: "market-a", pricingModel: "LMSR", yesShares: 1_000, noShares: 1,
            liquidityParameter: 40, payoutMilli: 100_000n, feeBps: 100,
            status: "OPEN", resolution: null,
          },
        }],
      },
      user("bob_id", "bob"),
    ]);

    const rows = await getLeaderboardRows();

    expect(rows).toHaveLength(2);
    expect(rows.find((row) => row.userId === "alice_id")).toMatchObject({
      equityMilli: 400_000n, pnlMilli: -600_000n,
    });
  });

  it("sums multiple cash escrows and safely ignores null or non-cash reservations", async () => {
    mocks.wallets.mockResolvedValue([
      { ownerId: "alice_id", balanceMilli: 700_000n },
      { ownerId: "bob_id", balanceMilli: 900_000n },
    ]);
    mocks.reservations.mockResolvedValue([
      { userId: "alice_id", cashAccount: { balanceMilli: 125_000n } },
      { userId: "alice_id", cashAccount: { balanceMilli: 175_000n } },
      // Share-backed SELL reservations have no cash account and must not
      // affect leaderboard equity if a defensive mock/database row is null.
      { userId: "alice_id", cashAccount: null },
    ]);

    const rows = await getLeaderboardRows();

    expect(rows.find((row) => row.userId === "alice_id")).toMatchObject({
      rank: 1,
      equityMilli: 1_000_000n,
      pnlMilli: 0n,
    });
    expect(rows.find((row) => row.userId === "bob_id")).toMatchObject({
      rank: 2,
      equityMilli: 900_000n,
      pnlMilli: -100_000n,
    });
  });
});
