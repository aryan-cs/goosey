import { describe, expect, it } from "vitest";
import { DEVELOPMENT_PARTICIPANTS } from "./development-profiles";
import { validateDevelopmentData } from "./development-data-validation";

const now = new Date("2026-09-19T12:00:00.000Z");
const openedAt = new Date("2026-09-01T12:00:00.000Z");
const tradeAt = new Date("2026-09-10T12:00:00.000Z");
const closesAt = new Date("2026-09-20T12:00:00.000Z");
const resolvesAt = new Date("2026-09-21T12:00:00.000Z");

function fixture() {
  const users = DEVELOPMENT_PARTICIPANTS.map((profile, index) => ({
    id: `user-${index + 1}`, email: profile.email, username: profile.username,
    role: "USER", balanceMilli: 1_000_000n, createdAt: openedAt,
  }));
  const wallets = users.map((user, index) => ({
    id: `wallet-${index + 1}`, ownerType: "USER", ownerId: user.id,
    purpose: "USER_FEATHERS", status: "ACTIVE", allowsNegative: false,
    balanceMilli: 1_000_000n, createdAt: openedAt,
  }));
  const issuance = {
    id: "issuance", ownerType: "SYSTEM", ownerId: "issuance", purpose: "ISSUANCE",
    status: "ACTIVE", allowsNegative: true,
    balanceMilli: -BigInt(users.length) * 1_000_000n, createdAt: openedAt,
  };
  const welcome = users.map((user, index) => ({
    id: `welcome-${index + 1}`, type: "WELCOME_GRANT", status: "POSTED",
    referenceType: "USER", referenceId: user.id, actorUserId: user.id,
    createdAt: openedAt, postedAt: openedAt,
    postings: [
      { id: `welcome-issuance-${index + 1}`, ledgerAccountId: issuance.id, amountMilli: -1_000_000n, createdAt: openedAt },
      { id: `welcome-wallet-${index + 1}`, ledgerAccountId: wallets[index].id, amountMilli: 1_000_000n, createdAt: openedAt },
    ],
  }));
  const market = (number: number) => {
    const trades = users.map((user, index) => ({
      id: `trade-${number}-${index + 1}`, userId: user.id, createdAt: tradeAt,
      quantity: 1, amountMilli: 1n, feeMilli: 0n, priceBeforeBps: 5_000,
      priceAfterBps: 5_000, idempotencyKey: `simulation-trade-${number}-${index + 1}`,
    }));
    return {
      id: `market-${number}`, slug: `dev-market-${number}`, createdAt: openedAt,
      closesAt, resolvesAt, resolvedAt: null, status: "OPEN", resolution: null,
      volumeMilli: BigInt(trades.length), yesShares: 0, noShares: 0, positions: [], pricingModel: "LMSR",
      traderCount: trades.length, liquidityParameter: 80, payoutMilli: 100_000n, feeBps: 50,
      trades, settlements: [], resolutionProposals: [],
      priceHistory: [
        { id: `opening-${number}`, createdAt: openedAt, yesProbabilityBps: 5_000 },
        { id: `snapshot-${number}`, createdAt: tradeAt, yesProbabilityBps: 5_000 },
      ],
    };
  };
  const markets = [market(1), market(2)];
  const tradeJournals = markets.flatMap(item => item.trades.map(trade => ({
    id: `journal-${trade.id}`, type: "BUY", status: "POSTED", referenceType: "TRADE",
    referenceId: trade.id, actorUserId: trade.userId, createdAt: tradeAt, postedAt: tradeAt, postings: [],
  })));
  const state = { users, accounts: [...wallets, issuance], journals: [...welcome, ...tradeJournals], markets };
  return {
    state,
    client: {
      user: { findMany: async () => state.users },
      ledgerAccount: { findMany: async () => state.accounts },
      journalEntry: { findMany: async () => state.journals },
      market: { findMany: async () => state.markets },
      marketEvent: { findMany: async () => [] },
    } as never,
  };
}

describe("development synthetic participant validation", () => {
  it("requires every known participant to have executions in at least two markets and reports target residuals", async () => {
    const { client } = fixture();
    const first = DEVELOPMENT_PARTICIPANTS[0];
    const result = await validateDevelopmentData(client, {
      asOf: now,
      targetEquityMilliByEmail: { [first.email]: 999_500n },
    });

    expect(result.errors).toEqual([]);
    expect(result.targetEquityResiduals).toEqual([expect.objectContaining({
      email: first.email, targetMilli: "999500", actualMilli: "1000000",
      residualMilli: "500", absoluteResidualMilli: "500", withinTolerance: true,
    })]);
  });

  it("rejects one-market histories, administrative balance shortcuts, and residuals outside tolerance", async () => {
    const { client, state } = fixture();
    const first = DEVELOPMENT_PARTICIPANTS[0];
    const user = state.users[0];
    state.markets[1].trades = state.markets[1].trades.filter(trade => trade.userId !== user.id);
    state.markets[1].traderCount -= 1;
    state.journals.push({
      id: "shortcut", type: "ADMIN_GRANT", status: "POSTED", referenceType: "USER",
      referenceId: user.id, actorUserId: "admin", createdAt: openedAt, postedAt: openedAt, postings: [],
    });

    const result = await validateDevelopmentData(client, {
      asOf: now,
      targetEquityMilliByEmail: { [first.email]: 997_999n },
      targetEquityToleranceMilli: 1_000n,
    });

    expect(result.errors).toContain(`participant ${first.email}: traded in fewer than two markets`);
    expect(result.errors).toContain(`participant ${first.email}: prohibited ADMIN_GRANT shortcut`);
    expect(result.errors).toContain(`participant ${first.email}: target equity residual 2001 milli-feathers exceeds tolerance 1000`);
    expect(result.targetEquityResiduals[0]).toMatchObject({ residualMilli: "2001", withinTolerance: false });
  });
});
