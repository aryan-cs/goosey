import { address, signature } from "@solana/kit";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  startup: vi.fn(), market: vi.fn(), identity: vi.fn(), events: vi.fn(), wires: vi.fn(), read: vi.fn(),
}));
vi.mock("@/lib/db", () => ({ db: {
  market: { findUnique: mocks.market }, solanaCustodyIdentity: { findUnique: mocks.identity },
  solanaProgramEvent: { findMany: mocks.events }, chainCommandSignedWire: { findMany: mocks.wires },
}, requireDatabaseStartup: mocks.startup }));
vi.mock("./escrow-read", () => ({ readGooseyEscrow: mocks.read }));

import { canonicalChainCommandJson } from "./chain-command";
import { listManagedSolanaOrders, projectManagedSolanaOrder } from "./managed-order-read";

const wallet = address("SysvarRent111111111111111111111111111111111");
const marketAddress = address("CgEGAD3EGLm63YaSx58sRiNPQmmxg8RqvqcxE3xThX8Q");
const transactionSignature = signature("3p4DHWsHj5XwKQkGo8HvHmBdKqecNN9dtp5CCvNcYwiQJWuXtZcgQabE1Jv3C7cGqYbKzK4iEjwPrTKBuewso73h");
const acceptedAt = new Date("2026-09-19T12:00:00.000Z");
const genesisHash = "Bax5P2GmYBb2P6UjJFmEVys7cpRzY4A85ncAJqtgvSsm";

function fixture() {
  return {
    order: {
      heapIndex: 2, slot: 9, id: 42n, sequence: 42n, ownerSeat: 1, wallet,
      outcome: "NO" as const, action: "BUY" as const, side: "ASK" as const,
      limitPrice: 350n, canonicalYesPrice: 650n, remaining: 3n, chainNotional: 1_001n,
      expiresAt: 2_000_000_000n, reserve: { cash: 1_000n, yes: 0n, no: 0n },
    },
    bookRevision: 17n,
    feeBps: 25,
    market: { id: "market_database_id", slug: "chain-market", title: "Chain market",
      payoutMilli: 1_000n, chainMarketId: "7" },
    event: {
      kind: "OrderExecuted" as const, market: marketAddress, wallet, orderId: "42", nonce: "4",
      filled: "2", canceled: "0", rested: "3", disposition: "2", outcome: "1", action: "0",
      price: "350", transactionSignature,
    },
    command: {
      transactionSignature,
      operation: "PLACE_ORDER" as const,
      requestJson: canonicalChainCommandJson({ version: 1, operation: "PLACE_ORDER", request: {
        marketId: "market_database_id", marketSlug: "chain-market", chainMarketId: "7",
        clientOrderId: "client-order-42", outcome: "NO", action: "BUY", limitPriceMilli: "350",
        quantity: 5, timeInForce: "GTC", postOnly: true, selfTradePrevention: "CANCEL_AGGRESSOR",
        expiresAt: "2033-05-18T03:33:20.000Z", cancelOnPause: true, reduceOnly: false,
      } }),
      acceptedAt,
      updatedAt: new Date("2026-09-19T12:00:05.000Z"),
    },
  };
}

describe("managed Solana ordinary-order projection", () => {
  it("emits the canonical g1 reference and the exact ordinary active-order shape", () => {
    const projected = projectManagedSolanaOrder(fixture());
    expect(projected).toMatchObject({
      orderId: "g1.chain-market.42",
      clientOrderId: "client-order-42",
      market: { slug: "chain-market", title: "Chain market", payoutMilli: 1_000n },
      outcome: "NO", action: "BUY", bookSide: "SELL", limitPriceMilli: 650n,
      initialQuantity: 5, remainingQuantity: 3, filledQuantity: 2, canceledQuantity: 0,
      status: "PARTIALLY_FILLED", timeInForce: "GTC", postOnly: true,
      selfTradePrevention: "CANCEL_AGGRESSOR", cumulativeFeeMilli: 3n,
      acceptedSequence: 42n, prioritySequence: 42n, version: 17,
      expiresAt: new Date("2033-05-18T03:33:20.000Z"), createdAt: acceptedAt,
    });
  });

  it.each([
    ["wrong owner event", (value: ReturnType<typeof fixture>) => { value.event.orderId = "41"; }],
    ["invented canceled quantity", (value: ReturnType<typeof fixture>) => { value.event.canceled = "1"; }],
    ["mismatched command price", (value: ReturnType<typeof fixture>) => {
      const envelope = JSON.parse(value.command.requestJson); envelope.request.limitPriceMilli = "351";
      value.command.requestJson = canonicalChainCommandJson(envelope);
    }],
    ["stale expiry metadata", (value: ReturnType<typeof fixture>) => {
      const envelope = JSON.parse(value.command.requestJson); envelope.request.expiresAt = null;
      value.command.requestJson = canonicalChainCommandJson(envelope);
    }],
  ])("fails closed for %s", (_name, mutate) => {
    const value = fixture(); mutate(value);
    expect(() => projectManagedSolanaOrder(value)).toThrow(/temporarily unavailable/i);
  });

  it("projects a replacement command without inventing the preserved side", () => {
    const value = fixture();
    const replacement = { ...value, command: { ...value.command, operation: "REPLACE_ORDER" as const,
      requestJson: canonicalChainCommandJson({ version: 1, operation: "REPLACE_ORDER", request: {
      marketId: "market_database_id", marketSlug: "chain-market", chainMarketId: "7", orderId: "8",
      expectedVersion: 16, clientOrderId: "replacement-order-42", limitPriceMilli: "350", quantity: 5,
      postOnly: false, selfTradePrevention: "CANCEL_RESTING", expiresAt: "2033-05-18T03:33:20.000Z",
      cancelOnPause: true,
    } }) } };
    expect(projectManagedSolanaOrder(replacement)).toMatchObject({ orderId: "g1.chain-market.42",
      outcome: "NO", action: "BUY", postOnly: false, selfTradePrevention: "CANCEL_RESTING" });
  });
});

describe("managed Solana exact-market listing", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.startup.mockResolvedValue(undefined);
    mocks.market.mockResolvedValue({ id: "market_database_id", slug: "chain-market", title: "Chain market",
      payoutMilli: 1_000n, executionBackend: "SOLANA", collateralAccountId: null,
      solanaBinding: { cluster: "localnet", genesisHash, programAddress: marketAddress,
        marketAddress, chainMarketId: "7" } });
    mocks.identity.mockResolvedValue({ walletAddress: wallet });
    mocks.read.mockResolvedValue({ market: marketAddress, wallet, orderBook: {
      reservesReconciled: true, revision: 17n, feeBps: 25, orders: [fixture().order],
    } });
    const payload = { action: "0", canceled: "0", disposition: "2", filled: "2", kind: "OrderExecuted",
      market: marketAddress, nonce: "4", orderId: "42", outcome: "1", price: "350", rested: "3", wallet };
    mocks.events.mockResolvedValue([{ eventKey: `${genesisHash}:${marketAddress}:${transactionSignature}:8`,
      logIndex: 8, invocationDepth: 1, payload: JSON.stringify(payload), schemaVersion: 1,
      marketAddress, walletAddress: wallet, receipt: { genesisHash, programAddress: marketAddress,
        signature: transactionSignature, slot: 99n, status: "VERIFIED_SUCCESS", decoderVersion: 1 } }]);
    mocks.wires.mockResolvedValue([{ transactionSignature, command: {
      operation: fixture().command.operation, requestJson: fixture().command.requestJson,
      acceptedAt, updatedAt: fixture().command.updatedAt,
    } }]);
  });

  it("joins finalized book, index event, and managed command without reading SQL orders", async () => {
    const result = await listManagedSolanaOrders({ userId: "user_12345678", marketSlug: "chain-market",
      statuses: ["OPEN", "PARTIALLY_FILLED"], limit: 50 }, { env: {
        GOOSEY_SOLANA_CLUSTER: "localnet", GOOSEY_SOLANA_RPC_URL: "http://127.0.0.1:8899",
        GOOSEY_SOLANA_GENESIS_HASH: genesisHash, GOOSEY_SOLANA_PROGRAM_ID: marketAddress,
      } });
    expect(result).toMatchObject({ orders: [{ orderId: "g1.chain-market.42", status: "PARTIALLY_FILLED",
      version: 17 }], nextCursor: null });
    expect(mocks.events).toHaveBeenCalledWith(expect.objectContaining({ take: 10_001,
      where: expect.objectContaining({ marketAddress, walletAddress: wallet }) }));
    expect(mocks.wires).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({
      transactionSignature: { in: [transactionSignature] }, command: expect.objectContaining({ actorId: "user_12345678" }),
    }) }));
  });

  it("fails closed when the index cannot bind the live order to its managed command", async () => {
    mocks.events.mockResolvedValue([]);
    await expect(listManagedSolanaOrders({ userId: "user_12345678", marketSlug: "chain-market", limit: 50 },
      { env: { GOOSEY_SOLANA_CLUSTER: "localnet", GOOSEY_SOLANA_RPC_URL: "http://127.0.0.1:8899",
        GOOSEY_SOLANA_GENESIS_HASH: genesisHash, GOOSEY_SOLANA_PROGRAM_ID: marketAddress } }))
      .rejects.toMatchObject({ status: 503, code: "CHAIN_ORDER_READ_UNAVAILABLE" });
    expect(mocks.wires).not.toHaveBeenCalled();
  });
});
