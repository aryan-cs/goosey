import { describe, expect, it, vi } from "vitest";
vi.mock("../src/lib/db", () => ({ db: {}, requireDatabaseStartup: vi.fn() }));
import { computeQuote } from "../src/lib/trading";
import { notificationFeathers } from "../src/lib/order-fill-notification";
import { buildReplay } from "./remove-production-bot-accounts";

const active = [
  ["test1", "cmu8wfl20000lic040xxx0dfm"], ["test11", "cmu8wrrxa000blb044szi94ys"],
  ["test12", "cmu8wtzsh002tjs04uk8vg2rh"], ["test13", "cmu8wudi3001jla04g3fbsukp"],
  ["test14", "cmu8wumg5000ul004vla4vs3s"], ["test15", "cmu8wuves002ylj04issdlei0"],
  ["test16", "cmu918w5e0000l404j96rh1ls"], ["test17", "cmu91alg3000jjo044ffxfe0h"],
  ["test18", "cmu91awly000sl404tp1v71mw"], ["test19", "cmu91b31b000wjp04ctis8wuk"],
  ["test20", "cmu91b8ri0017jp04v2peulaj"],
] as const;

function fixture() {
  const market = {
    id: "cmu8tqf120002gm6k0gw5vxgl", slug: "htn-2026-all-toronto-team-wins",
    pricingModel: "LMSR", executionBackend: "DATABASE", liquidityParameter: 80,
    payoutMilli: 100_000n, feeBps: 0, collateralAccountId: "collateral",
    collateralAccount: { id: "collateral", balanceMilli: 10_000_000n },
  };
  const first = computeQuote({ ...market, yesShares: 0, noShares: 0 }, "YES", "BUY", 10);
  const second = computeQuote({ ...market, yesShares: first.yesSharesAfter, noShares: first.noSharesAfter }, "NO", "BUY", 2);
  const at = [new Date("2026-09-19T20:00:00Z"), new Date("2026-09-19T20:01:00Z")];
  const trades = [
    { id: "bot-trade", userId: active[0][1], marketId: market.id, side: "YES", action: "BUY", quantity: 10, amountMilli: first.grossMilli, feeMilli: first.feeMilli, priceBeforeBps: first.probabilityYesBeforeBps, priceAfterBps: first.probabilityYesAfterBps, idempotencyKey: "bot", createdAt: at[0] },
    { id: "legit-trade", userId: "legitimate", marketId: market.id, side: "NO", action: "BUY", quantity: 2, amountMilli: second.grossMilli, feeMilli: second.feeMilli, priceBeforeBps: second.probabilityYesBeforeBps, priceAfterBps: second.probabilityYesAfterBps, idempotencyKey: "legit", createdAt: at[1] },
  ];
  const journal = (trade: typeof trades[number], version: number) => {
    const quote = trade.id === "bot-trade" ? first : second;
    const account = (id: string, ownerType: string, ownerId: string, purpose: string) => ({ id, ownerType, ownerId, purpose, balanceMilli: 0n, allowsNegative: false, status: "ACTIVE", createdAt: at[0], updatedAt: at[0] });
    return ({
    id: `journal-${trade.id}`, type: "BUY", status: "POSTED", referenceType: "TRADE", referenceId: trade.id,
    idempotencyScope: "scope", idempotencyKey: trade.id, actorUserId: trade.userId,
    metadata: JSON.stringify({ marketId: market.id, marketVersion: version }), createdAt: trade.createdAt, postedAt: trade.createdAt,
    postings: [
      { id: `posting-user-${trade.id}`, journalEntryId: `journal-${trade.id}`, ledgerAccountId: `wallet-${trade.userId}`, amountMilli: -quote.totalDebitMilli!, createdAt: trade.createdAt, ledgerAccount: account(`wallet-${trade.userId}`, "USER", trade.userId, "USER_FEATHERS") },
      { id: `posting-collateral-${trade.id}`, journalEntryId: `journal-${trade.id}`, ledgerAccountId: "collateral", amountMilli: quote.grossMilli, createdAt: trade.createdAt, ledgerAccount: account("collateral", "MARKET", market.id, "COLLATERAL") },
    ], orderFill: null,
  }); };
  const users: Array<{ id: string; username: string; email: string; displayName: string; passwordHash: string; emailVerifiedAt: null; role: string; status: string; bio: string; profilePublic: boolean; leaderboardVisible: boolean; notificationPreferences: string; balanceMilli: bigint; realizedPnlMilli: bigint; createdAt: Date; updatedAt: Date; lastActiveAt: Date }> = active.map(([username, id]) => ({
    id, username, email: `${username}@invalid.example`, displayName: username, passwordHash: "x", emailVerifiedAt: null,
    role: "USER", status: "ACTIVE", bio: "", profilePublic: false, leaderboardVisible: false,
    notificationPreferences: "{}", balanceMilli: 0n, realizedPnlMilli: 0n, createdAt: at[0], updatedAt: at[0], lastActiveAt: at[0],
  }));
  const position = (userId: string, quote: typeof first) => ({ id: `position-${userId}`, userId, marketId: market.id,
    yesShares: userId === "legitimate" ? 0 : 10, noShares: userId === "legitimate" ? 2 : 0,
    netCostMilli: quote.totalDebitMilli!, yesCostBasisMilli: userId === "legitimate" ? 0n : quote.totalDebitMilli!,
    noCostBasisMilli: userId === "legitimate" ? quote.totalDebitMilli! : 0n, realizedPnlMilli: 0n,
    reservedYesShares: 0, reservedNoShares: 0, createdAt: at[0], updatedAt: at[0] });
  const removedAudits = Array.from({ length: 9 }, (_, index) => {
    const number = index + 2;
    return {
      id: `audit-test${number}`,
      actorUserId: "goosey-market-publisher-v1",
      action: "TEST_ACCOUNT_REMOVED",
      entityType: "USER",
      entityId: `prior-test-${number}`,
      metadata: JSON.stringify({ formerUsername: `test${number}` }),
      createdAt: at[0],
    };
  });
  for (let number = 2; number <= 10; number++) users.push({
    ...users[0], id: `prior-test-${number}`, username: `deleted_prior_test_${number}`,
    email: `deleted-${number}@invalid.example`, displayName: "Deleted test account", status: "DELETED",
  });
  return {
    market: { ...market, yesShares: second.yesSharesAfter, noShares: second.noSharesAfter, volumeMilli: first.grossMilli + second.grossMilli, traderCount: 2, version: 2 },
    users, audits: removedAudits, trades, journals: trades.map(journal),
    positions: [position(active[0][1], first), position("legitimate", second)],
    snapshots: [
      { id: "snapshot-opening", marketId: market.id, yesProbabilityBps: 5_000, createdAt: new Date("2026-09-19T19:59:00Z") },
      { id: "snapshot-bot", marketId: market.id, yesProbabilityBps: first.probabilityYesAfterBps, createdAt: at[0] },
      { id: "snapshot-legit", marketId: market.id, yesProbabilityBps: second.probabilityYesAfterBps, createdAt: at[1] },
    ],
    requests: [],
    notifications: [{ id: "notification-legit", userId: "legitimate", type: "TRADE_CONFIRMED", title: "Bought 2 NO", body: `Your market trade was confirmed at an average of ${notificationFeathers(second.averagePriceMilli)} feathers per contract.`, href: `/markets/${market.slug}`, readAt: null, createdAt: at[1] }],
  };
}

describe("production bot cleanup replay", () => {
  it("removes reviewed identities and reprices surviving trades from the opening state", () => {
    const plan = buildReplay(fixture() as never);
    const expected = computeQuote({ ...fixture().market, yesShares: 0, noShares: 0 }, "NO", "BUY", 2);
    expect(plan.ordered.map(trade => trade.id)).toEqual(["bot-trade", "legit-trade"]);
    expect(plan.surviving.map(trade => trade.id)).toEqual(["legit-trade"]);
    expect(plan.replay[0].quote.grossMilli).toBe(expected.grossMilli);
    expect(plan.state).toEqual({ yesShares: 0, noShares: 2 });
    expect(plan.volumeMilli).toBe(expected.grossMilli);
  });

  it("refuses a broken journal market-version chain", () => {
    const input = fixture();
    input.journals[1].metadata = JSON.stringify({ marketVersion: 4 });
    expect(() => buildReplay(input as never)).toThrow(/marketVersion chain/);
  });

  it("refuses a stored execution whose financial fields do not reproduce", () => {
    const input = fixture();
    input.trades[0].amountMilli += 1n;
    expect(() => buildReplay(input as never)).toThrow(/does not reproduce/);
  });
});
