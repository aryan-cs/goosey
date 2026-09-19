import {
  AccountRole, address, assertIsTransactionSigner, getAddressEncoder, getProgramDerivedAddress,
  type AccountNonSignerMeta, type AccountSignerMeta, type Address, type Instruction, type TransactionSigner,
} from "@solana/kit";
import { ASSOCIATED_TOKEN_PROGRAM_ADDRESS, TOKEN_PROGRAM_ADDRESS, findAssociatedTokenPda } from "@solana-program/token";
import { SYSTEM_PROGRAM_ADDRESS, getCreateAccountInstruction } from "@solana-program/system";
import { deriveGooseyProgramAddresses } from "./program-client";

/** Anchor discriminator + sizeof(Seats), as asserted in escrow.rs. Not a PDA. */
export const GOOSEY_SEATS_ACCOUNT_SPACE = 32_816n;
const U64_MAX = (1n << 64n) - 1n;
const I64_MAX = (1n << 63n) - 1n;
const keyBytes = (key: Address) => getAddressEncoder().encode(address(key));
const ro = (key: Address): AccountNonSignerMeta => ({ address: key, role: AccountRole.READONLY });
const rw = (key: Address): AccountNonSignerMeta => ({ address: key, role: AccountRole.WRITABLE });
function signerMeta(signer: TransactionSigner, writable: boolean): AccountSignerMeta {
  assertIsTransactionSigner(signer);
  address(signer.address);
  if (signer.address === SYSTEM_PROGRAM_ADDRESS) throw new Error("Signer must be nonzero");
  return { address: signer.address, signer, role: writable ? AccountRole.WRITABLE_SIGNER : AccountRole.READONLY_SIGNER };
}
function uint(value: bigint, name: string, min = 0n, max = U64_MAX) {
  if (typeof value !== "bigint" || value < min || value > max) throw new Error(`${name} must be an in-range bigint`);
  const bytes = new Uint8Array(8);
  new DataView(bytes.buffer).setBigUint64(0, value, true);
  return bytes;
}
async function encode(name: string, ...fields: Uint8Array[]) {
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`global:${name}`));
  const bytes = new Uint8Array(8 + fields.reduce((total, field) => total + field.length, 0));
  bytes.set(new Uint8Array(hash, 0, 8));
  let offset = 8;
  for (const field of fields) { bytes.set(field, offset); offset += field.length; }
  return bytes;
}

export type EscrowMarketInput = { programAddress: Address; marketId: bigint };
export async function deriveGooseyMarketAddresses(input: EscrowMarketInput) {
  const programAddress = address(input.programAddress);
  const id = uint(input.marketId, "Market ID");
  const base = await deriveGooseyProgramAddresses(programAddress);
  const [market, marketBump] = await getProgramDerivedAddress({ programAddress, seeds: ["market", keyBytes(base.config), id] });
  const [vault] = await findAssociatedTokenPda({ owner: market, mint: base.featherMint, tokenProgram: TOKEN_PROGRAM_ADDRESS });
  return { ...base, market, marketBump, vault };
}

export async function deriveGooseySeatAddresses(input: EscrowMarketInput & { wallet: Address }) {
  const programAddress = address(input.programAddress);
  const wallet = address(input.wallet);
  const base = await deriveGooseyMarketAddresses(input);
  const [[enrollment, enrollmentBump], [locator, locatorBump], [walletTokens]] = await Promise.all([
    getProgramDerivedAddress({ programAddress, seeds: ["enrollment", keyBytes(base.config), keyBytes(wallet)] }),
    getProgramDerivedAddress({ programAddress, seeds: ["seat", keyBytes(base.market), keyBytes(wallet)] }),
    findAssociatedTokenPda({ owner: wallet, mint: base.featherMint, tokenProgram: TOKEN_PROGRAM_ADDRESS }),
  ]);
  return { ...base, enrollment, enrollmentBump, locator, locatorBump, walletTokens };
}

export type CreateEscrowMarketInput = EscrowMarketInput & {
  admin: TransactionSigner;
  /** Fresh keypair signer, never an existing wallet account or a PDA. */
  seats: TransactionSigner;
  /** Real getMinimumBalanceForRentExemption(32816) result from the pinned RPC.
   * Only integer/range validation is possible offline; no rent estimate is invented. */
  seatsRentLamports: bigint;
  seatsPayer?: TransactionSigner;
  payoutMilli: bigint;
  feeBps: number;
  closesAt: bigint;
  resolvesAt: bigint;
};

/** Build both instructions for ONE transaction: allocate the large Seats account
 * with System CreateAccount, then initialize/bind it via create_market. Client
 * derivation cannot verify fresh accounts, admin authority, rent or chain clock.
 */
export async function buildCreateMarketInstructions(input: CreateEscrowMarketInput) {
  const programAddress = address(input.programAddress);
  const marketId = input.marketId;
  const admin = signerMeta(input.admin, true);
  const seats = signerMeta(input.seats, true);
  const payer = input.seatsPayer ?? input.admin;
  signerMeta(payer, true);
  if (seats.address === admin.address || seats.address === payer.address || seats.address === programAddress) {
    throw new Error("Seats must be a separate new account");
  }
  uint(input.seatsRentLamports, "Seats rent", 1n);
  if (!Number.isInteger(input.feeBps) || input.feeBps < 0 || input.feeBps > 10_000) throw new Error("Fee bps must be an integer from 0 to 10000");
  const fee = new Uint8Array(2);
  new DataView(fee.buffer).setUint16(0, input.feeBps, true);
  const fields = [uint(marketId, "Market ID"), uint(input.payoutMilli, "Payout", 2n, 1_000_000n), fee,
    uint(input.closesAt, "Close time", 1n, I64_MAX), uint(input.resolvesAt, "Resolution time", 1n, I64_MAX)];
  if (input.resolvesAt < input.closesAt) throw new Error("Resolution cannot precede close time");
  // Materialize before awaiting so caller mutations cannot alter allocation parameters.
  const createSeatsInstruction = getCreateAccountInstruction({ payer, newAccount: input.seats,
    lamports: input.seatsRentLamports, space: GOOSEY_SEATS_ACCOUNT_SPACE, programAddress });
  const addresses = await deriveGooseyMarketAddresses({ programAddress, marketId });
  const instruction = { programAddress, accounts: [admin, ro(addresses.config), rw(addresses.market), rw(seats.address),
    ro(addresses.featherMint), rw(addresses.vault), ro(TOKEN_PROGRAM_ADDRESS), ro(ASSOCIATED_TOKEN_PROGRAM_ADDRESS), ro(SYSTEM_PROGRAM_ADDRESS)],
  data: await encode("create_market", ...fields) } satisfies Instruction;
  return { ...addresses, seats: seats.address, createSeatsInstruction, instruction, instructions: [createSeatsInstruction, instruction] as const };
}

export type EscrowWalletInput = EscrowMarketInput & {
  wallet: TransactionSigner;
  /** Read from the actual Market account; the program checks has_one = seats. */
  seats: Address;
};
export async function buildRegisterSeatInstruction(input: EscrowWalletInput) {
  const programAddress = address(input.programAddress);
  const wallet = signerMeta(input.wallet, true);
  const seats = address(input.seats);
  const addresses = await deriveGooseySeatAddresses({ programAddress, marketId: input.marketId, wallet: wallet.address });
  const instruction = { programAddress,
    accounts: [wallet, ro(addresses.config), ro(addresses.enrollment), ro(addresses.market), rw(seats), rw(addresses.locator), ro(SYSTEM_PROGRAM_ADDRESS)],
    data: await encode("register_seat"),
  } satisfies Instruction;
  return { ...addresses, seats, instruction };
}

export type EscrowCashInput = EscrowWalletInput & { amount: bigint; expectedNonce: bigint };
async function buildCashInstruction(name: "deposit" | "withdraw", input: EscrowCashInput) {
  const programAddress = address(input.programAddress);
  const wallet = signerMeta(input.wallet, false);
  const seats = address(input.seats);
  // A max-u64 nonce cannot increment: the current program fails it atomically.
  const fields = [uint(input.amount, "Amount", 1n), uint(input.expectedNonce, "Nonce", 0n, U64_MAX - 1n)];
  const addresses = await deriveGooseySeatAddresses({ programAddress, marketId: input.marketId, wallet: wallet.address });
  const instruction = { programAddress,
    accounts: [wallet, ro(addresses.config), rw(addresses.market), rw(seats), ro(addresses.locator), ro(addresses.featherMint),
      rw(addresses.walletTokens), rw(addresses.vault), ro(TOKEN_PROGRAM_ADDRESS)],
    data: await encode(name, ...fields),
  } satisfies Instruction;
  return { ...addresses, seats, instruction };
}

/** Build only; wallet ATA must already exist. No sender, balance or receipt is
 * synthesized. Obtain nonce from chain; after ambiguity inspect the same signature
 * and seat state, never silently retry with a new nonce. Fee payer is caller-owned.
 */
export const buildDepositInstruction = (input: EscrowCashInput) => buildCashInstruction("deposit", input);
export const buildWithdrawInstruction = (input: EscrowCashInput) => buildCashInstruction("withdraw", input);
