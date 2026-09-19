import { beforeEach, describe, expect, it, vi } from "vitest";

// Service-level mocked transaction proof; no claims of actual chain/DB execution.
const state = vi.hoisted(() => ({ tx: {} as Record<string, Record<string, ReturnType<typeof vi.fn>>> }));
vi.mock("./serializable-transaction", () => ({
  runSerializableTransaction: (_client: unknown, operation: (tx: unknown) => unknown) => operation(state.tx),
}));
vi.mock("./market-service", async (original) => ({
  ...await original<typeof import("./market-service")>(),
  consumeRateLimit: vi.fn(),
  prisma: {
    orderCommand: { findUnique: vi.fn().mockResolvedValue(null) },
    idempotencyRequest: { findUnique: vi.fn().mockResolvedValue(null) },
  },
}));
import { assertDatabaseFinancialMarket } from "./market-backend";
import { createTradeQuote, executeTrade } from "./trading";
import { redeemCompleteSet } from "./redemption";
import { appendAuthoritativeFillSnapshot, cancelAllOrders, cancelOrder, drainMarketOrderBook, expireOrders, placeOrder, replaceOrder } from "./order-exchange";
import { approveResolutionProposal, createResolutionProposal, rejectResolutionProposal, transitionAdminMarket } from "./admin-service";
import { claimSettlementRun, processClaimedBatch, processSettlementRun } from "./settlement-service";

const USER = "participant_123", MARKET = "market_chain_123", KEY = "idempotency_123";
const envelope = { userId: USER, idempotencyKey: KEY };
const admin = { actorUserId: "admin_123", marketId: MARKET, idempotencyKey: KEY };
const order = { id: "order_chain_123", marketId: MARKET, userId: USER, status: "OPEN", version: 0,
  remainingQuantity: 1, timeInForce: "GTC", expiresAt: null, reservation: {} };
const financialTables = ["ledgerAccount", "journalEntry", "ledgerPosting", "position", "trade", "market",
  "marketOrder", "orderReservation", "orderFill", "orderCommand", "orderEvent", "marketPriceSnapshot",
  "marketResolutionProposal", "marketSettlementRun", "settlement", "user"];
const mutations = ["create", "createMany", "update", "updateMany", "upsert", "delete", "deleteMany"];

beforeEach(() => {
  state.tx = {};
  for (const table of [...financialTables, "idempotencyRequest", "tradeQuote"]) {
    state.tx[table] = {};
    for (const method of [...mutations, "findUnique", "findFirst", "findMany", "count"])
      state.tx[table][method] = vi.fn().mockResolvedValue(null);
  }
  const market = { id: MARKET, executionBackend: "SOLANA", collateralAccountId: null, collateralAccount: null,
    pricingModel: "ORDER_BOOK", status: "OPEN", version: 0 };
  state.tx.market.findUnique.mockResolvedValue(market);
  state.tx.user.findUnique.mockResolvedValue({ id: USER, role: "USER", status: "ACTIVE", emailVerifiedAt: new Date() });
  state.tx.marketOrder.findFirst.mockResolvedValue({ ...order, market });
  state.tx.marketOrder.findUnique.mockResolvedValue({ ...order, market });
  state.tx.marketOrder.findMany.mockResolvedValue([{ ...order, market }]);
  state.tx.marketResolutionProposal.findUnique.mockResolvedValue({ id: "proposal_123", market, status: "PENDING" });
  state.tx.marketSettlementRun.findUnique.mockResolvedValue({ id: "run_chain_123", market, status: "READY" });
});

function untouched() {
  for (const table of financialTables) for (const method of mutations)
    expect(state.tx[table][method], `${table}.${method}`).not.toHaveBeenCalled();
}
function operator() { state.tx.user.findUnique.mockResolvedValue({ role: "ADMIN", status: "ACTIVE" }); }
const cases: Array<[string, () => Promise<unknown>]> = [
  ["LMSR quote", () => createTradeQuote({ userId: USER, marketId: MARKET, side: "YES", action: "BUY", quantity: 1 })],
  ["LMSR execution", () => executeTrade({ ...envelope, marketId: MARKET, quoteId: "quote_123" })],
  ["complete-set redemption", () => redeemCompleteSet({ ...envelope, marketId: MARKET, quantity: 1, marketVersion: 0 })],
  ["place order", () => placeOrder({ ...envelope, request: { marketId: MARKET, clientOrderId: "client_order_123", outcome: "YES", action: "BUY", limitPriceMilli: "40000", quantity: 1 } })],
  ["cancel order", () => cancelOrder({ ...envelope, request: { orderId: order.id, expectedVersion: 0 } })],
  ["replace order", () => replaceOrder({ ...envelope, request: { orderId: order.id, expectedVersion: 0, clientOrderId: "replacement_123", limitPriceMilli: "40000", quantity: 1 } })],
  ["bulk explicit market", () => cancelAllOrders({ ...envelope, request: { marketSlug: "chain-market" } })],
  ["bulk defense against mis-scoped result", () => cancelAllOrders({ ...envelope, request: {} })],
  ["lifecycle drain", () => drainMarketOrderBook(state.tx as never, { marketId: MARKET, actorUserId: "admin_123", reason: "MARKET_CLOSED" })],
  ["fill snapshot", () => appendAuthoritativeFillSnapshot(state.tx as never, MARKET, 100000n, [{ priceMilli: 40000n }], new Date())],
  ["admin lifecycle", () => { operator(); return transitionAdminMarket({ ...admin, action: "CLOSE", reason: "closed", expectedVersion: 0 }); }],
  ["resolution proposal", () => { operator(); state.tx.marketResolutionProposal.findUnique.mockResolvedValue(null); return createResolutionProposal({ ...admin, resolution: { outcome: "YES", reason: "Official result", evidence: "Official evidence" } }); }],
  ["resolution approval", () => { operator(); return approveResolutionProposal({ ...admin, proposalId: "proposal_123" }); }],
  ["resolution rejection", () => { operator(); return rejectResolutionProposal({ ...admin, proposalId: "proposal_123", note: "Rejected" }); }],
  ["settlement claim", () => { operator(); return claimSettlementRun({ ...admin, runId: "run_chain_123" }); }],
  ["settlement batch", () => { operator(); return processClaimedBatch({ ...admin, runId: "run_chain_123", claimToken: "claim", batchSize: 1 }); }],
  ["settlement orchestration", () => { operator(); return processSettlementRun({ ...admin, runId: "run_chain_123", batchSize: 1 }); }],
];
describe("chain markets cannot enter SQL financial services", () => {
  it.each(cases)("rejects %s before financial mutations", async (_label, operation) => {
    await expect(operation()).rejects.toMatchObject({ code: "MARKET_BACKEND_MISMATCH" });
    untouched();
  });
  it("expiry filters candidates and rechecks the loaded market before releasing reserves", async () => {
    state.tx.marketOrder.findUnique.mockResolvedValue({ ...order, expiresAt: new Date(0), market: { executionBackend: "SOLANA", collateralAccountId: null } });
    const result = await expireOrders(state.tx as never);
    expect(result.expired).toBe(0);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0].error).toMatchObject({ code: "MARKET_BACKEND_MISMATCH" });
    expect(state.tx.marketOrder.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ market: { executionBackend: "DATABASE", collateralAccountId: { not: null } } }) }));
    untouched();
  });
  it("does not accept chain rows even if an accidental collateral ID is supplied", () => {
    expect(() => assertDatabaseFinancialMarket({ executionBackend: "SOLANA", collateralAccountId: "legacy-cash" })).toThrow();
  });
});
