import { createHash } from "node:crypto";
import { address, getAddressEncoder, getProgramDerivedAddress, type Address } from "@solana/kit";
import { describe, expect, it } from "vitest";
import { deriveGooseySeatAddresses } from "./escrow-client";
import { GOOSEY_ORDER_BOOK_BYTES, readCanonicalOrderBook } from "./order-book-read";

const programAddress = address("CgEGAD3EGLm63YaSx58sRiNPQmmxg8RqvqcxE3xThX8Q");
const wallets = [address("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"), address("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL")];
const seatsAddress = address("SysvarRent111111111111111111111111111111111");
const BID = 88 + 1024 * 64, ASK = BID + 2048;
const key = (bytes: Buffer, offset: number, value: Address) => bytes.set(getAddressEncoder().encode(value), offset);
const anchor = (size: number, name: string) => {
  const bytes = Buffer.alloc(size); bytes.set(createHash("sha256").update(`account:${name}`).digest().subarray(0, 8)); return bytes;
};
// Binary fixtures only: not submitted to a validator or represented as runtime proof.
async function fixture(empty = false) {
  const p = await deriveGooseySeatAddresses({ programAddress, marketId: 7n, wallet: wallets[0]! });
  const other = await deriveGooseySeatAddresses({ programAddress, marketId: 7n, wallet: wallets[1]! });
  const [bookAddress] = await getProgramDerivedAddress({ programAddress, seeds: ["order_book", getAddressEncoder().encode(p.market)] });
  const market = anchor(195, "Market"), seats = anchor(32816, "Seats"), book = Buffer.alloc(GOOSEY_ORDER_BOOK_BYTES);
  key(market, 8, p.config); key(market, 40, wallets[0]!); key(market, 72, seatsAddress); key(market, 104, p.vault);
  market.writeBigUInt64LE(7n, 136); market.writeBigUInt64LE(100n, 144); market.writeBigInt64LE(1000n, 152); market.writeBigInt64LE(2000n, 160);
  market.writeBigUInt64LE(empty ? 0n : 2062n, 168); market.writeBigUInt64LE(empty ? 0n : 2000n, 176); market.writeUInt16LE(1, 192); market[194] = p.marketBump;
  key(seats, 8, p.market); seats.writeUInt32LE(2, 40);
  for (let i = 0; i < 2; i++) {
    const o = 48 + 128 * i;
    key(seats, o, wallets[i]!); key(seats, o + 32, i ? other.enrollment : p.enrollment);
    seats.writeBigUInt64LE(empty ? 0n : (i ? 61n : 1n), o + 72);
    seats.writeBigUInt64LE(empty ? 0n : 10n, o + 80); seats.writeBigUInt64LE(empty ? 0n : 10n, o + 88);
    seats.writeBigUInt64LE(empty || i ? 0n : 3n, o + 96); seats.writeBigUInt64LE(empty || !i ? 0n : 2n, o + 104);
  }
  book.set(Buffer.from("GOOSEYB1")); key(book, 8, p.market); book.writeBigUInt64LE(1n, 40); book.writeBigUInt64LE(100n, 48);
  book.writeBigUInt64LE(empty ? 0n : 4n, 56); book.writeBigUInt64LE(empty ? 1n : 5n, 64);
  book.writeUInt16LE(1024, 72); book.writeUInt16LE(empty ? 0 : 2, 74); book.writeUInt16LE(empty ? 0 : 2, 76);
  book.writeUInt16LE(empty ? 0 : 4, 78); book.writeUInt16LE(empty ? 0 : 4, 80); book.writeUInt16LE(1, 82);
  book.fill(255, BID);
  for (let i = 0; i < 1024; i++) book.writeUInt16LE(i === 1023 ? 65535 : i + 1, 88 + i * 64 + 58);
  if (!empty) {
    for (let i = 0; i < 4; i++) {
      const o = 88 + 64 * i;
      book.writeBigUInt64LE(BigInt(i + 1), o); book.writeBigUInt64LE(BigInt(i % 2), o + 8);
      book.writeBigUInt64LE([1n, 30n, 70n, 70n][i]!, o + 16); book.writeBigUInt64LE([1n, 2n, 3n, 2n][i]!, o + 24);
      book.writeBigUInt64LE(BigInt(i + 1), o + 32); book.writeUInt16LE([9, 3, 5, 7][i]!, o + 56); book.writeUInt16LE(65535, o + 58);
    }
    book.writeBigUInt64LE(1n, 88 + 48); book.writeBigInt64LE(1n, 88 + 40); // old expiry remains backed, fee chain avoids another ceil.
    book.writeUInt16LE(3, BID); book.writeUInt16LE(0, BID + 2); book.writeUInt16LE(1, ASK); book.writeUInt16LE(2, ASK + 2);
  }
  const account = (data: Buffer, accountAddress: Address) => ({ address: accountAddress, owner: programAddress, executable: false, data });
  const input = { programAddress, marketId: 7n, market: account(market, p.market), seats: account(seats, seatsAddress), book: account(book, bookAddress) };
  return { market, seats, book, input, read: () => readCanonicalOrderBook(input) };
}

describe("canonical full-book reconciliation", () => {
  it("supports empty initialized books and proves zero reserves for every seat", async () => {
    const f = await fixture(true); const result = await f.read();
    expect(result.orders).toEqual([]); expect(result.reservesReconciled).toBe(true); expect(result.seatReserves).toHaveLength(2);
    f.seats.writeBigUInt64LE(1n, 120); f.market.writeBigUInt64LE(1n, 168);
    await expect(f.read()).rejects.toThrow("full book");
  });
  it("exposes all four real intents in canonical price/FIFO order, including expired occupied records", async () => {
    const f = await fixture(), result = await f.read();
    expect(result.bids.map(o => o.id)).toEqual([4n, 1n]); expect(result.asks.map(o => o.id)).toEqual([2n, 3n]);
    expect(result.bids[0]).toMatchObject({ outcome: "NO", action: "SELL", limitPrice: 70n, canonicalYesPrice: 30n, reserve: { cash: 0n, no: 2n, yes: 0n } });
    expect(result.bids[1]).toMatchObject({ expiresAt: 1n, chainNotional: 1n, reserve: { cash: 1n, yes: 0n, no: 0n } });
    expect(result.asks[0]).toMatchObject({ outcome: "NO", action: "BUY", reserve: { cash: 61n, yes: 0n, no: 0n } });
    expect(result.seatReserves.map(s => s.expectedReserve)).toEqual([{ cash: 1n, yes: 3n, no: 0n }, { cash: 61n, yes: 0n, no: 2n }]);
    expect(result.exchangeVerified).toBe(false);
  });
  it("retains actual side-heap indices after sorting siblings for display", async () => {
    const f = await fixture(), o = 88 + 4 * 64;
    f.book.writeBigUInt64LE(5n, o); f.book.writeBigUInt64LE(2n, o + 16);
    f.book.writeBigUInt64LE(1n, o + 24); f.book.writeBigUInt64LE(5n, o + 32);
    f.book.writeUInt16LE(1, o + 56); f.book.writeUInt16LE(65535, o + 58);
    f.book.writeBigUInt64LE(5n, 56); f.book.writeBigUInt64LE(6n, 64);
    f.book.writeUInt16LE(3, 74); f.book.writeUInt16LE(5, 78); f.book.writeUInt16LE(5, 80);
    f.book.writeUInt16LE(4, BID + 4);
    f.seats.writeBigUInt64LE(4n, 120); f.market.writeBigUInt64LE(2065n, 168);
    const result = await f.read();
    expect(result.bids.map(order => [order.id, order.heapIndex])).toEqual([[4n, 0], [5n, 2], [1n, 1]]);
    expect(result.asks.map(order => [order.id, order.heapIndex])).toEqual([[2n, 0], [3n, 1]]);
    for (const order of result.orders) {
      expect(f.book.readUInt16LE((order.side === "BID" ? BID : ASK) + order.heapIndex * 2)).toBe(order.slot);
    }
  });
  it.each([0n, -1n])("rejects nonpositive encoded optional expiry %s", async expiry => {
    const f = await fixture(); f.book.writeBigInt64LE(expiry, 88 + 40);
    await expect(f.read()).rejects.toThrow("expiry");
  });
  it.each([0, 8, 40, 48, 72, 78, 82, 84])("rejects malformed tag/header/domain at %i", async offset => {
    const f = await fixture(); f.book[offset] ^= 1; await expect(f.read()).rejects.toThrow();
  });
  it("rejects wrong ownership, address, executable accounts, sizes and draft book", async () => {
    for (const name of ["market", "seats", "book"] as const) {
      for (const patch of [{ owner: wallets[0]! }, { address: wallets[0]! }, { executable: true }, { data: new Uint8Array(8) }]) {
        const f = await fixture(); Object.assign(f.input[name], patch); await expect(f.read()).rejects.toThrow();
      }
    }
    const f = await fixture(); f.book.set(Buffer.from("GOOSEYI1")); await expect(f.read()).rejects.toThrow();
  });
  it.each([0n, 5n])("rejects impossible ID/sequence %s", async id => {
    const f = await fixture(); f.book.writeBigUInt64LE(id, 88); f.book.writeBigUInt64LE(id, 120); await expect(f.read()).rejects.toThrow("ID");
  });
  it("rejects duplicate IDs and mismatched ID/sequence", async () => {
    const f = await fixture(); f.book.writeBigUInt64LE(2n, 88); await expect(f.read()).rejects.toThrow("ID");
    f.book.writeBigUInt64LE(2n, 120); await expect(f.read()).rejects.toThrow("ID");
  });
  it.each([2n, (1n << 64n) - 1n])("rejects unknown/unsafe owner indices %s", async owner => {
    const f = await fixture(); f.book.writeBigUInt64LE(owner, 96); await expect(f.read()).rejects.toThrow("owner");
  });
  it("rejects cyclic/orphaned/occupied free-list nodes and dirty cleared slots", async () => {
    for (const cursor of [4, 0, 65535, 1024]) {
      const f = await fixture(); f.book.writeUInt16LE(cursor, 88 + 4 * 64 + 58); await expect(f.read()).rejects.toThrow();
    }
    const f = await fixture(); f.book[88 + 4 * 64] = 1; await expect(f.read()).rejects.toThrow("free slot");
  });
  it("rejects duplicate/wrong-side/out-of-range heaps and dirty tails", async () => {
    for (const index of [3, 1, 1024, 65535]) {
      const f = await fixture(); f.book.writeUInt16LE(index, BID + 2); await expect(f.read()).rejects.toThrow("heap");
    }
    const f = await fixture(); f.book.writeUInt16LE(4, BID + 4); await expect(f.read()).rejects.toThrow("tail");
  });
  it("rejects price and FIFO heap violations", async () => {
    for (const base of [BID, ASK]) {
      const f = await fixture(); const root = f.book.readUInt16LE(base), child = f.book.readUInt16LE(base + 2);
      f.book.writeUInt16LE(child, base); f.book.writeUInt16LE(root, base + 2); await expect(f.read()).rejects.toThrow("priority");
    }
  });
  it.each([0, 2, 17])("rejects occupied-slot flags %i", async flags => {
    const f = await fixture(); f.book.writeUInt16LE(flags, 144); await expect(f.read()).rejects.toThrow();
  });
  it("rejects malformed quantity/price/expiry and u64 chain overflow", async () => {
    for (const [offset, value] of [[104, 0n], [104, 100n], [112, 0n], [112, 10_000_001n], [136, (1n << 64n) - 1n]] as const) {
      const f = await fixture(); f.book.writeBigUInt64LE(value, offset); await expect(f.read()).rejects.toThrow();
    }
    const f = await fixture(); f.book.writeUInt16LE(1, 144); await expect(f.read()).rejects.toThrow("expiry");
  });
  it("detects under/over-reserved cash, fee-only shortfalls and wrong position owner even with unchanged aggregate", async () => {
    for (const cash of [0n, 2n]) {
      const f = await fixture(); f.seats.writeBigUInt64LE(cash, 120); f.seats.writeBigUInt64LE(62n - cash, 248);
      await expect(f.read()).rejects.toThrow("full book");
    }
    const f = await fixture(); f.seats.writeBigUInt64LE(0n, 144); f.seats.writeBigUInt64LE(3n, 272);
    await expect(f.read()).rejects.toThrow("full book");
  });
  it("uses exact full-rate telescoping fees and rejects reserve arithmetic overflow", async () => {
    const f = await fixture(); f.book.writeUInt16LE(10000, 82); f.market.writeUInt16LE(10000, 192);
    f.seats.writeBigUInt64LE(2n, 120); f.seats.writeBigUInt64LE(120n, 248); f.market.writeBigUInt64LE(2122n, 168);
    expect((await f.read()).asks[0]!.reserve.cash).toBe(120n);
    f.book.writeBigUInt64LE((1n << 64n) - 1n, 136); await expect(f.read()).rejects.toThrow("overflow");
  });
  it("aggregates multiple BUY orders on one seat without borrowing another seat's cash", async () => {
    const f = await fixture(); f.book.writeBigUInt64LE(0n, 88 + 64 + 8);
    f.seats.writeBigUInt64LE(62n, 120); f.seats.writeBigUInt64LE(0n, 248);
    const result = await f.read();
    expect(result.seatReserves[0]!.expectedReserve).toEqual({ cash: 62n, yes: 3n, no: 0n });
    expect(result.asks[0]!.wallet).toBe(wallets[0]);
  });
  it("keeps large fee-chain notionals exact and supports zero fee", async () => {
    const f = await fixture(); f.book.writeBigUInt64LE(9_007_199_254_740_993n, 136);
    expect((await f.read()).bids[1]!).toMatchObject({ chainNotional: 9_007_199_254_740_993n, reserve: { cash: 1n } });
    f.book.writeUInt16LE(0, 82); f.market.writeUInt16LE(0, 192);
    f.seats.writeBigUInt64LE(60n, 248); f.market.writeBigUInt64LE(2061n, 168);
    expect((await f.read()).asks[0]!.reserve.cash).toBe(60n);
  });
});
