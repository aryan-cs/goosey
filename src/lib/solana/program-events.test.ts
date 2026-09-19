import { createHash } from "node:crypto";
import { address, getAddressEncoder, type Address } from "@solana/kit";
import { describe, expect, it } from "vitest";
import { decodeFinalizedProgramEvents, PROGRAM_EVENT_LIMITS } from "./program-events";

// Offline Borsh encoding fixtures only: not transaction or runtime evidence.
const program = address("CgEGAD3EGLm63YaSx58sRiNPQmmxg8RqvqcxE3xThX8Q");
const other = address("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const zero = address("11111111111111111111111111111111");
const genesisHash = "Bax5P2GmYBb2P6UjJFmEVys7cpRzY4A85ncAJqtgvSsm";
const txSignature = "6M2a2q9v4ePtvpQhsPHesZwQDeaHzJfQ9kzgacadhv1fsBb1b4WAiZXv83vxDAH3fmPjE6bfRsioJ4hA3afnDi3";
const pub = (key: Address = program) => Buffer.from(getAddressEncoder().encode(key));
const u64 = (n: bigint) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(n); return b; };
const i64 = (n: bigint) => { const b = Buffer.alloc(8); b.writeBigInt64LE(n); return b; };
const tag = (...n: number[]) => Buffer.from(n);
const event = (name: string, ...parts: Uint8Array[]) => Buffer.concat([createHash("sha256").update(`event:${name}`).digest().subarray(0, 8), ...parts]);
const data = (bytes: Uint8Array) => `Program data: ${Buffer.from(bytes).toString("base64")}`;
const invoke = (p: Address = program, depth = 1) => `Program ${p} invoke [${depth}]`;
const success = (p: Address = program) => `Program ${p} success`;
const failed = (p: Address = program) => `Program ${p} failed: custom program error: 0x1`;
const input = (logs: string[]) => ({ programAddress: program, genesisHash, signature: txSignature, slot: 99n,
  commitment: "finalized" as const, meta: { err: null as unknown, logMessages: logs as readonly string[] | null } });
const parse = (bytes: Uint8Array) => decodeFinalizedProgramEvents(input([invoke(), data(bytes), success()]));
const max = (1n << 64n) - 1n;
const fixtures = [
  { name: "Configured", bytes: event("Configured", pub(), pub(other), tag(2), Buffer.alloc(32, 0xab)), expected: { config: program, mint: other, environment: 2n, genesisDomain: "ab".repeat(32) } },
  { name: "EnrollmentAuthorized", bytes: event("EnrollmentAuthorized", pub(), pub(other), u64(max), i64(-(1n << 63n))), expected: { wallet: program, enrollment: other, allowance: max, expiresAt: -(1n << 63n) } },
  { name: "FeathersClaimed", bytes: event("FeathersClaimed", pub(), u64(9007199254740993n), u64(max)), expected: { wallet: program, amount: 9007199254740993n, lifetimeMinted: max } },
  { name: "MarketCreated", bytes: event("MarketCreated", pub(), pub(other), u64(1000n)), expected: { market: program, vault: other, payoutMilli: 1000n } },
  { name: "CashMoved", bytes: event("CashMoved", pub(), pub(other), u64(123n), tag(1), u64(8n)), expected: { market: program, wallet: other, amount: 123n, deposit: true, nonce: 8n } },
  { name: "TradeExecuted", bytes: event("TradeExecuted", pub(), ...[1n, 2n, 3n, 4n, 5n, 600n, 7n, 8n].map(u64), tag(0, 1, 1, 0)), expected: { market: program, makerOrderId: 1n, takerOrderId: 2n, makerSeat: 3n, takerSeat: 4n, quantity: 5n, yesPrice: 600n, makerFee: 7n, takerFee: 8n, makerOutcome: 0n, makerAction: 1n, takerOutcome: 1n, takerAction: 0n } },
  { name: "OrderExecuted", bytes: event("OrderExecuted", pub(), pub(other), ...[11n, 12n, 13n, 14n, 15n].map(u64), tag(7, 1, 0), u64(650n)), expected: { market: program, wallet: other, orderId: 11n, nonce: 12n, filled: 13n, canceled: 14n, rested: 15n, disposition: 7n, outcome: 1n, action: 0n, price: 650n } },
  { name: "RestingOrderRemoved", bytes: event("RestingOrderRemoved", pub(), u64(1n), u64(2n), u64(3n), tag(1)), expected: { market: program, orderId: 1n, seat: 2n, remaining: 3n, reason: 1n } },
  { name: "OrderCanceled", bytes: event("OrderCanceled", pub(), pub(other), u64(1n), u64(2n), tag(0, 1), u64(3n), ...[4n, 5n, 6n, 7n, 8n, 9n].map(u64)), expected: { market: program, wallet: other, seat: 1n, orderId: 2n, reason: 0n, ownerNonce: 3n, bookRevision: 4n, remaining: 5n, chainNotional: 6n, releasedCash: 7n, releasedYes: 8n, releasedNo: 9n } },
  { name: "ResolutionClaimed", bytes: event("ResolutionClaimed", pub(), tag(255,255,255,255), pub(other), u64(max)), expected: { market: program, seatIndex: 4294967295n, wallet: other, payoutMilli: max } },
  { name: "ResolutionFinalized", bytes: event("ResolutionFinalized", pub(), u64(17n)), expected: { market: program, residualMilli: 17n } },
];
const sample = fixtures[10].bytes;

describe("actual Anchor event wire formats (unit encoding fixtures)", () => {
  for (const f of fixtures) {
    it(`decodes all ${f.name} fields`, async () => {
      const result = await parse(f.bytes);
      expect(result.records).toEqual([{ status: "known", event: { kind: f.name, ...f.expected }, logIndex: 1, invocationDepth: 1, eventKey: `${genesisHash}:${program}:${txSignature}:1` }]);
    });
    it(`rejects every truncated ${f.name} payload`, async () => {
      for (let length = 0; length < f.bytes.length; length++) await expect(parse(f.bytes.subarray(0, length))).rejects.toThrow();
    });
    it(`rejects trailing ${f.name} bytes`, async () => { await expect(parse(Buffer.concat([f.bytes, tag(0)]))).rejects.toThrow(/Trailing/); });
  }
  it("decodes an independent literal discriminator and little-endian vector", async () => {
    const bytes = Buffer.from("950c3f6eea2ef1ca" + "00".repeat(32) + "0807060504030201", "hex");
    expect((await parse(bytes)).records[0]).toMatchObject({ event: { kind: "ResolutionFinalized", market: zero, residualMilli: 0x0102030405060708n } });
  });
  it("decodes absent owner nonce without consuming subsequent fields", async () => {
    const bytes = event("OrderCanceled", pub(), pub(other), u64(1n), u64(2n), tag(2, 0), ...[4n,5n,6n,7n,8n,9n].map(u64));
    expect((await parse(bytes)).records[0]).toMatchObject({ event: { ownerNonce: null, bookRevision: 4n, releasedNo: 9n, reason: 2n } });
  });
  it("decodes a literal TradeExecuted vector independent of the fixture encoder", async () => {
    const bytes = Buffer.from("296e40813c4fb350" + "00".repeat(32)
      + "0100000000000000020000000000000003000000000000000400000000000000"
      + "0500000000000000580200000000000007000000000000000800000000000000" + "00010100", "hex");
    expect((await parse(bytes)).records[0]).toMatchObject({ event: { kind: "TradeExecuted", ...fixtures[5].expected, market: zero } });
  });
  it("decodes withdrawal false", async () => {
    const bytes = Buffer.from(fixtures[4].bytes); bytes[80] = 0;
    expect((await parse(bytes)).records[0]).toMatchObject({ event: { deposit: false } });
  });
  it.each([[0,72,0],[0,72,3],[4,80,2],[5,104,2],[5,105,2],[5,106,2],[5,107,2],[6,112,8],[6,113,2],[6,114,2],[7,64,2],[8,88,3],[8,89,2]])("rejects invalid tag fixture %i offset %i value %i", async (index, offset, value) => {
    const bytes = Buffer.from(fixtures[index].bytes); bytes[offset] = value;
    await expect(parse(bytes)).rejects.toThrow(/tag|option/);
  });
  it("reports unknown future discriminator without guessing its schema", async () => {
    const bytes = Buffer.from("ffffffffffffffff010203", "hex");
    expect((await parse(bytes)).records[0]).toMatchObject({ status: "unknown", discriminatorHex: "ffffffffffffffff", dataBase64: bytes.toString("base64") });
  });
});

describe("trusted finalized transaction attribution and rollback", () => {
  it("attributes only active own invocations and preserves nested order", async () => {
    const logs = [invoke(), data(sample), invoke(other,2), data(sample), "Program data: invalid!", invoke(program,3), data(sample), success(), success(other), data(sample), success()];
    expect((await decodeFinalizedProgramEvents(input(logs))).records.map(r => [r.logIndex,r.invocationDepth])).toEqual([[1,1],[6,3],[9,1]]);
  });
  it("ignores spoofed runtime/data text inside application logs", async () => {
    const logs = [invoke(other), "Program log: success", "Program log: failed: x", `Program log: ${invoke()}`, `Program log: ${data(sample)}`, `Program log: ${success()}`, data(sample), success(other)];
    expect((await decodeFinalizedProgramEvents(input(logs))).records).toEqual([]);
  });
  it("drops successful descendants of a failed CPI", async () => {
    const logs = [invoke(), data(sample), invoke(other,2), invoke(program,3), data(sample), success(), failed(other), data(sample), success()];
    expect((await decodeFinalizedProgramEvents(input(logs))).records.map(r => r.logIndex)).toEqual([1,7]);
  });
  it("drops malformed payloads in a failed own CPI", async () => {
    const logs = [invoke(other), invoke(program,2), "Program data: ???", failed(), success(other)];
    expect((await decodeFinalizedProgramEvents(input(logs))).records).toEqual([]);
  });
  it("never returns events from a failed transaction, even before the failing instruction", async () => {
    const args = input([invoke(),data(sample),success(),invoke(other),failed(other)]); args.meta.err = { InstructionError: [1,"Custom"] };
    expect(await decodeFinalizedProgramEvents(args)).toMatchObject({ status: "failed-transaction", records: [] });
  });
  it("does not parse missing logs for failed transactions", async () => {
    const args = input([]); args.meta.err = "failure"; args.meta.logMessages = null;
    expect((await decodeFinalizedProgramEvents(args)).records).toEqual([]);
  });
  it("stable replay identities include chain, program, signature and exact log position", async () => {
    const args = input([invoke(), data(sample), data(sample), success()]);
    const first = await decodeFinalizedProgramEvents(args);
    expect((await decodeFinalizedProgramEvents({ ...args, slot: 100n })).records).toEqual(first.records);
    expect(first.records[0].eventKey).not.toBe(first.records[1].eventKey);
    expect((await decodeFinalizedProgramEvents({ ...args, genesisHash: zero })).records[0].eventKey).not.toBe(first.records[0].eventKey);
  });
  it("captures caller-owned logs and metadata before any await", async () => {
    const logs = [invoke(),data(sample),success()]; const args = input(logs);
    const pending = decodeFinalizedProgramEvents(args); logs[1] = "Program data: ???"; args.genesisHash = zero; args.slot = 200n;
    expect(await pending).toMatchObject({ slot: 99n, records: [{ eventKey: `${genesisHash}:${program}:${txSignature}:1` }] });
  });
  it.each([
    [data(sample)], [success()], [invoke(),success(other)], [invoke(program,2)], [invoke(),invoke(other,3)],
    [invoke(),data(sample)], [invoke(),failed()], [invoke(),"Log truncated",success()],
    [invoke(),"Program data:",success()], [invoke(),`Program log: harmless\n${data(sample)}`,success()],
    [`Program ${program} invoke [01]`], [`Program ${program} invoke [x]`],
  ])("rejects inconsistent or truncated trace %j", async (...logs) => { await expect(decodeFinalizedProgramEvents(input(logs))).rejects.toThrow(); });
  it.each(["???", "AA==", "AAAAAAAAAAA", "AAAAAAAAAAB=", "AAAAAAAAAAA= ", "AAAAAAAAAAA= AAAA"]) ("rejects noncanonical own base64 %s", async value => {
    await expect(decodeFinalizedProgramEvents(input([invoke(),`Program data: ${value}`,success()]))).rejects.toThrow();
  });
  it("requires finalized success metadata and complete logs", async () => {
    await expect(decodeFinalizedProgramEvents({ ...input([]), commitment: "confirmed" as "finalized" })).rejects.toThrow();
    await expect(decodeFinalizedProgramEvents({ ...input([]), slot: -1n })).rejects.toThrow();
    const args = input([]); args.meta.err = undefined; await expect(decodeFinalizedProgramEvents(args)).rejects.toThrow();
    args.meta.err = null; args.meta.logMessages = null; await expect(decodeFinalizedProgramEvents(args)).rejects.toThrow();
  });
  it("bounds log count, UTF8 line bytes, total bytes, event bytes and depth", async () => {
    for (const logs of [Array(PROGRAM_EVENT_LIMITS.logs+1).fill(""), ["é".repeat(4097)], Array(100).fill("x".repeat(8192)),
      [invoke(),data(Buffer.alloc(PROGRAM_EVENT_LIMITS.eventBytes+1)),success()], Array.from({ length:65 },(_,i) => invoke(program,i+1))]) {
      await expect(decodeFinalizedProgramEvents(input(logs))).rejects.toThrow();
    }
  });
});
