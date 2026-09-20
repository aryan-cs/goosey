import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  market: { findMany: vi.fn(), findUnique: vi.fn() },
  watchlistEntry: { findMany: vi.fn() },
  position: { findMany: vi.fn() },
  orderReservation: { findMany: vi.fn() },
  ledgerAccount: { findUnique: vi.fn() },
  user: { findFirst: vi.fn(), findUnique: vi.fn(), findUniqueOrThrow: vi.fn() },
  trade: { findMany: vi.fn(), groupBy: vi.fn() },
  marketOrder: { findMany: vi.fn() },
  orderFill: { count: vi.fn(), findMany: vi.fn() },
  marketEvent: { findUnique: vi.fn() },
  marks: vi.fn(), valuations: vi.fn(), serverUser: vi.fn(),
}));
vi.mock("./db", () => ({ db: state }));
vi.mock("./serializable-transaction", () => ({ runSerializableTransaction: (_db: unknown, operation: (tx: unknown) => unknown) => operation(state) }));
vi.mock("./server-session", () => ({ getServerUser: state.serverUser }));
vi.mock("./auth", () => ({ requiresEmailVerification: () => false }));
vi.mock("./market-marks", () => ({ loadMarketMarks: state.marks }));
vi.mock("./position-valuation", () => ({ loadPositionValuations: state.valuations }));
vi.mock("./leaderboard", () => ({ getLeaderboardRows: async () => [] }));
vi.mock("./public-trade-activity", () => ({ loadPublicTradeActivity: async () => [] }));
vi.mock("next/navigation", () => ({
  notFound: () => { throw new Error("NEXT_NOT_FOUND"); },
  redirect: (url: string) => { throw new Error(`NEXT_REDIRECT:${url}`); },
  useRouter: vi.fn(), usePathname: () => "/", useSearchParams: () => new URLSearchParams(),
}));

import HomePage from "../app/page";
import MarketsPage from "../app/markets/page";
import MarketPage from "../app/markets/[slug]/page";
import WatchlistPage from "../app/watchlist/page";
import PortfolioPage from "../app/portfolio/page";
import UserProfilePage from "../app/users/[username]/page";

const boundary = { executionBackend: "DATABASE", collateralAccountId: { not: null } };
beforeEach(() => {
  vi.clearAllMocks();
  state.market.findMany.mockResolvedValue([]);
  state.market.findUnique.mockResolvedValue(null);
  state.watchlistEntry.findMany.mockResolvedValue([]);
  state.position.findMany.mockResolvedValue([]);
  state.orderReservation.findMany.mockResolvedValue([]);
  state.ledgerAccount.findUnique.mockResolvedValue({ balanceMilli: 0n, postings: [] });
  state.user.findUniqueOrThrow.mockResolvedValue({ balanceMilli: 0n });
  state.serverUser.mockResolvedValue({ id: "viewer", role: "USER", emailVerifiedAt: new Date() });
  state.marks.mockResolvedValue(new Map());
  state.valuations.mockResolvedValue(new Map());
  state.user.findUnique.mockResolvedValue({ id: "profile", role: "USER", profilePublic: true,
    username: "profile", displayName: "Profile", bio: "", createdAt: new Date(), realizedPnlMilli: 0n,
    _count: { positions: 0, trades: 0, comments: 0 }, comments: [] });
  state.orderFill.count.mockResolvedValue(0);
  state.user.findFirst.mockResolvedValue({ id: "profile", role: "USER", profilePublic: false, balanceMilli: 0n,
    username: "profile", displayName: "Profile", bio: "", createdAt: new Date(), positions: [] });
  state.trade.findMany.mockResolvedValue([]);
  state.trade.groupBy.mockResolvedValue([]);
  state.marketOrder.findMany.mockResolvedValue([]);
  state.orderFill.findMany.mockResolvedValue([]);
});

describe("legacy server page SQL query boundaries (mocked reads)", () => {
  it("filters home cards before marks while retaining live-only membership", async () => {
    await HomePage();
    expect(state.market.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { ...boundary, status: "OPEN", closesAt: { gt: expect.any(Date) } }, take: 12,
    }));
    expect(state.marks).toHaveBeenCalledWith(state, []);
  });
  it("combines browse filters without allowing query text to replace the backend", async () => {
    await MarketsPage({ searchParams: Promise.resolve({ q: "goose", category: "Campus", sort: "closing" }) });
    expect(state.market.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: {
      ...boundary, status: { in: ["OPEN", "PAUSED", "CLOSED", "RESOLVED", "VOID"] }, category: "Campus",
      OR: [{ title: { contains: "goose" } }, { shortTitle: { contains: "goose" } }, { description: { contains: "goose" } }],
    } }));
    expect(state.market.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({
      executionBackend: "SOLANA", collateralAccountId: null, status: "OPEN", category: "Campus",
    }) }));
    expect(state.marks).toHaveBeenCalledWith(state, [], expect.any(Date));
  });
  it.each(["USER", "ADMIN"])("legacy detail excludes chain slugs even for %s", async (role) => {
    state.serverUser.mockResolvedValue({ id: "viewer", role });
    await expect(MarketPage({ params: Promise.resolve({ slug: "chain-market" }), searchParams: Promise.resolve({}) })).rejects.toThrow("NEXT_NOT_FOUND");
    expect(state.market.findUnique).toHaveBeenCalledWith(expect.objectContaining({ where: { slug: "chain-market", AND: [boundary] } }));
    expect(state.marks).not.toHaveBeenCalled();
  });
  it("keeps database DRAFT detail hidden from ordinary viewers before marks", async () => {
    state.market.findUnique.mockResolvedValue({ status: "DRAFT", executionBackend: "DATABASE", collateralAccountId: "cash" });
    await expect(MarketPage({ params: Promise.resolve({ slug: "draft-market" }), searchParams: Promise.resolve({}) })).rejects.toThrow("NEXT_NOT_FOUND");
    expect(state.marks).not.toHaveBeenCalled();
  });
  it.each(["USER", "ADMIN"])("omits chain watchlist cards for %s without deleting saved entries", async (role) => {
    state.serverUser.mockResolvedValue({ id: "viewer", role });
    await WatchlistPage();
    expect(state.watchlistEntry.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: {
      userId: "viewer", market: { ...boundary, ...(role === "ADMIN" ? {} : { status: { not: "DRAFT" } }) },
    } }));
    expect(state.marks).toHaveBeenCalledWith(state, []);
    // Mock delegates expose only reads: any attempted delete/update fails the test.
  });
  it("filters portfolio holdings and reservation cash before SQL valuation", async () => {
    await PortfolioPage({ searchParams: Promise.resolve({}) });
    expect(state.position.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: {
      userId: "viewer", market: boundary, OR: [{ yesShares: { gt: 0 } }, { noShares: { gt: 0 } }],
    } }));
    expect(state.orderReservation.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: {
      userId: "viewer", market: boundary, cashAccountId: { not: null },
    } }));
    expect(state.valuations).toHaveBeenCalledWith(state, []);
  });
  it("filters a public trading profile to active users and published database markets", async () => {
    await UserProfilePage({ params: Promise.resolve({ username: "PROFILE" }) });
    const query = state.user.findFirst.mock.calls[0][0];
    expect(query.where).toEqual({ username: "profile", role: { in: ["USER", "ADMIN"] }, status: "ACTIVE" });
    expect(query.select.positions.where.market).toEqual({ ...boundary, status: { not: "DRAFT" } });
    expect(state.trade.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ market: { ...boundary, status: { not: "DRAFT" } } }) }));
    expect(state.orderFill.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ market: { ...boundary, status: { not: "DRAFT" } } }) }));
  });
});
