import { address, getBase58Decoder, signature } from "@solana/kit";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { TransactionRunner } from "@/lib/serializable-transaction";
import type { SolanaRuntime } from "./runtime";

const mocks = vi.hoisted(() => ({ startup: vi.fn(), cursor: vi.fn(), events: vi.fn(), transaction: vi.fn() }));
vi.mock("@/lib/db", () => ({ db: { $transaction: mocks.transaction }, requireDatabaseStartup: mocks.startup }));
vi.mock("@/lib/market-service", () => ({ ApiError: class extends Error {
  constructor(public status: number, public code: string, message: string) { super(message); }
} }));

import { parseSolanaLeaderboardQuery, readSolanaLeaderboard } from "./leaderboard";

const programAddress = address("CgEGAD3EGLm63YaSx58sRiNPQmmxg8RqvqcxE3xThX8Q");
const genesisHash = "AjRRXmyGBFhUtVWWp5xYXYKAP4Ha8vyTDRNVrkTVA2DE";
const runtime: SolanaRuntime = { cluster: "localnet", rpcUrl: "http://127.0.0.1:20999", genesisHash, programAddress };
const U64_MAX = (1n << 64n) - 1n;
const sig = (seed: number) => signature(getBase58Decoder().decode(new Uint8Array(64).fill(seed)));
const start = sig(1), head = sig(2), before = sig(3);
const walletA = address("8JkL3BGoGCgSAXZyJZbKDKCJvijocvLBaJcqF7iiM3fT");
const walletB = address("5YLLBdpna7xmMBszQFyuEDaUEEiMziwdnjZeax3Ur8AH");
const marketA = address("7dHbWXadbuuegSmaednCrB3hVc5S98SmjMHhdHmCAJQY");
const marketB = address("CsRarDRUVmDBSMtf5erEoexJoVf3k2D2AnjWPdYfgJtj");
const updatedAt = new Date("2026-09-19T12:00:00.000Z");

const canonicalJson = (value: Record<string, unknown>) => JSON.stringify(
  Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right))),
);
function payload(overrides: Record<string, unknown> = {}) {
  return canonicalJson({ action: "0", canceled: "0", disposition: "0", filled: "5",
    kind: "OrderExecuted", market: marketA, nonce: "0", orderId: "1", outcome: "0",
    price: "600", rested: "0", wallet: walletA, ...overrides });
}
function event(overrides: Partial<{ transactionSignature: string; slot: bigint; logIndex: number;
  marketAddress: string; walletAddress: string; payload: string }> = {}) {
  const row = { transactionSignature: head, slot: 30n, logIndex: 8, marketAddress: marketA,
    walletAddress: walletA, payload: payload() , ...overrides };
  return { eventKey: `${genesisHash}:${programAddress}:${row.transactionSignature}:${row.logIndex}`,
    logIndex: row.logIndex, invocationDepth: 1, kind: "OrderExecuted", payload: row.payload,
    schemaVersion: 1, marketAddress: row.marketAddress, walletAddress: row.walletAddress,
    receipt: { genesisHash, programAddress, signature: row.transactionSignature, slot: row.slot,
      status: "VERIFIED_SUCCESS", decoderVersion: 1 } };
}
function coverage(overrides: Record<string, unknown> = {}) {
  return { genesisHash, programAddress, coverageStartSignature: start, committedHeadSignature: null,
    scanHeadSignature: head, scanBeforeSignature: before, backfillComplete: false,
    revision: 3, updatedAt, ...overrides };
}
function client() {
  const tx = { solanaIngestionCursor: { findUnique: mocks.cursor }, solanaProgramEvent: { findMany: mocks.events } };
  const transaction = vi.fn(async operation => operation(tx));
  return { value: { $transaction: transaction } as unknown as TransactionRunner, transaction };
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv("DATABASE_URL", "file:./leaderboard-test.db");
});

describe("chain leaderboard query contract", () => {
  it("accepts only a bounded scalar limit", () => {
    expect(parseSolanaLeaderboardQuery({})).toEqual({ limit: 50 });
    expect(parseSolanaLeaderboardQuery({ limit: "100" })).toEqual({ limit: 100 });
  });
  it.each([{ limit: 0 }, { limit: 101 }, { limit: "01" }, { limit: "1.5" },
    { limit: ["5"] }, { extra: "x" }])("rejects invalid query %j", input => {
    expect(() => parseSolanaLeaderboardQuery(input)).toThrow(expect.objectContaining({ code: "INVALID_QUERY" }));
  });
});

describe("finalized Solana journal leaderboard", () => {
  it("reports unavailable coverage without ranking scattered receipts", async () => {
    const database = client(); mocks.cursor.mockResolvedValue(null);
    const result = await readSolanaLeaderboard(runtime, { limit: 50 }, database.value, 10);
    expect(result).toEqual({ metric: "taker_filled_contracts", rows: [], participantCount: 0,
      observedOrderEvents: 0,
      eventWindow: { limit: 10, truncated: false, semantics: "latest_finalized_order_events" },
      coverage: { status: "unavailable", coverageStartSignature: null, headSignature: null,
        backfillComplete: false, revision: null, updatedAt: null, fullHistory: false } });
    expect(mocks.events).not.toHaveBeenCalled();
  });

  it("ranks only actual taker fills and never reads SQL users, balances, positions, or trades", async () => {
    const database = client(); mocks.cursor.mockResolvedValue(coverage());
    mocks.events.mockResolvedValue([
      event({ payload: payload({ filled: "7", wallet: walletA, market: marketA }) }),
      event({ logIndex: 7, payload: payload({ filled: "4", wallet: walletB, market: marketA }), walletAddress: walletB }),
      event({ logIndex: 6, payload: payload({ filled: "5", wallet: walletB, market: marketB }),
        walletAddress: walletB, marketAddress: marketB }),
      event({ logIndex: 5, payload: payload({ filled: "0", canceled: "3", disposition: "3", wallet: walletA }) }),
    ]);
    const result = await readSolanaLeaderboard(runtime, { limit: 10 }, database.value, 10);
    expect(result.metric).toBe("taker_filled_contracts");
    expect(result.rows).toEqual([
      { rank: 1, walletAddress: walletB, filledContracts: 9n, filledOrderCommands: 2n,
        orderCommands: 2n, marketsTraded: 2 },
      { rank: 2, walletAddress: walletA, filledContracts: 7n, filledOrderCommands: 1n,
        orderCommands: 2n, marketsTraded: 1 },
    ]);
    expect(result).not.toHaveProperty("equityMilli");
    expect(result).not.toHaveProperty("pnlMilli");
    expect(result.coverage).toEqual({ status: "partial", coverageStartSignature: start,
      headSignature: head, backfillComplete: false, revision: 3, updatedAt, fullHistory: false });
    expect(mocks.events.mock.calls[0][0]).toMatchObject({ take: 11,
      where: { kind: "OrderExecuted", schemaVersion: 1, walletAddress: { not: null },
        receipt: { is: { genesisHash, programAddress, status: "VERIFIED_SUCCESS", decoderVersion: 1 } } },
      orderBy: [{ receipt: { slot: "desc" } }, { receipt: { signature: "desc" } }, { logIndex: "desc" }] });
  });

  it("uses stable wallet ordering for equal quantities and applies the public row limit after ranking", async () => {
    const database = client(); mocks.cursor.mockResolvedValue(coverage());
    mocks.events.mockResolvedValue([
      event({ payload: payload({ wallet: walletA }), walletAddress: walletA }),
      event({ logIndex: 7, payload: payload({ wallet: walletB }), walletAddress: walletB }),
    ]);
    const result = await readSolanaLeaderboard(runtime, { limit: 1 }, database.value, 10);
    expect(result.participantCount).toBe(2);
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]?.walletAddress).toBe([walletA, walletB].sort()[0]);
  });

  it("labels a capped latest-event ranking window instead of claiming completeness", async () => {
    const database = client(); mocks.cursor.mockResolvedValue(coverage({ committedHeadSignature: head,
      scanHeadSignature: null, scanBeforeSignature: null, backfillComplete: true }));
    mocks.events.mockResolvedValue([event(), event({ logIndex: 7 }), event({ logIndex: 6 })]);
    const result = await readSolanaLeaderboard(runtime, { limit: 10 }, database.value, 2);
    expect(result.observedOrderEvents).toBe(2);
    expect(result.eventWindow).toEqual({ limit: 2, truncated: true, semantics: "latest_finalized_order_events" });
    expect(result.coverage).toMatchObject({ status: "bounded_complete", fullHistory: false });
  });

  it.each([
    ["extra payload field", () => event({ payload: payload({ extra: "x" }) })],
    ["noncanonical payload", () => event({ payload: JSON.stringify(
      Object.fromEntries(Object.entries(JSON.parse(payload()) as Record<string, unknown>).reverse()),
    ) })],
    ["wrong payload wallet", () => event({ payload: payload({ wallet: walletB }) })],
    ["wrong payload market", () => event({ payload: payload({ market: marketB }) })],
    ["malformed u64", () => event({ payload: payload({ filled: "01" }) })],
    ["overflowing total", () => event({ payload: payload({ filled: U64_MAX.toString(), rested: "1" }) })],
    ["invalid disposition", () => event({ payload: payload({ disposition: "8" }) })],
    ["wrong event identity", () => ({ ...event(), eventKey: "wrong" })],
    ["failed receipt", () => ({ ...event(), receipt: { ...event().receipt, status: "VERIFIED_FAILED" } })],
  ] as const)("fails closed on injected %s", async (_label, makeRow) => {
    const database = client(); mocks.cursor.mockResolvedValue(coverage()); mocks.events.mockResolvedValue([makeRow()]);
    await expect(readSolanaLeaderboard(runtime, { limit: 10 }, database.value, 10)).rejects.toThrow();
  });

  it.each([
    { backfillComplete: true, committedHeadSignature: null },
    { scanHeadSignature: head, scanBeforeSignature: null },
    { revision: -1 },
    { updatedAt: new Date("invalid") },
  ])("fails closed on inconsistent index coverage %j", async patch => {
    const database = client(); mocks.cursor.mockResolvedValue(coverage(patch));
    await expect(readSolanaLeaderboard(runtime, { limit: 10 }, database.value, 10))
      .rejects.toThrow("coverage cursor");
    expect(mocks.events).not.toHaveBeenCalled();
  });

  it("runs the database startup guard for the shipping client", async () => {
    mocks.startup.mockRejectedValue(new Error("startup refused"));
    await expect(readSolanaLeaderboard(runtime, { limit: 10 })).rejects.toThrow("startup refused");
    expect(mocks.startup).toHaveBeenCalledOnce(); expect(mocks.transaction).not.toHaveBeenCalled();
  });
});
