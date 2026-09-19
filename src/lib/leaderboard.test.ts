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

import { getLeaderboardRows, getLeaderboardPage } from "./leaderboard";

function user(id: string, username: string) {
  return {
    id,
    username,
    displayName: username,
    balanceMilli: 0n,
    realizedPnlMilli: 0n,
    profilePublic: false,
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

  it("preserves profile visibility so only public profiles become links", async () => {
    mocks.users.mockResolvedValue([
      { ...user("alice_id", "alice"), profilePublic: false },
      { ...user("bob_id", "bob"), profilePublic: true },
    ]);
    const rows = await getLeaderboardRows();
    expect(rows.find(row => row.username === "alice")?.profilePublic).toBe(false);
    expect(rows.find(row => row.username === "bob")?.profilePublic).toBe(true);
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

  it("sorts by displayed total rather than profit when actual grants differ", async () => {
    mocks.grants.mockResolvedValue([
      {actorUserId:"alice_id",metadata:JSON.stringify({amountMilli:"100000"})},
      {actorUserId:"bob_id",metadata:JSON.stringify({amountMilli:"1000000"})},
    ]);
    const rows=await getLeaderboardRows();
    expect(rows.map(row=>row.userId)).toEqual(["bob_id","alice_id"]);
    expect(rows[0]).toMatchObject({rank:1,equityMilli:900_000n,pnlMilli:-100_000n});
    expect(rows[1]).toMatchObject({rank:2,equityMilli:400_000n,pnlMilli:300_000n});
    const page=await getLeaderboardPage(2,1);
    expect(page.rows[0]).toMatchObject({rank:2,userId:"alice_id"});
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
  it("includes players beyond 100 with global ranks and stable ties", async () => {
    const players = Array.from({length: 123}, (_, i) => user(`id_${i}`, `player_${String(i).padStart(3, "0")}`));
    mocks.users.mockResolvedValue([...players].reverse());
    mocks.wallets.mockResolvedValue([]); mocks.grants.mockResolvedValue([]);
    mocks.activity.mockResolvedValue(new Map(players.map(p => [p.id, {trades: 0, marketsTraded: 0}])));
    const first = await getLeaderboardPage(1, 50);
    const second = await getLeaderboardPage(2, 50);
    const last = await getLeaderboardPage(3, 50);
    expect(first.total).toBe(123); expect(first.totalPages).toBe(3);
    expect(first.rows[0].rank).toBe(1); expect(second.rows[0].rank).toBe(51);
    expect(last.rows[0]).toMatchObject({rank: 101, username: "player_100", trades: 0});
    expect(last.rows.at(-1)?.rank).toBe(123);
    expect(new Set([...first.rows,...second.rows,...last.rows].map(p => p.userId)).size).toBe(123);
    expect((await getLeaderboardPage(9999,50)).page).toBe(3);
  });

});
