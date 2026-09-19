import { address, getAddressDecoder, getAddressEncoder, getProgramDerivedAddress, type Address } from "@solana/kit";
import { deriveGooseyMarketAddresses } from "./escrow-client";
import { readResolutionState, verifyPositionBacking, RESOLUTION_STATE_BYTES } from "./resolution-state";

export const GOOSEY_ORDER_BOOK_BYTES = 69_720;
const CAPACITY = 1024, NONE = 65535, SLOT_BASE = 88, BID_BASE = SLOT_BASE + CAPACITY * 64, ASK_BASE = BID_BASE + CAPACITY * 2;
const U64_MAX = (1n << 64n) - 1n;
const ZERO = "11111111111111111111111111111111";
export type BookSnapshotAccount = Readonly<{ address: Address; owner: Address; executable: boolean; data: Uint8Array }>;
export type CanonicalBookOrder = {
  /** Actual side-heap position in this snapshot, not the sorted display index.
   * Cancellation must still guard against intervening book mutations on chain. */
  heapIndex: number;
  slot: number; id: bigint; sequence: bigint; ownerSeat: number; wallet: Address;
  outcome: "YES" | "NO"; action: "BUY" | "SELL"; side: "BID" | "ASK";
  limitPrice: bigint; canonicalYesPrice: bigint; remaining: bigint; chainNotional: bigint; expiresAt: bigint | null;
  reserve: { cash: bigint; yes: bigint; no: bigint };
};
const key = (bytes: Uint8Array, offset: number) => getAddressDecoder().decode(bytes.subarray(offset, offset + 32));
const bytesOf = (a: BookSnapshotAccount, program: Address, size: number) => {
  address(a.address);
  if (a.owner !== program || a.executable !== false || !(a.data instanceof Uint8Array) || a.data.length !== size) {
    throw new Error("Invalid book snapshot account owner/size");
  }
  return new Uint8Array(a.data);
};
async function discriminator(bytes: Uint8Array, name: string) {
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`account:${name}`)));
  if (!bytes.subarray(0, 8).every((value, i) => value === hash[i])) throw new Error(`Invalid ${name} discriminator`);
}
function checked(value: bigint) {
  if (value > U64_MAX) throw new Error("Order reserve arithmetic overflow");
  return value;
}
function priority(a: Omit<CanonicalBookOrder, "heapIndex">, b: Omit<CanonicalBookOrder, "heapIndex">) {
  if (a.canonicalYesPrice !== b.canonicalYesPrice) {
    const less = a.canonicalYesPrice < b.canonicalYesPrice;
    return a.side === "BID" ? (less ? 1 : -1) : (less ? -1 : 1);
  }
  return a.sequence < b.sequence ? -1 : a.sequence > b.sequence ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** Pure decoder/reconciler, no RPC or DB access. Caller MUST supply market,
 * Seats and FULL ready book from one coherent finalized snapshot on a verified,
 * pinned network. This function cannot prove finality, network, binary identity,
 * mint supply or token-vault backing; combine with the verified escrow reader.
 * Orders are persisted occupied records, including expired-but-not-removed orders
 * whose reserves remain locked. No wall-clock filtering or executable-depth claim.
 */
export async function readCanonicalOrderBook(input: {
  programAddress: Address; marketId: bigint;
  market: BookSnapshotAccount; seats: BookSnapshotAccount; book: BookSnapshotAccount;
  resolution?: BookSnapshotAccount;
}) {
  const programAddress = address(input.programAddress), marketId = input.marketId;
  const marketAddress = input.market.address, seatsAddress = input.seats.address, bookAddress = input.book.address;
  const market = bytesOf(input.market, programAddress, 195), seats = bytesOf(input.seats, programAddress, 32_816);
  const book = bytesOf(input.book, programAddress, GOOSEY_ORDER_BOOK_BYTES);
  const resolutionAccount = input.resolution ? { ...input.resolution,
    data: bytesOf(input.resolution, programAddress, RESOLUTION_STATE_BYTES) } : null;
  const canonical = await deriveGooseyMarketAddresses({ programAddress, marketId });
  const [canonicalBook] = await getProgramDerivedAddress({ programAddress, seeds: ["order_book", getAddressEncoder().encode(canonical.market)] });
  if (marketAddress !== canonical.market || bookAddress !== canonicalBook) throw new Error("Noncanonical market/book PDA");
  await discriminator(market, "Market"); await discriminator(seats, "Seats");
  const m = new DataView(market.buffer), s = new DataView(seats.buffer), b = new DataView(book.buffer);
  const payout = m.getBigUint64(144, true), feeBps = m.getUint16(192, true);
  if (key(market, 8) !== canonical.config || key(market, 40) === ZERO || key(market, 72) !== seatsAddress || seatsAddress === ZERO
    || key(market, 104) !== canonical.vault || m.getBigUint64(136, true) !== marketId || market[194] !== canonical.marketBump
    || payout < 2n || payout > 1_000_000n || feeBps > 10_000 || m.getBigInt64(152, true) <= 0n
    || m.getBigInt64(160, true) < m.getBigInt64(152, true)) throw new Error("Invalid market bindings/parameters");
  const count = s.getUint32(40, true);
  if (key(seats, 8) !== marketAddress || count > 256 || seats.subarray(44, 48).some(Boolean)) throw new Error("Invalid Seats header");
  const seatRows: Array<{ index: number; wallet: Address; availableCash: bigint; reservedCash: bigint; yes: bigint; no: bigint;
    reservedYes: bigint; reservedNo: bigint; nextNonce: bigint; everTraded: boolean; expectedReserve: { cash: bigint; yes: bigint; no: bigint } }> = [];
  const wallets = new Set<Address>();
  let cash = 0n;
  for (let i = 0; i < 256; i++) {
    const o = 48 + i * 128;
    if (i >= count) { if (seats.subarray(o, o + 128).some(Boolean)) throw new Error("Nonzero unused seat"); continue; }
    const wallet = key(seats, o);
    if (wallet === ZERO || wallets.has(wallet)) throw new Error("Invalid/duplicate seat owner");
    wallets.add(wallet);
    const [enrollment] = await getProgramDerivedAddress({ programAddress,
      seeds: ["enrollment", getAddressEncoder().encode(canonical.config), getAddressEncoder().encode(wallet)] });
    if (key(seats, o + 32) !== enrollment || seats[o + 120] > 1 || seats.subarray(o + 121, o + 128).some(Boolean)) throw new Error("Invalid seat enrollment/flags");
    const row = { index: i, wallet, availableCash: s.getBigUint64(o + 64, true), reservedCash: s.getBigUint64(o + 72, true),
      yes: s.getBigUint64(o + 80, true), no: s.getBigUint64(o + 88, true), reservedYes: s.getBigUint64(o + 96, true),
      reservedNo: s.getBigUint64(o + 104, true), nextNonce: s.getBigUint64(o + 112, true), everTraded: seats[o + 120] === 1,
      expectedReserve: { cash: 0n, yes: 0n, no: 0n } };
    if (row.reservedYes > row.yes || row.reservedNo > row.no) throw new Error("Positions over-reserved");
    seatRows.push(row); cash += row.availableCash + row.reservedCash;
  }
  if (cash + m.getBigUint64(176, true) + m.getBigUint64(184, true) !== m.getBigUint64(168, true)) throw new Error("Market aggregate accounting mismatch");
  const resolution = resolutionAccount ? await readResolutionState(programAddress,
    { market: marketAddress, config: canonical.config, creator: key(market, 40), payoutMilli: payout,
      closesAt: m.getBigInt64(152, true), resolvesAt: m.getBigInt64(160, true) }, resolutionAccount) : null;
  verifyPositionBacking({ payoutMilli: payout, collateral: m.getBigUint64(176, true), seats: seatRows, resolution,
    openOrders: b.getUint16(78, true) });
  const revision = b.getBigUint64(56, true), nextSequence = b.getBigUint64(64, true);
  const bidLength = b.getUint16(74, true), askLength = b.getUint16(76, true), activeLength = b.getUint16(78, true), freeHead = b.getUint16(80, true);
  if (new TextDecoder().decode(book.subarray(0, 8)) !== "GOOSEYB1" || key(book, 8) !== marketAddress
    || b.getBigUint64(40, true) !== 1n || b.getBigUint64(48, true) !== payout || nextSequence === 0n
    || b.getUint16(72, true) !== CAPACITY || b.getUint16(82, true) !== feeBps || book.subarray(84, 88).some(Boolean)
    || bidLength + askLength !== activeLength || activeLength > CAPACITY) throw new Error("Invalid ready book header");
  const occupied = new Map<number, Omit<CanonicalBookOrder, "heapIndex">>(), free = new Set<number>(), ids = new Set<bigint>();
  for (let slot = 0; slot < CAPACITY; slot++) {
    const o = SLOT_BASE + slot * 64, flags = b.getUint16(o + 56, true);
    if (book.subarray(o + 60, o + 64).some(Boolean)) throw new Error("Invalid slot padding");
    if (flags === 0) {
      if (book.subarray(o, o + 56).some(Boolean)) throw new Error("Dirty free slot");
      free.add(slot); continue;
    }
    if (!(flags & 1) || flags > 15 || b.getUint16(o + 58, true) !== NONE) throw new Error("Invalid occupied slot flags/link");
    const id = b.getBigUint64(o, true), owner = b.getBigUint64(o + 8, true), limitPrice = b.getBigUint64(o + 16, true),
      remaining = b.getBigUint64(o + 24, true), sequence = b.getBigUint64(o + 32, true), expiry = b.getBigInt64(o + 40, true), chainNotional = b.getBigUint64(o + 48, true);
    if (id === 0n || id !== sequence || id >= nextSequence || ids.has(id)) throw new Error("Invalid/duplicate order ID or sequence");
    ids.add(id);
    if (owner >= BigInt(count)) throw new Error("Invalid order owner seat");
    if (limitPrice === 0n || limitPrice >= payout || remaining === 0n || remaining > 10_000_000n
      || (flags & 8 ? expiry <= 0n : expiry !== 0n)) throw new Error("Invalid order price/quantity/expiry encoding");
    const outcome = flags & 2 ? "NO" : "YES", action = flags & 4 ? "SELL" : "BUY";
    const side = (outcome === "YES") === (action === "BUY") ? "BID" : "ASK";
    const reserve = { cash: 0n, yes: 0n, no: 0n };
    if (action === "BUY") {
      const principal = checked(limitPrice * remaining), total = checked(chainNotional + principal);
      const fee = (n: bigint) => (n * BigInt(feeBps) + 9999n) / 10000n;
      reserve.cash = checked(principal + fee(total) - fee(chainNotional));
    } else if (outcome === "YES") reserve.yes = remaining;
    else reserve.no = remaining;
    const seat = seatRows[Number(owner)]!;
    for (const field of ["cash", "yes", "no"] as const) seat.expectedReserve[field] = checked(seat.expectedReserve[field] + reserve[field]);
    occupied.set(slot, { slot, id, sequence, ownerSeat: Number(owner), wallet: seat.wallet, outcome, action, side, limitPrice,
      canonicalYesPrice: outcome === "YES" ? limitPrice : payout - limitPrice, remaining, chainNotional, expiresAt: flags & 8 ? expiry : null, reserve });
  }
  if (occupied.size !== activeLength) throw new Error("Book occupied count mismatch");
  const visitedFree = new Set<number>();
  for (let cursor = freeHead; cursor !== NONE; cursor = b.getUint16(SLOT_BASE + cursor * 64 + 58, true)) {
    if (!free.has(cursor) || visitedFree.has(cursor)) throw new Error("Invalid/cyclic book free list");
    visitedFree.add(cursor);
  }
  if (visitedFree.size !== free.size) throw new Error("Orphaned free slot");
  const visited = new Set<number>();
  const heap = (base: number, length: number, side: "BID" | "ASK") => {
    const orders: CanonicalBookOrder[] = [];
    for (let i = 0; i < CAPACITY; i++) {
      const index = b.getUint16(base + i * 2, true);
      if (i >= length) { if (index !== NONE) throw new Error("Dirty heap tail"); continue; }
      const order = occupied.get(index);
      if (!order || order.side !== side || visited.has(index)) throw new Error("Invalid/duplicate heap order");
      visited.add(index); orders.push({ ...order, heapIndex: i });
      if (i > 0 && priority(orders[Math.floor((i - 1) / 2)]!, order) > 0) throw new Error("Invalid price/time heap priority");
    }
    return orders.sort(priority);
  };
  const bids = heap(BID_BASE, bidLength, "BID"), asks = heap(ASK_BASE, askLength, "ASK");
  if (visited.size !== occupied.size) throw new Error("Orphaned occupied order");
  for (const seat of seatRows) {
    if (seat.reservedCash !== seat.expectedReserve.cash || seat.reservedYes !== seat.expectedReserve.yes || seat.reservedNo !== seat.expectedReserve.no) {
      throw new Error("Seat reserves do not reconcile to full book");
    }
  }
  return { market: marketAddress, book: bookAddress, seats: seatsAddress, revision, nextSequence, payoutMilli: payout, feeBps,
    bids, asks, orders: [...bids, ...asks], seatReserves: seatRows, reservesReconciled: true as const,
    exchangeVerified: false as const };
}
