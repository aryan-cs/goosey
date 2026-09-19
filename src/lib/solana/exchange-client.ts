import { AccountRole, address, assertIsTransactionSigner, getAddressEncoder, getProgramDerivedAddress,
  type Address, type Instruction, type TransactionSigner } from "@solana/kit";
import { SYSTEM_PROGRAM_ADDRESS } from "@solana-program/system";
import { deriveGooseyMarketAddresses, deriveGooseySeatAddresses } from "./escrow-client";

export const GOOSEY_BOOK_BYTES = 69_720;
export const GOOSEY_BOOK_GROWTH = 10_240;
const U64_MAX = (1n << 64n) - 1n;
function integer(value: bigint, name: string, max = U64_MAX, minimum = 0n) {
  if (typeof value !== "bigint" || value < minimum || value > max) throw new Error(`Invalid ${name}`);
  const bytes = new Uint8Array(8); new DataView(bytes.buffer).setBigUint64(0, value, true); return bytes;
}
function signer(value: TransactionSigner, writable: boolean) {
  assertIsTransactionSigner(value); address(value.address);
  if (value.address === SYSTEM_PROGRAM_ADDRESS) throw new Error("Signer must be nonzero");
  return { address: value.address, signer: value, role: writable ? AccountRole.WRITABLE_SIGNER : AccountRole.READONLY_SIGNER };
}
async function data(name: string, ...fields: Uint8Array[]) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`global:${name}`));
  const bytes = new Uint8Array(8 + fields.reduce((sum, field) => sum + field.length, 0));
  bytes.set(new Uint8Array(digest, 0, 8)); let offset = 8;
  for (const field of fields) { bytes.set(field, offset); offset += field.length; }
  return bytes;
}
const meta = (key: Address, writable = false) => ({ address: key, role: writable ? AccountRole.WRITABLE : AccountRole.READONLY });
export async function deriveGooseyBookAddress(programAddress: Address, market: Address) {
  const [book, bookBump] = await getProgramDerivedAddress({ programAddress: address(programAddress),
    seeds: ["order_book", getAddressEncoder().encode(address(market))] });
  return { book, bookBump };
}

/** Build exactly one setup step. Read/confirm the actual account between growth
 * transactions so each expected size comes from observed state. The program
 * bounds each resize; this client does not infer aggregate runtime limits.
 * No rent quote, account allocation, readiness or confirmation is fabricated. */
export async function buildBookSetupInstruction(input: {
  programAddress: Address; marketId: bigint; admin: TransactionSigner;
  step: { kind: "create" } | { kind: "grow"; expectedSize: number } | { kind: "finalize" };
}) {
  const programAddress = address(input.programAddress), admin = signer(input.admin, true);
  const kind = input.step.kind;
  let fields: Uint8Array[] = [];
  if (kind === "grow") {
    const size = input.step.expectedSize;
    if (!Number.isSafeInteger(size) || size < GOOSEY_BOOK_GROWTH || size >= GOOSEY_BOOK_BYTES || size % GOOSEY_BOOK_GROWTH !== 0) throw new Error("Invalid expected draft size");
    const bytes = new Uint8Array(4); new DataView(bytes.buffer).setUint32(0, size, true); fields = [bytes];
  } else if (kind !== "create" && kind !== "finalize") throw new Error("Invalid book setup step");
  const addresses = await deriveGooseyMarketAddresses({ programAddress, marketId: input.marketId });
  const book = await deriveGooseyBookAddress(programAddress, addresses.market);
  const instruction = { programAddress, accounts: [admin, meta(addresses.config), meta(addresses.market), meta(book.book, true), meta(SYSTEM_PROGRAM_ADDRESS)],
    data: await data(`${kind}_book`, ...fields) } satisfies Instruction;
  return { ...addresses, ...book, instruction };
}

export type ChainOrderInput = {
  programAddress: Address; marketId: bigint; wallet: TransactionSigner; seats: Address;
  expectedNonce: bigint; price: bigint; quantity: bigint;
  outcome: "YES" | "NO"; action: "BUY" | "SELL";
  timeInForce: "GTC" | "IOC" | "FOK";
  selfTrade: "CANCEL_AGGRESSOR" | "CANCEL_RESTING" | "CANCEL_BOTH";
  postOnly?: boolean; expiresAt?: bigint; touches?: number;
};
/** Exact Anchor Borsh builder. Prices are outcome prices in feather base units;
 * canonical YES normalization belongs to the program. Fees/owner/order ID and
 * sequence are assigned on-chain, never accepted as client-controlled fields.
 * Caller must read the market payout/nonce and request wallet approval. */
export async function buildPlaceOrderInstruction(input: ChainOrderInput) {
  const programAddress = address(input.programAddress), wallet = signer(input.wallet, false), seats = address(input.seats);
  const outcomes = { YES: 0, NO: 1 }, actions = { BUY: 0, SELL: 1 };
  const tif = { GTC: 0, IOC: 1, FOK: 2 }, stp = { CANCEL_AGGRESSOR: 0, CANCEL_RESTING: 1, CANCEL_BOTH: 2 };
  const codes = [outcomes[input.outcome], actions[input.action], tif[input.timeInForce], stp[input.selfTrade]];
  if (codes.some(value => !Number.isInteger(value))) throw new Error("Invalid order options");
  const postOnly = input.postOnly ?? false, touches = input.touches ?? 0;
  if (typeof postOnly !== "boolean" || !Number.isInteger(touches) || touches < 0 || touches > 16
    || ((postOnly || input.expiresAt !== undefined) && input.timeInForce !== "GTC")) throw new Error("Invalid order options");
  const expiry = input.expiresAt === undefined ? [new Uint8Array([0])] : [new Uint8Array([1]), integer(input.expiresAt, "expiry", (1n << 63n) - 1n, 1n)];
  const fields = [integer(input.expectedNonce, "nonce", U64_MAX - 1n), integer(input.price, "price", 999_999n, 1n),
    integer(input.quantity, "quantity", 10_000_000n, 1n), new Uint8Array(codes), new Uint8Array([postOnly ? 1 : 0]), ...expiry, new Uint8Array([touches])];
  const addresses = await deriveGooseySeatAddresses({ programAddress, marketId: input.marketId, wallet: wallet.address });
  const book = await deriveGooseyBookAddress(programAddress, addresses.market);
  const [resolution] = await getProgramDerivedAddress({ programAddress,
    seeds: ["resolution", getAddressEncoder().encode(addresses.market)] });
  const instruction = { programAddress, accounts: [wallet, meta(addresses.config), meta(addresses.market, true), meta(seats, true),
    meta(addresses.locator), meta(addresses.vault), meta(book.book, true), meta(resolution)], data: await data("place_order", ...fields) } satisfies Instruction;
  return { ...addresses, ...book, resolution, seats, instruction };
}

export type ChainOrderTarget = { orderId: bigint; side: "BID" | "ASK"; heapIndex: number };
function targetBytes(target: ChainOrderTarget) {
  const id = integer(target.orderId, "order ID", U64_MAX, 1n);
  if ((target.side !== "BID" && target.side !== "ASK") || !Number.isInteger(target.heapIndex)
    || target.heapIndex < 0 || target.heapIndex >= 1024) throw new Error("Invalid order target");
  const result = new Uint8Array(11); result.set(id); result[8] = target.side === "BID" ? 0 : 1;
  new DataView(result.buffer).setUint16(9, target.heapIndex, true);
  return result;
}

/** Owner-authorized removal. Heap position is only a hint: the program checks
 * order ID, actual owner and nonce before releasing any reserve. A stale hint
 * must be refreshed, never silently redirected to another resting order. */
export async function buildCancelOrderInstruction(input: {
  programAddress: Address; marketId: bigint; wallet: TransactionSigner; seats: Address;
  target: ChainOrderTarget; expectedNonce: bigint;
}) {
  const programAddress = address(input.programAddress), wallet = signer(input.wallet, false), seats = address(input.seats);
  const target = targetBytes(input.target), nonce = integer(input.expectedNonce, "nonce", U64_MAX - 1n);
  const addresses = await deriveGooseySeatAddresses({ programAddress, marketId: input.marketId, wallet: wallet.address });
  const book = await deriveGooseyBookAddress(programAddress, addresses.market);
  const instruction = { programAddress, accounts: [wallet, meta(addresses.config), meta(addresses.market), meta(seats, true),
    meta(addresses.locator), meta(book.book, true)], data: await data("cancel_order", target, nonce) } satisfies Instruction;
  return { ...addresses, ...book, seats, instruction };
}

/** Permissionless bounded cleanup. The chain Clock must prove expiry or market
 * close; no client time or owner's nonce is accepted. Transaction fee payer
 * signing remains necessary even though this instruction has no signer account. */
export async function buildCleanupOrderInstruction(input: {
  programAddress: Address; marketId: bigint; seats: Address; target: ChainOrderTarget;
}) {
  const programAddress = address(input.programAddress), seats = address(input.seats), target = targetBytes(input.target);
  const addresses = await deriveGooseyMarketAddresses({ programAddress, marketId: input.marketId });
  const book = await deriveGooseyBookAddress(programAddress, addresses.market);
  const instruction = { programAddress, accounts: [meta(addresses.config), meta(addresses.market), meta(seats, true), meta(book.book, true)],
    data: await data("cleanup_order", target) } satisfies Instruction;
  return { ...addresses, ...book, seats, instruction };
}
