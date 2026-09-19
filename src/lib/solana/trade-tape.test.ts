import { address, getBase58Decoder, signature } from "@solana/kit";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TransactionRunner } from "@/lib/serializable-transaction";
import type { SolanaRuntime } from "./runtime";

const mocks = vi.hoisted(() => ({ startup: vi.fn(), cursor: vi.fn(), events: vi.fn(), transaction: vi.fn() }));
vi.mock("@/lib/db", () => ({ db: { $transaction: mocks.transaction }, requireDatabaseStartup: mocks.startup }));
vi.mock("@/lib/market-service", () => ({ ApiError: class extends Error {
  constructor(public status: number, public code: string, message: string) { super(message); }
} }));

import { deriveGooseyMarketAddresses } from "./escrow-client";
import { parseTradeTapeMarketId, parseTradeTapeQuery, readSolanaTradeTape } from "./trade-tape";

const programAddress = address("CgEGAD3EGLm63YaSx58sRiNPQmmxg8RqvqcxE3xThX8Q");
const genesisHash = "AjRRXmyGBFhUtVWWp5xYXYKAP4Ha8vyTDRNVrkTVA2DE";
const runtime: SolanaRuntime = { cluster: "localnet", rpcUrl: "http://127.0.0.1:20999", genesisHash, programAddress };
const sig = (seed: number) => signature(getBase58Decoder().decode(new Uint8Array(64).fill(seed)));
const start = sig(1), head = sig(2), older = sig(3);
const updatedAt = new Date("2026-09-19T12:00:00.000Z");
let marketAddress: string;

const canonicalJson = (value: Record<string, unknown>) => JSON.stringify(
  Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right))),
);
function payload(overrides: Record<string, unknown> = {}) {
  return canonicalJson({ kind: "TradeExecuted", market: marketAddress,
    makerOrderId: "1", takerOrderId: "2", makerSeat: "0", takerSeat: "1",
    quantity: "5", yesPrice: "600", makerFee: "7", takerFee: "8",
    makerOutcome: "0", makerAction: "1", takerOutcome: "1", takerAction: "0", ...overrides });
}
function event(transactionSignature = head, slot = 30n, logIndex = 8) {
  return { eventKey: `${genesisHash}:${programAddress}:${transactionSignature}:${logIndex}`,
    logIndex, invocationDepth: 1, kind: "TradeExecuted", payload: payload(), schemaVersion: 1,
    marketAddress, receipt: { genesisHash, programAddress, signature: transactionSignature, slot,
      status: "VERIFIED_SUCCESS", decoderVersion: 1 } };
}
function coverage(overrides: Record<string, unknown> = {}) {
  return { genesisHash, programAddress, coverageStartSignature: start, committedHeadSignature: null,
    scanHeadSignature: head, scanBeforeSignature: older, backfillComplete: false, revision: 1, updatedAt, ...overrides };
}
function client() {
  const tx = { solanaIngestionCursor: { findUnique: mocks.cursor }, solanaProgramEvent: { findMany: mocks.events } };
  const transaction = vi.fn(async operation => operation(tx));
  return { value: { $transaction: transaction } as unknown as TransactionRunner, transaction };
}

beforeEach(async () => {
  vi.resetAllMocks();
  marketAddress = (await deriveGooseyMarketAddresses({ programAddress, marketId: 7n })).market;
});

describe("chain trade tape query contract", () => {
  it("parses bounded scalar limits and canonical u64 market IDs", () => {
    expect(parseTradeTapeQuery({})).toEqual({ limit: 25 });
    expect(parseTradeTapeQuery({ limit: "50" })).toEqual({ limit: 50 });
    expect(parseTradeTapeMarketId("0")).toBe(0n);
    expect(parseTradeTapeMarketId("18446744073709551615")).toBe((1n << 64n) - 1n);
  });
  it.each([{ extra: "x" }, { limit: 0 }, { limit: 51 }, { limit: "01" }, { limit: "1.5" },
    { limit: ["5"] }, { cursor: ["x"] }, { cursor: "x".repeat(513) }])("rejects invalid query %j", input => {
    expect(() => parseTradeTapeQuery(input)).toThrow(expect.objectContaining({ status: 400 }));
  });
  it.each(["-1", "01", "1e3", "18446744073709551616", "x".repeat(100)])("rejects invalid market ID %s", value => {
    expect(() => parseTradeTapeMarketId(value)).toThrow(expect.objectContaining({ code: "INVALID_MARKET_ID" }));
  });
});

describe("injected journal fixtures: finalized chain trade tape", () => {
  it("reports an absent coverage index as unavailable without presenting scattered receipts", async () => {
    const database = client(); mocks.cursor.mockResolvedValue(null);
    const result = await readSolanaTradeTape(runtime, 7n, { limit: 25 }, database.value);
    expect(result).toEqual({ items: [], nextCursor: null,
      ordering: { direction: "desc", keys: ["slot", "signature", "logIndex"], semantics: "deterministic_journal_display_only" },
      coverage: { status: "unavailable", coverageStartSignature: null, headSignature: null,
        backfillComplete: false, revision: null, updatedAt: null, fullHistory: false } });
    expect(mocks.events).not.toHaveBeenCalled();
    expect(database.transaction).toHaveBeenCalledWith(expect.any(Function), expect.objectContaining({ isolationLevel: "Serializable" }));
  });

  it("returns validated events with partial bounded coverage and no invented timestamp", async () => {
    const database = client(); mocks.cursor.mockResolvedValue(coverage()); mocks.events.mockResolvedValue([event()]);
    const result = await readSolanaTradeTape(runtime, 7n, { limit: 25 }, database.value);
    expect(result.coverage).toEqual({ status: "partial", coverageStartSignature: start, headSignature: head,
      backfillComplete: false, revision: 1, updatedAt, fullHistory: false });
    expect(result.items).toEqual([{ signature: head, slot: 30n, logIndex: 8,
      makerOrderId: 1n, takerOrderId: 2n, makerSeat: 0n, takerSeat: 1n, quantity: 5n,
      yesPrice: 600n, makerFee: 7n, takerFee: 8n,
      makerOutcome: "YES", makerAction: "SELL", takerOutcome: "NO", takerAction: "BUY" }]);
    expect(result.items[0]).not.toHaveProperty("createdAt"); expect(result.items[0]).not.toHaveProperty("timestamp");
    const query = mocks.events.mock.calls[0][0];
    expect(query).toMatchObject({ take: 26,
      orderBy: [{ receipt: { slot: "desc" } }, { receipt: { signature: "desc" } }, { logIndex: "desc" }],
      where: { kind: "TradeExecuted", schemaVersion: 1, marketAddress,
        receipt: { is: { genesisHash, programAddress, status: "VERIFIED_SUCCESS", decoderVersion: 1 } } } });
    expect(query.select.receipt.select).not.toHaveProperty("createdAt");
  });

  it("labels only the explicit start-to-head window bounded complete", async () => {
    const database = client(); mocks.cursor.mockResolvedValue(coverage({ committedHeadSignature: head,
      scanHeadSignature: null, scanBeforeSignature: null, backfillComplete: true, revision: 4 }));
    mocks.events.mockResolvedValue([]);
    const result = await readSolanaTradeTape(runtime, 7n, { limit: 25 }, database.value);
    expect(result.coverage).toMatchObject({ status: "bounded_complete", coverageStartSignature: start,
      headSignature: head, backfillComplete: true, revision: 4, fullHistory: false });
    expect(result.items).toEqual([]);
  });

  it("paginates same-slot events by signature then log index without relying on a cursor row", async () => {
    const database = client(); mocks.cursor.mockResolvedValue(coverage());
    const first = event(head, 30n, 8), second = event(head, 30n, 7);
    mocks.events.mockResolvedValue([first, second]);
    const page = await readSolanaTradeTape(runtime, 7n, { limit: 1 }, database.value);
    expect(page.nextCursor).toEqual(expect.any(String));
    const decoded = JSON.parse(Buffer.from(page.nextCursor!, "base64url").toString("utf8"));
    expect(decoded).toEqual({ v: 1, marketAddress, slot: "30", signature: head, logIndex: 8 });
    mocks.events.mockResolvedValue([second]);
    await readSolanaTradeTape(runtime, 7n, parseTradeTapeQuery({ limit: 1, cursor: page.nextCursor }), database.value);
    expect(mocks.events.mock.lastCall?.[0].where.AND).toEqual([{ OR: [
      { receipt: { is: { genesisHash, programAddress, status: "VERIFIED_SUCCESS", decoderVersion: 1, slot: { lt: 30n } } } },
      { receipt: { is: { genesisHash, programAddress, status: "VERIFIED_SUCCESS", decoderVersion: 1, slot: 30n, signature: { lt: head } } } },
      { receipt: { is: { genesisHash, programAddress, status: "VERIFIED_SUCCESS", decoderVersion: 1, slot: 30n, signature: head } }, logIndex: { lt: 8 } },
    ] }]);
    expect(mocks.events.mock.lastCall?.[0]).not.toHaveProperty("cursor");
  });

  it.each(["!", "e30", Buffer.from("not-json").toString("base64url")])("rejects malformed cursor %s before a transaction", async cursor => {
    const database = client(); await expect(readSolanaTradeTape(runtime, 7n, { limit: 25, cursor }, database.value))
      .rejects.toMatchObject({ code: "INVALID_CURSOR" });
    expect(database.transaction).not.toHaveBeenCalled();
  });

  it("rejects a cursor scoped to another canonical market", async () => {
    const database = client(); mocks.cursor.mockResolvedValue(coverage()); mocks.events.mockResolvedValue([event(), event(head, 30n, 7)]);
    const page = await readSolanaTradeTape(runtime, 7n, { limit: 1 }, database.value);
    await expect(readSolanaTradeTape(runtime, 8n, { limit: 1, cursor: page.nextCursor! }, database.value))
      .rejects.toMatchObject({ code: "INVALID_CURSOR" });
  });

  it.each([
    ["extra payload field", () => ({ ...event(), payload: payload({ extra: "x" }) })],
    ["noncanonical payload JSON", () => ({ ...event(), payload: JSON.stringify(
      Object.fromEntries(Object.entries(JSON.parse(payload()) as Record<string, unknown>).reverse()),
    ) })],
    ["invalid u64", () => ({ ...event(), payload: payload({ makerFee: "01" }) })],
    ["zero quantity", () => ({ ...event(), payload: payload({ quantity: "0" }) })],
    ["invalid enum", () => ({ ...event(), payload: payload({ takerAction: "2" }) })],
    ["wrong payload market", () => ({ ...event(), payload: payload({ market: programAddress }) })],
    ["wrong event key", () => ({ ...event(), eventKey: "wrong" })],
    ["wrong schema", () => ({ ...event(), schemaVersion: 2 })],
    ["failed receipt", () => ({ ...event(), receipt: { ...event().receipt, status: "VERIFIED_FAILED" } })],
  ] as const)("fails closed on injected %s", async (_label, makeRow) => {
    const database = client(); mocks.cursor.mockResolvedValue(coverage()); mocks.events.mockResolvedValue([makeRow()]);
    await expect(readSolanaTradeTape(runtime, 7n, { limit: 25 }, database.value)).rejects.toThrow();
  });

  it.each([
    { backfillComplete: true, committedHeadSignature: null },
    { scanHeadSignature: head, scanBeforeSignature: null },
    { revision: -1 }, { updatedAt: new Date("invalid") },
  ])("rejects inconsistent stored coverage %j", async patch => {
    const database = client(); mocks.cursor.mockResolvedValue(coverage(patch));
    await expect(readSolanaTradeTape(runtime, 7n, { limit: 25 }, database.value)).rejects.toThrow("coverage cursor");
    expect(mocks.events).not.toHaveBeenCalled();
  });

  it("runs the shipping startup guard before reading the default journal", async () => {
    mocks.startup.mockRejectedValue(new Error("Database startup refused"));
    await expect(readSolanaTradeTape(runtime, 7n, { limit: 25 })).rejects.toThrow("startup refused");
    expect(mocks.startup).toHaveBeenCalledOnce(); expect(mocks.transaction).not.toHaveBeenCalled();
  });
});
