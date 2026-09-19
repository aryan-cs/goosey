import { AccountRole, address, assertIsTransactionSigner, getAddressDecoder, getAddressEncoder, getProgramDerivedAddress,
  type Address, type Instruction, type TransactionSigner } from "@solana/kit";
import { SYSTEM_PROGRAM_ADDRESS } from "@solana-program/system";
import { MARKET_TERMS_MAX_BYTES } from "./market-terms";

export const MARKET_TERMS_ACCOUNT_BYTES = 240;
type Base = { programAddress: Address; marketId: bigint; seats: Address };
type Reviewer = { wallet: Address; enrollment: Address };
export type MarketTermsAccountBinding = {
  programAddress: Address; marketId: bigint; config: Address; market: Address; creator: Address;
  proposer: Reviewer; approver: Reviewer;
};
const enc = getAddressEncoder(), dec = getAddressDecoder();
function key(value: Address): Address {
  const result = address(value);
  if (result === SYSTEM_PROGRAM_ADDRESS) throw new Error("Terms identity must be nonzero");
  return result;
}
function marketId(value: bigint) {
  if (typeof value !== "bigint" || value < 0n || value > (1n << 64n) - 1n) throw new Error("Invalid market ID");
  return value;
}
function digest(value: Uint8Array) {
  if (!(value instanceof Uint8Array) || value.length !== 32 || !value.some(n => n !== 0)) throw new Error("Invalid terms digest");
  return new Uint8Array(value);
}
function length(value: number) {
  if (!Number.isInteger(value) || value < 1 || value > MARKET_TERMS_MAX_BYTES) throw new Error("Invalid manifest length");
  return value;
}
function independent(creator: Address, proposer: Address, approver: Address) {
  if (creator === proposer || creator === approver || proposer === approver) throw new Error("Conflicting terms reviewers");
}
const meta = (value: Address, writable = false) => ({ address: value, role: writable ? AccountRole.WRITABLE : AccountRole.READONLY });
function signer(value: TransactionSigner, writable: boolean) {
  assertIsTransactionSigner(value);
  return { address: key(value.address), signer: value, role: writable ? AccountRole.WRITABLE_SIGNER : AccountRole.READONLY_SIGNER };
}
const stableSigner = (value: ReturnType<typeof signer>) => {
  if (value.signer.address !== value.address) throw new Error("Signer identity changed during terms construction");
};
async function discriminator(namespace: "global" | "account", name: string) {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${namespace}:${name}`))).slice(0, 8);
}
async function data(name: string, fields: Uint8Array[]) {
  const bytes = new Uint8Array(8 + fields.reduce((n, f) => n + f.length, 0));
  bytes.set(await discriminator("global", name)); let offset = 8;
  for (const field of fields) { bytes.set(field, offset); offset += field.length; }
  return bytes;
}
export async function deriveGooseyMarketTermsAddresses(input: { programAddress: Address; marketId: bigint }) {
  const programAddress = key(input.programAddress), id = marketId(input.marketId), idBytes = new Uint8Array(8);
  new DataView(idBytes.buffer).setBigUint64(0, id, true);
  const pda = (seeds: Parameters<typeof getProgramDerivedAddress>[0]["seeds"]) => getProgramDerivedAddress({ programAddress, seeds });
  const [config] = await pda(["config"]);
  const [market] = await pda(["market", enc.encode(config), idBytes]);
  const [[book], [terms, termsBump]] = await Promise.all([pda(["order_book", enc.encode(market)]), pda(["market_terms", enc.encode(market)])]);
  return { config, market, book, terms, termsBump };
}
const enrollment = async (programAddress: Address, config: Address, wallet: Address) =>
  (await getProgramDerivedAddress({ programAddress, seeds: ["enrollment", enc.encode(config), enc.encode(wallet)] }))[0];
const capture = (input: Base) => ({ programAddress: key(input.programAddress), marketId: marketId(input.marketId), seats: key(input.seats) });

/** Pure unsigned ABI construction: no network, signing, eligibility or execution proof.
 * Order/roles match docs/solana-market-terms.md. Caller supplies actual market seats. */
export async function buildInitializeMarketTermsInstruction(input: Base & {
  creator: TransactionSigner; proposer: Address; approver: Address; version: 1; digest: Uint8Array; manifestLength: number;
}) {
  const base = capture(input), creator = signer(input.creator, true), proposer = key(input.proposer), approver = key(input.approver);
  const hash = digest(input.digest), size = length(input.manifestLength);
  if (input.version !== 1) throw new Error("Unsupported terms version");
  independent(creator.address, proposer, approver);
  const sizeBytes = new Uint8Array(4); new DataView(sizeBytes.buffer).setUint32(0, size, true);
  const a = await deriveGooseyMarketTermsAddresses(base);
  const [proposerEnrollment, approverEnrollment] = await Promise.all([
    enrollment(base.programAddress, a.config, proposer), enrollment(base.programAddress, a.config, approver),
  ]);
  const payload = await data("initialize_market_terms", [new Uint8Array([1]), hash, sizeBytes]); stableSigner(creator);
  const instruction = { programAddress: base.programAddress, accounts: [creator, meta(a.config), meta(a.market), meta(base.seats),
    meta(a.book), meta(proposerEnrollment), meta(approverEnrollment), meta(a.terms, true), meta(SYSTEM_PROGRAM_ADDRESS)], data: payload } satisfies Instruction;
  return { ...a, seats: base.seats, proposerEnrollment, approverEnrollment, instruction };
}
export async function buildAcceptMarketTermsInstruction(input: Base & { reviewer: TransactionSigner; expectedDigest: Uint8Array }) {
  const base = capture(input), reviewer = signer(input.reviewer, false), hash = digest(input.expectedDigest);
  const a = await deriveGooseyMarketTermsAddresses(base), reviewerEnrollment = await enrollment(base.programAddress, a.config, reviewer.address);
  const payload = await data("accept_market_terms", [hash]); stableSigner(reviewer);
  const instruction = { programAddress: base.programAddress, accounts: [reviewer, meta(a.config), meta(a.market), meta(base.seats),
    meta(reviewerEnrollment), meta(a.terms, true)], data: payload } satisfies Instruction;
  return { ...a, seats: base.seats, reviewerEnrollment, instruction };
}
export async function buildSealMarketTermsInstruction(input: Base & { creator: TransactionSigner; expectedDigest: Uint8Array }) {
  const base = capture(input), creator = signer(input.creator, false), hash = digest(input.expectedDigest);
  const a = await deriveGooseyMarketTermsAddresses(base);
  const payload = await data("seal_market_terms", [hash]); stableSigner(creator);
  const instruction = { programAddress: base.programAddress, accounts: [creator, meta(a.config), meta(a.market), meta(base.seats),
    meta(a.book), meta(a.terms, true)], data: payload } satisfies Instruction;
  return { ...a, seats: base.seats, instruction };
}

/** Pure account decoder, NOT a finalized read or manifest verification. Exact
 * 240-byte Borsh layout has no padding; extra bytes, even zeros, are invalid.
 * Expected binding must come from independently known market/resolution state. */
export async function readMarketTermsAccount(binding: MarketTermsAccountBinding, account: {
  address: Address; owner: Address; executable: boolean; data: Uint8Array;
}) {
  const expected = { programAddress: key(binding.programAddress), marketId: marketId(binding.marketId), config: key(binding.config),
    market: key(binding.market), creator: key(binding.creator),
    proposer: { wallet: key(binding.proposer.wallet), enrollment: key(binding.proposer.enrollment) },
    approver: { wallet: key(binding.approver.wallet), enrollment: key(binding.approver.enrollment) } };
  independent(expected.creator, expected.proposer.wallet, expected.approver.wallet);
  const accountAddress = key(account.address);
  if (account.owner !== expected.programAddress || account.executable !== false || !(account.data instanceof Uint8Array)
    || account.data.length !== MARKET_TERMS_ACCOUNT_BYTES) throw new Error("Invalid terms account envelope");
  const bytes = new Uint8Array(account.data), view = new DataView(bytes.buffer);
  const a = await deriveGooseyMarketTermsAddresses(expected);
  if (a.config !== expected.config || a.market !== expected.market || a.terms !== accountAddress) throw new Error("Noncanonical terms/market/config PDA");
  const disc = await discriminator("account", "MarketTerms");
  if (!disc.every((n, i) => bytes[i] === n)) throw new Error("Invalid MarketTerms discriminator");
  if (bytes[8] !== 1) throw new Error("Unsupported terms version");
  const pubkey = (offset: number) => key(dec.decode(bytes.subarray(offset, offset + 32)));
  const market = pubkey(9), creator = pubkey(41), hash = digest(bytes.slice(73, 105)), manifestLength = length(view.getUint32(105, true));
  const proposer = { wallet: pubkey(109), enrollment: pubkey(141) }, approver = { wallet: pubkey(173), enrollment: pubkey(205) };
  if (market !== expected.market || creator !== expected.creator || proposer.wallet !== expected.proposer.wallet
    || proposer.enrollment !== expected.proposer.enrollment || approver.wallet !== expected.approver.wallet
    || approver.enrollment !== expected.approver.enrollment) throw new Error("Terms account binding mismatch");
  for (const who of [proposer, approver]) {
    if (await enrollment(expected.programAddress, a.config, who.wallet) !== who.enrollment) throw new Error("Noncanonical terms reviewer enrollment");
  }
  const acceptanceBits = bytes[237], sealedByte = bytes[238], bump = bytes[239];
  if (acceptanceBits > 3 || sealedByte > 1 || (sealedByte === 1 && acceptanceBits !== 3)) throw new Error("Invalid terms acceptance/sealed state");
  if (bump !== a.termsBump) throw new Error("Invalid terms PDA bump");
  return { address: accountAddress, version: 1 as const, market, creator, digest: hash, manifestLength, proposer, approver,
    acceptanceBits, sealed: sealedByte === 1, bump };
}
