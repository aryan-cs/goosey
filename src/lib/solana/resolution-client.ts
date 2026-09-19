import { AccountRole, address, assertIsTransactionSigner, getAddressEncoder, getProgramDerivedAddress,
  type Address, type Instruction, type TransactionSigner } from "@solana/kit";
import { SYSTEM_PROGRAM_ADDRESS } from "@solana-program/system";
import { deriveGooseyMarketAddresses, type EscrowMarketInput } from "./escrow-client";
import { deriveGooseyBookAddress } from "./exchange-client";

export type ResolutionOutcome = "YES" | "NO" | "VOID";
export type ResolutionFingerprint = {
  sequence: bigint; outcome: ResolutionOutcome; reasonDigest: Uint8Array; evidenceDigest: Uint8Array;
};
type Base = EscrowMarketInput & { seats: Address };
const key = (value: Address) => getAddressEncoder().encode(address(value));
const meta = (value: Address, writable = false) => ({ address: value, role: writable ? AccountRole.WRITABLE : AccountRole.READONLY });
function signer(value: TransactionSigner, writable: boolean) {
  assertIsTransactionSigner(value); address(value.address);
  if (value.address === SYSTEM_PROGRAM_ADDRESS) throw new Error("Signer must be nonzero");
  return { address: value.address, signer: value, role: writable ? AccountRole.WRITABLE_SIGNER : AccountRole.READONLY_SIGNER };
}
function sequenceBytes(value: bigint) {
  if (typeof value !== "bigint" || value < 1n || value > (1n << 64n) - 1n) throw new Error("Invalid proposal sequence");
  const bytes = new Uint8Array(8); new DataView(bytes.buffer).setBigUint64(0, value, true); return bytes;
}
function seatBytes(value: number) {
  if (!Number.isInteger(value) || value < 0 || value >= 256) throw new Error("Invalid seat index");
  const bytes = new Uint8Array(4); new DataView(bytes.buffer).setUint32(0, value, true); return bytes;
}
function digest(value: Uint8Array) {
  if (!(value instanceof Uint8Array) || value.length !== 32 || !value.some(byte => byte !== 0)) throw new Error("Digest must be 32 nonzero-content bytes");
  return new Uint8Array(value);
}
function fingerprint(value: ResolutionFingerprint) {
  const outcome = value.outcome === "YES" ? 0 : value.outcome === "NO" ? 1 : value.outcome === "VOID" ? 2 : -1;
  if (outcome < 0) throw new Error("Invalid resolution outcome");
  return [sequenceBytes(value.sequence), new Uint8Array([outcome]), digest(value.reasonDigest), digest(value.evidenceDigest)];
}
async function encode(name: string, fields: Uint8Array[] = []) {
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`global:${name}`));
  const result = new Uint8Array(8 + fields.reduce((n, field) => n + field.length, 0));
  result.set(new Uint8Array(hash, 0, 8)); let offset = 8;
  for (const field of fields) { result.set(field, offset); offset += field.length; }
  return result;
}
async function pda(programAddress: Address, seed: string, market: Address, suffix?: Uint8Array) {
  return getProgramDerivedAddress({ programAddress, seeds: [seed, key(market), ...(suffix ? [suffix] : [])] });
}
export async function deriveGooseyResolutionAddresses(input: EscrowMarketInput) {
  const programAddress = address(input.programAddress);
  const base = await deriveGooseyMarketAddresses({ programAddress, marketId: input.marketId });
  const [{ book, bookBump }, [resolution, resolutionBump]] = await Promise.all([
    deriveGooseyBookAddress(programAddress, base.market), pda(programAddress, "resolution", base.market),
  ]);
  return { ...base, book, bookBump, resolution, resolutionBump };
}
function capture(input: Base) {
  return { programAddress: address(input.programAddress), marketId: input.marketId, seats: address(input.seats) };
}
async function enrollment(programAddress: Address, config: Address, wallet: Address) {
  return (await getProgramDerivedAddress({ programAddress, seeds: ["enrollment", key(config), key(wallet)] }))[0];
}

/** Pure unsigned ABI builders. Chain state, authority, clock, settlement and
 * successful execution are NOT verified here. Seats must come from a verified
 * market read. Resolution instructions have no order nonce argument.
 */
export async function buildInitializeResolutionInstruction(input: Base & {
  creator: TransactionSigner; proposer: Address; approver: Address;
}) {
  const base = capture(input), creator = signer(input.creator, true);
  const proposer = address(input.proposer), approver = address(input.approver);
  if (proposer === SYSTEM_PROGRAM_ADDRESS || approver === SYSTEM_PROGRAM_ADDRESS || proposer === approver
    || proposer === creator.address || approver === creator.address) throw new Error("Reviewers must be distinct nonzero wallets other than creator");
  const a = await deriveGooseyResolutionAddresses(base);
  const [proposerEnrollment, approverEnrollment] = await Promise.all([
    enrollment(base.programAddress, a.config, proposer), enrollment(base.programAddress, a.config, approver),
  ]);
  const instruction = { programAddress: base.programAddress, accounts: [creator, meta(a.config), meta(a.market, true), meta(base.seats),
    meta(a.book, true), meta(proposerEnrollment), meta(approverEnrollment), meta(a.resolution, true), meta(SYSTEM_PROGRAM_ADDRESS)],
    data: await encode("initialize_resolution") } satisfies Instruction;
  return { ...a, proposerEnrollment, approverEnrollment, instruction };
}
async function keeperInstruction(input: Base & { keeper: TransactionSigner }, name: string) {
  const base = capture(input), keeper = signer(input.keeper, false);
  const a = await deriveGooseyResolutionAddresses(base);
  const instruction = { programAddress: base.programAddress, accounts: [keeper, meta(a.market, true), meta(base.seats),
    meta(a.book, true), meta(a.resolution, true), meta(a.vault)], data: await encode(name) } satisfies Instruction;
  return { ...a, instruction };
}
export const buildCloseResolutionInstruction = (input: Base & { keeper: TransactionSigner }) => keeperInstruction(input, "close_resolution");
export const buildFinalizeResolutionInstruction = (input: Base & { keeper: TransactionSigner }) => keeperInstruction(input, "finalize_resolution");

async function proposalInstruction(input: Base & { reviewer: TransactionSigner }, name: string, fields: Uint8Array[], proposing: boolean) {
  const base = capture(input), reviewer = signer(input.reviewer, proposing);
  const a = await deriveGooseyResolutionAddresses(base);
  const [[proposal, proposalBump], reviewerEnrollment] = await Promise.all([
    pda(base.programAddress, "resolution_proposal", a.market, fields[0]), enrollment(base.programAddress, a.config, reviewer.address),
  ]);
  const instruction = { programAddress: base.programAddress, accounts: [reviewer, meta(a.config), meta(a.market, true), meta(base.seats),
    meta(reviewerEnrollment), meta(reviewer.address), meta(a.resolution, true), meta(proposal, true),
    ...(proposing ? [meta(SYSTEM_PROGRAM_ADDRESS)] : [])], data: await encode(name, fields) } satisfies Instruction;
  return { ...a, proposal, proposalBump, reviewerEnrollment, instruction };
}
export function buildProposeResolutionInstruction(input: Base & { reviewer: TransactionSigner } & ResolutionFingerprint) {
  const fields = fingerprint(input);
  if (input.sequence === (1n << 64n) - 1n) throw new Error("Proposal sequence cannot advance");
  return proposalInstruction(input, "propose_resolution", fields, true);
}
/** The PDA sequence and expected fingerprint sequence are intentionally supplied
 * once and encoded twice. Approval binds outcome AND both 32-byte digests, not
 * just the proposal account or sequence. No hashing/normalization of caller text.
 */
export function buildApproveResolutionInstruction(input: Base & { reviewer: TransactionSigner; expected: ResolutionFingerprint }) {
  const fields = fingerprint(input.expected);
  return proposalInstruction(input, "approve_resolution", [fields[0], ...fields], false);
}
export function buildRejectResolutionInstruction(input: Base & { reviewer: TransactionSigner; expected: ResolutionFingerprint; reviewDigest: Uint8Array }) {
  const fields = fingerprint(input.expected);
  return proposalInstruction(input, "reject_resolution", [fields[0], ...fields, digest(input.reviewDigest)], false);
}
/** Permissionless claim credits the actual seat's internal cash; payer is not
 * necessarily its owner. No wallet, payout amount or nonce is fabricated. */
export async function buildClaimResolutionInstruction(input: Base & { payer: TransactionSigner; seatIndex: number }) {
  const base = capture(input), payer = signer(input.payer, true), index = seatBytes(input.seatIndex);
  const a = await deriveGooseyResolutionAddresses(base);
  const [receipt, receiptBump] = await pda(base.programAddress, "resolution_claim", a.market, index);
  const instruction = { programAddress: base.programAddress, accounts: [payer, meta(a.market, true), meta(base.seats, true), meta(a.book, true),
    meta(a.resolution, true), meta(receipt, true), meta(a.vault), meta(SYSTEM_PROGRAM_ADDRESS)], data: await encode("claim_resolution", [index]) } satisfies Instruction;
  return { ...a, receipt, receiptBump, instruction };
}
