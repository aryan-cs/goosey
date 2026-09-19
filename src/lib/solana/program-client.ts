import {
  AccountRole, address, assertIsTransactionSigner, getAddressEncoder, getProgramDerivedAddress,
  type AccountNonSignerMeta, type AccountSignerMeta, type Address, type Instruction, type TransactionSigner,
} from "@solana/kit";
import {
  ASSOCIATED_TOKEN_PROGRAM_ADDRESS, TOKEN_PROGRAM_ADDRESS,
  findAssociatedTokenPda, getCreateAssociatedTokenIdempotentInstruction,
} from "@solana-program/token";
import { SYSTEM_PROGRAM_ADDRESS } from "@solana-program/system";

const LOADER = address("BPFLoaderUpgradeab1e11111111111111111111111");
const RENT = address("SysvarRent111111111111111111111111111111111");
const U64_MAX = (1n << 64n) - 1n;
const I64_MAX = (1n << 63n) - 1n;
const keyBytes = (key: Address) => getAddressEncoder().encode(address(key));
const ro = (key: Address): AccountNonSignerMeta => ({ address: key, role: AccountRole.READONLY });
const rw = (key: Address): AccountNonSignerMeta => ({ address: key, role: AccountRole.WRITABLE });
function signerMeta(signer: TransactionSigner, writable: boolean): AccountSignerMeta {
  assertIsTransactionSigner(signer);
  nonzeroKey(signer.address);
  return { address: signer.address, signer, role: writable ? AccountRole.WRITABLE_SIGNER : AccountRole.READONLY_SIGNER };
}
function nonzeroKey(key: Address) {
  address(key);
  if (key === SYSTEM_PROGRAM_ADDRESS) throw new Error("Authority/wallet must be nonzero");
  return key;
}
function digest32(bytes: Uint8Array, name: string) {
  if (!(bytes instanceof Uint8Array) || bytes.length !== 32 || !bytes.some((value) => value !== 0)) {
    throw new Error(`${name} must be exactly 32 nonzero-domain bytes`);
  }
  return new Uint8Array(bytes);
}
function integer(value: bigint, max: bigint, name: string) {
  if (typeof value !== "bigint" || value <= 0n || value > max) throw new Error(`${name} must be a positive in-range bigint`);
  const bytes = new Uint8Array(8);
  new DataView(bytes.buffer).setBigUint64(0, value, true);
  return bytes;
}
async function data(name: string, ...fields: Uint8Array[]) {
  const hash = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(`global:${name}`));
  const output = new Uint8Array(8 + fields.reduce((size, field) => size + field.length, 0));
  output.set(new Uint8Array(hash, 0, 8));
  let offset = 8;
  for (const field of fields) { output.set(field, offset); offset += field.length; }
  return output;
}

/** Canonical seed/bump search; programAddress must come from pinned caller config.
 * Derivation does not prove deployment, upgrade authority, balances, or receipts.
 */
export async function deriveGooseyProgramAddresses(programAddress: Address) {
  address(programAddress);
  const [config, configBump] = await getProgramDerivedAddress({ programAddress, seeds: ["config"] });
  const [[mintAuthority, mintAuthorityBump], [featherMint, featherMintBump], [programData, programDataBump]] = await Promise.all([
    getProgramDerivedAddress({ programAddress, seeds: ["mint_authority", keyBytes(config)] }),
    getProgramDerivedAddress({ programAddress, seeds: ["feather_mint", keyBytes(config)] }),
    getProgramDerivedAddress({ programAddress: LOADER, seeds: [keyBytes(programAddress)] }),
  ]);
  return { config, configBump, mintAuthority, mintAuthorityBump, featherMint, featherMintBump, programData, programDataBump };
}

/** Identity digest is supplied by the enrollment authority, not derived from public
 * wallet/session data here. The program enforces uniqueness of both permanent PDAs.
 */
export async function deriveGooseyEnrollmentAddresses(input: { programAddress: Address; wallet: Address; identityDigest: Uint8Array }) {
  const digest = digest32(input.identityDigest, "Identity digest");
  const wallet = nonzeroKey(input.wallet);
  const programAddress = address(input.programAddress);
  const addresses = await deriveGooseyProgramAddresses(programAddress);
  const [[enrollment, enrollmentBump], [identity, identityBump]] = await Promise.all([
    getProgramDerivedAddress({ programAddress, seeds: ["enrollment", keyBytes(addresses.config), keyBytes(wallet)] }),
    getProgramDerivedAddress({ programAddress, seeds: ["identity", keyBytes(addresses.config), digest] }),
  ]);
  return { ...addresses, enrollment, enrollmentBump, identity, identityBump };
}

/** Build only. All cap/authority/time/account-existence checks remain on chain.
 * No signing, sending, RPC reads, database writes or fabricated receipts.
 */
export async function buildInitializeInstruction(input: {
  programAddress: Address; admin: TransactionSigner; environment: 1 | 2;
  genesisDomain: Uint8Array; enrollmentAuthority: Address; perWalletCap: bigint; campaignCap: bigint;
}) {
  const programAddress = address(input.programAddress);
  const admin = signerMeta(input.admin, true);
  if (input.environment !== 1 && input.environment !== 2) throw new Error("Environment must be localnet (1) or devnet (2)");
  const fields = [new Uint8Array([input.environment]), digest32(input.genesisDomain, "Genesis domain"),
    new Uint8Array(keyBytes(nonzeroKey(input.enrollmentAuthority))), integer(input.perWalletCap, U64_MAX, "Per-wallet cap"),
    integer(input.campaignCap, U64_MAX, "Campaign cap")];
  if (input.campaignCap < input.perWalletCap) throw new Error("Campaign cap must cover per-wallet cap");
  const addresses = await deriveGooseyProgramAddresses(programAddress);
  const instruction = {
    programAddress,
    accounts: [admin, ro(programAddress), ro(addresses.programData), rw(addresses.config), ro(addresses.mintAuthority),
      rw(addresses.featherMint), ro(TOKEN_PROGRAM_ADDRESS), ro(SYSTEM_PROGRAM_ADDRESS), ro(RENT)],
    data: await data("initialize", ...fields),
  } satisfies Instruction;
  return { ...addresses, instruction };
}

export async function buildAuthorizeEnrollmentInstruction(input: {
  programAddress: Address; enrollmentAuthority: TransactionSigner; wallet: Address;
  identityDigest: Uint8Array; allowance: bigint; expiresAt: bigint;
}) {
  const programAddress = address(input.programAddress);
  const authority = signerMeta(input.enrollmentAuthority, true);
  const wallet = nonzeroKey(input.wallet);
  const identityDigest = digest32(input.identityDigest, "Identity digest");
  // Positive i64 Unix seconds; future-ness uses the on-chain Clock, not client time.
  const fields = [new Uint8Array(keyBytes(wallet)), identityDigest, integer(input.allowance, U64_MAX, "Allowance"),
    integer(input.expiresAt, I64_MAX, "Expiry")];
  const addresses = await deriveGooseyEnrollmentAddresses({ programAddress, wallet, identityDigest });
  const instruction = {
    programAddress,
    accounts: [authority, rw(addresses.config), rw(addresses.enrollment), rw(addresses.identity), ro(SYSTEM_PROGRAM_ADDRESS)],
    data: await data("authorize_enrollment", ...fields),
  } satisfies Instruction;
  return { ...addresses, instruction };
}

export async function buildClaimFeathersInstructions(input: {
  programAddress: Address; wallet: TransactionSigner;
  createAta?: boolean; payer?: TransactionSigner;
}) {
  const programAddress = address(input.programAddress);
  const walletMeta = signerMeta(input.wallet, false);
  const wallet = nonzeroKey(walletMeta.address);
  if (input.createAta !== undefined && typeof input.createAta !== "boolean") throw new Error("createAta must be boolean");
  const createAta = input.createAta ?? false;
  const payer = input.payer ?? input.wallet;
  if (input.payer || createAta) signerMeta(payer, true);
  const addresses = await deriveGooseyProgramAddresses(programAddress);
  const [enrollment, enrollmentBump] = await getProgramDerivedAddress({
    programAddress, seeds: ["enrollment", keyBytes(addresses.config), keyBytes(wallet)],
  });
  const [walletTokens] = await findAssociatedTokenPda({ mint: addresses.featherMint, owner: wallet, tokenProgram: TOKEN_PROGRAM_ADDRESS });
  const instruction = {
    programAddress,
    accounts: [walletMeta, rw(addresses.config), rw(enrollment), ro(addresses.mintAuthority), rw(addresses.featherMint),
      rw(walletTokens), ro(TOKEN_PROGRAM_ADDRESS), ro(ASSOCIATED_TOKEN_PROGRAM_ADDRESS)],
    data: await data("claim_feathers"),
  } satisfies Instruction;
  const instructions = createAta ? [getCreateAssociatedTokenIdempotentInstruction({
    payer, ata: walletTokens, owner: wallet, mint: addresses.featherMint, tokenProgram: TOKEN_PROGRAM_ADDRESS,
  }), instruction] : [instruction];
  return { ...addresses, enrollment, enrollmentBump, walletTokens, instruction, instructions };
}
