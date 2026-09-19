import { address, assertIsTransactionSigner, appendTransactionMessageInstructions, blockhash, createSolanaRpc,
  createTransactionMessage, getBase64Decoder, getBase64Encoder, pipe, setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash, type Address, type TransactionSigner } from "@solana/kit";
import { TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";
import { verifyGooseyConfiguration } from "./configuration";
import { buildAuthorizeEnrollmentInstruction } from "./program-client";
import { probeSolanaRuntime, resolveSolanaRuntime, type SolanaRuntime } from "./runtime";
import type { PreparedWalletTransaction } from "./wallet-transaction";

const CLOCK = address("SysvarC1ock11111111111111111111111111111111");
const SYSVAR_OWNER = address("Sysvar1111111111111111111111111111111111111");
const MAX_U64 = (1n << 64n) - 1n;
type ChainAccount = { owner: Address; executable: boolean; data: readonly [string, "base64"] };
function raw(account: ChainAccount | null, owner: Address, size: number) {
  if (!account || account.owner !== owner || account.executable !== false || !Array.isArray(account.data)
    || account.data.length !== 2 || account.data[1] !== "base64" || typeof account.data[0] !== "string"
    || account.data[0].length !== 4 * Math.ceil(size / 3)) throw new Error("Invalid enrollment account owner/encoding/size");
  const bytes = new Uint8Array(getBase64Encoder().encode(account.data[0]));
  if (bytes.length !== size || getBase64Decoder().decode(bytes) !== account.data[0]) throw new Error("Invalid enrollment account bytes");
  return bytes;
}
function context(slot: bigint, minimum: bigint) {
  if (typeof slot !== "bigint" || slot < minimum || slot > MAX_U64) throw new Error("Invalid finalized enrollment context");
}

/** Operator-only unsigned preparation, NOT an eligibility service or public API.
 * The configured issuer must independently authorize the explicit target,
 * identity digest, allowance and expiry. No identity/eligibility is inferred
 * from client/session data. Existing associations are never overwritten.
 * All checks are advisory snapshots; the program enforces them at execution.
 * No signing, sending, automatic funding, token claims or financial DB writes.
 */
export async function prepareEnrollment(input: {
  runtime: SolanaRuntime; enrollmentAuthority: TransactionSigner; wallet: Address;
  identityDigest: Uint8Array; allowance: bigint; expiresAt: bigint; signal?: AbortSignal;
}) {
  const supplied = { ...input.runtime }, authority = input.enrollmentAuthority;
  assertIsTransactionSigner(authority);
  const authorityAddress = address(authority.address), wallet = address(input.wallet);
  if (!(input.identityDigest instanceof Uint8Array) || input.identityDigest.length !== 32) throw new Error("Identity digest must be exactly 32 bytes");
  const identityDigest = new Uint8Array(input.identityDigest), allowance = input.allowance, expiresAt = input.expiresAt;
  const signal = input.signal ?? AbortSignal.timeout(15_000);
  const runtime = resolveSolanaRuntime({ GOOSEY_SOLANA_CLUSTER: supplied.cluster, GOOSEY_SOLANA_RPC_URL: supplied.rpcUrl,
    GOOSEY_SOLANA_PROGRAM_ID: supplied.programAddress, GOOSEY_SOLANA_GENESIS_HASH: supplied.genesisHash });
  signal.throwIfAborted();
  // Shipping builder validates the explicit digest and positive u64/i64 inputs before RPC.
  const plan = await buildAuthorizeEnrollmentInstruction({ programAddress: runtime.programAddress,
    enrollmentAuthority: authority, wallet, identityDigest, allowance, expiresAt });
  const rpc = createSolanaRpc(runtime.rpcUrl);
  const probe = await probeSolanaRuntime(runtime, rpc, signal);
  const probeSlot = BigInt(probe.finalizedSlot); context(probeSlot, 0n);
  const batch = await rpc.getMultipleAccounts([plan.config, plan.featherMint, plan.enrollment, plan.identity, CLOCK], {
    encoding: "base64", commitment: "finalized", minContextSlot: probeSlot,
  }).send({ abortSignal: signal });
  context(batch.context.slot, probeSlot);
  if (!Array.isArray(batch.value) || batch.value.length !== 5) throw new Error("Invalid enrollment snapshot length");
  const [configAccount, mintAccount, enrollmentAccount, identityAccount, clockAccount] = batch.value;
  raw(configAccount, runtime.programAddress, 172);
  const mintBytes = raw(mintAccount, TOKEN_PROGRAM_ADDRESS, 82);
  const mintView = new DataView(mintBytes.buffer, mintBytes.byteOffset, mintBytes.byteLength);
  if (mintView.getUint32(0, true) !== 1 || mintBytes[45] !== 1 || mintView.getUint32(46, true) !== 0) {
    throw new Error("Invalid enrollment mint encoding");
  }
  const config = await verifyGooseyConfiguration(runtime, configAccount, mintAccount);
  if (config.enrollmentAuthority !== authorityAddress) throw new Error("Signer is not the configured enrollment authority");
  if (enrollmentAccount !== null || identityAccount !== null) throw new Error("Enrollment or identity association already exists");
  const remainingCampaignAllowance = config.campaignCap - config.totalAuthorized;
  if (allowance > config.perWalletCap || allowance > remainingCampaignAllowance) throw new Error("Enrollment exceeds per-wallet or remaining campaign cap");
  const clockBytes = raw(clockAccount, SYSVAR_OWNER, 40);
  const clock = new DataView(clockBytes.buffer, clockBytes.byteOffset, clockBytes.byteLength);
  const chainTimestamp = clock.getBigInt64(32, true);
  if (clock.getBigUint64(0, true) !== batch.context.slot) throw new Error("Clock does not match finalized enrollment snapshot");
  if (expiresAt <= chainTimestamp) throw new Error("Enrollment expiry must be after finalized chain Clock");
  if (await rpc.getGenesisHash().send({ abortSignal: signal }) !== runtime.genesisHash) throw new Error("Solana RPC genesis changed during enrollment preparation");
  const latest = await rpc.getLatestBlockhash({ commitment: "finalized", minContextSlot: batch.context.slot }).send({ abortSignal: signal });
  context(latest.context.slot, batch.context.slot);
  if (typeof latest.value.lastValidBlockHeight !== "bigint" || latest.value.lastValidBlockHeight < 0n
    || latest.value.lastValidBlockHeight > MAX_U64) throw new Error("Invalid enrollment signing lifetime");
  const lifetime = { blockhash: blockhash(latest.value.blockhash), lastValidBlockHeight: latest.value.lastValidBlockHeight };
  signal.throwIfAborted();
  if (authority.address !== authorityAddress) throw new Error("Enrollment authority changed during preparation");
  const message = pipe(createTransactionMessage({ version: 0 }), tx => setTransactionMessageFeePayerSigner(authority, tx),
    tx => setTransactionMessageLifetimeUsingBlockhash(lifetime, tx), tx => appendTransactionMessageInstructions([plan.instruction], tx));
  const prepared = { message, sender: authorityAddress, cluster: runtime.cluster, genesisHash: runtime.genesisHash } satisfies PreparedWalletTransaction;
  return { ...prepared, wallet, config: plan.config, mint: plan.featherMint, enrollment: plan.enrollment, identity: plan.identity,
    identityDigest, allowance, expiresAt, chainTimestamp, perWalletCap: config.perWalletCap,
    campaignCap: config.campaignCap, totalAuthorized: config.totalAuthorized, totalMinted: config.totalMinted,
    remainingCampaignAllowance, observedSlot: batch.context.slot, lifetime };
}
