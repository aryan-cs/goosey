import { createSolanaRpc, getAddressDecoder, getBase64Encoder, type Address } from "@solana/kit";
import { getMintDecoder, TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";
import { deriveGooseyProgramAddresses } from "./program-client";
import { probeSolanaRuntime, type SolanaRuntime } from "./runtime";

type ChainAccount = Readonly<{ owner: Address; executable: boolean; data: readonly [string, "base64"] }>;
const ZERO = "11111111111111111111111111111111";
async function sha256(text: string) {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
}
function same(a: Uint8Array, b: Uint8Array) {
  return a.length === b.length && a.every((byte, i) => byte === b[i]);
}
function bytes(account: ChainAccount | null, owner: Address, length: number) {
  if (!account || account.executable || account.owner !== owner || account.data[1] !== "base64") {
    throw new Error("Unexpected Goosey account owner or encoding");
  }
  const data = new Uint8Array(getBase64Encoder().encode(account.data[0]));
  if (data.length !== length) throw new Error("Unsupported Goosey account size");
  return data;
}

/** Decode a consistent RPC snapshot, not a readiness or binary-audit assertion.
 * Caller must fetch the canonical addresses on the pinned network. Burns may
 * lower mint supply, but can never replenish the lifetime issuance allowance.
 */
export async function verifyGooseyConfiguration(
  runtime: SolanaRuntime, configuration: ChainAccount | null, mintAccount: ChainAccount | null,
) {
  const addresses = await deriveGooseyProgramAddresses(runtime.programAddress);
  const data = bytes(configuration, runtime.programAddress, 172);
  if (!same(data.slice(0, 8), (await sha256("account:Config")).slice(0, 8))) throw new Error("Wrong Config discriminator");
  if (data[8] !== 1 || data[9] !== (runtime.cluster === "localnet" ? 1 : 2)) throw new Error("Unsupported Config version or cluster");
  if (data[10] !== addresses.configBump || data[11] !== addresses.mintAuthorityBump) throw new Error("Incorrect Config PDA bumps");
  if (!same(data.slice(12, 44), await sha256(runtime.genesisHash))) throw new Error("Config genesis domain mismatch");
  const key = (offset: number) => getAddressDecoder().decode(data.slice(offset, offset + 32));
  const admin = key(44), enrollmentAuthority = key(76), featherMint = key(108);
  if (admin === ZERO || enrollmentAuthority === ZERO || featherMint !== addresses.featherMint) throw new Error("Invalid Config authority or mint");
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const perWalletCap = view.getBigUint64(140, true), campaignCap = view.getBigUint64(148, true);
  const totalAuthorized = view.getBigUint64(156, true), totalMinted = view.getBigUint64(164, true);
  if (perWalletCap === 0n || campaignCap < perWalletCap || totalAuthorized > campaignCap || totalMinted > totalAuthorized) {
    throw new Error("Config issuance counters violate supply constraints");
  }
  const mint = getMintDecoder().decode(bytes(mintAccount, TOKEN_PROGRAM_ADDRESS, 82));
  if (!mint.isInitialized || mint.decimals !== 3 || mint.mintAuthority.__option !== "Some"
    || mint.mintAuthority.value !== addresses.mintAuthority || mint.freezeAuthority.__option !== "None"
    || mint.supply > totalMinted) throw new Error("Unexpected feather mint authority, precision, or supply");
  return { ...addresses, admin, enrollmentAuthority, perWalletCap, campaignCap, totalAuthorized, totalMinted, supply: mint.supply };
}

/** One finalized batch keeps configuration and mint supply in the same snapshot. */
export async function readGooseyConfiguration(runtime: SolanaRuntime, signal = AbortSignal.timeout(8_000)) {
  const rpc = createSolanaRpc(runtime.rpcUrl);
  const probe = await probeSolanaRuntime(runtime, rpc, signal);
  const addresses = await deriveGooseyProgramAddresses(runtime.programAddress);
  const response = await rpc.getMultipleAccounts([addresses.config, addresses.featherMint], {
    encoding: "base64", commitment: "finalized", minContextSlot: BigInt(probe.finalizedSlot),
  }).send({ abortSignal: signal });
  const configuration = await verifyGooseyConfiguration(runtime, response.value[0], response.value[1]);
  return { ...configuration, finalizedSlot: response.context.slot, exchangeVerified: false as const };
}
