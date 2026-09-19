import { address, assertIsTransactionSigner, appendTransactionMessageInstructions, blockhash, createSolanaRpc,
  createTransactionMessage, getAddressDecoder, getBase64Decoder, getBase64Encoder, pipe,
  setTransactionMessageFeePayerSigner, setTransactionMessageLifetimeUsingBlockhash, type Address, type TransactionSigner } from "@solana/kit";
import { AccountState, getTokenDecoder, TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";
import { verifyGooseyConfiguration } from "./configuration";
import { buildClaimFeathersInstructions, deriveGooseyEnrollmentAddresses } from "./program-client";
import { probeSolanaRuntime, resolveSolanaRuntime, type SolanaRuntime } from "./runtime";
import type { PreparedWalletTransaction } from "./wallet-transaction";

const CLOCK = address("SysvarC1ock11111111111111111111111111111111");
const SYSVAR_OWNER = address("Sysvar1111111111111111111111111111111111111");
type ChainAccount = { owner: Address; executable: boolean; data: readonly [string, "base64"] };
function raw(account: ChainAccount | null, owner: Address, size: number) {
  if (!account || account.owner !== owner || account.executable !== false || !Array.isArray(account.data)
    || account.data.length !== 2 || account.data[1] !== "base64" || typeof account.data[0] !== "string"
    || account.data[0].length !== 4 * Math.ceil(size / 3)) throw new Error("Invalid claim account owner/encoding/size");
  const bytes = new Uint8Array(getBase64Encoder().encode(account.data[0]));
  if (bytes.length !== size || getBase64Decoder().decode(bytes) !== account.data[0]) throw new Error("Invalid claim account bytes");
  return bytes;
}
const view = (bytes: Uint8Array) => new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
const key = (bytes: Uint8Array, offset: number) => getAddressDecoder().decode(bytes.subarray(offset, offset + 32));
async function anchor(account: ChainAccount | null, owner: Address, size: number, name: string) {
  const bytes = raw(account, owner, size);
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`account:${name}`)));
  if (!bytes.subarray(0, 8).every((byte, i) => byte === hash[i])) throw new Error(`Wrong ${name} discriminator`);
  return bytes;
}
function context(slot: bigint, minimum: bigint) {
  if (typeof slot !== "bigint" || slot < minimum) throw new Error("Invalid finalized claim context");
}

/** Prepare only an issuer-authorized on-chain grant. No enrollment, signing,
 * sending, database accounting or server fee payer. Amount/time are advisory;
 * a concurrent claim or expiry is handled by the program at execution (a replay
 * on chain is a no-op, but preparation rejects already-paid grants).
 */
export async function prepareFeatherClaim(input: {
  runtime: SolanaRuntime; wallet: TransactionSigner; signal?: AbortSignal;
}) {
  const supplied = { ...input.runtime }, wallet = input.wallet, signal = input.signal ?? AbortSignal.timeout(15_000);
  assertIsTransactionSigner(wallet);
  const walletAddress = address(wallet.address);
  const runtime = resolveSolanaRuntime({ GOOSEY_SOLANA_CLUSTER: supplied.cluster, GOOSEY_SOLANA_RPC_URL: supplied.rpcUrl,
    GOOSEY_SOLANA_PROGRAM_ID: supplied.programAddress, GOOSEY_SOLANA_GENESIS_HASH: supplied.genesisHash });
  signal.throwIfAborted();
  const rpc = createSolanaRpc(runtime.rpcUrl);
  const initialPlan = await buildClaimFeathersInstructions({ programAddress: runtime.programAddress, wallet });
  const probe = await probeSolanaRuntime(runtime, rpc, signal);
  const probeSlot = BigInt(probe.finalizedSlot); context(probeSlot, 0n);
  // Discover only the identity seed; no discovery balances are used below.
  const discovery = await rpc.getAccountInfo(initialPlan.enrollment, { encoding: "base64", commitment: "finalized",
    minContextSlot: probeSlot }).send({ abortSignal: signal });
  context(discovery.context.slot, probeSlot);
  const found = await anchor(discovery.value, runtime.programAddress, 129, "Enrollment");
  const identityDigest = found.slice(72, 104);
  const canonical = await deriveGooseyEnrollmentAddresses({ programAddress: runtime.programAddress, wallet: walletAddress, identityDigest });
  const batch = await rpc.getMultipleAccounts([canonical.config, canonical.featherMint, canonical.enrollment,
    canonical.identity, initialPlan.walletTokens, CLOCK], { encoding: "base64", commitment: "finalized",
    minContextSlot: discovery.context.slot }).send({ abortSignal: signal });
  context(batch.context.slot, discovery.context.slot);
  if (batch.value.length !== 6) throw new Error("Invalid claim snapshot length");
  const [configAccount, mintAccount, enrollmentAccount, identityAccount, tokenAccount, clockAccount] = batch.value;
  raw(configAccount, runtime.programAddress, 172);
  const mintBytes = raw(mintAccount, TOKEN_PROGRAM_ADDRESS, 82);
  // Strict COption/bool encoding, in addition to the shared mint invariants.
  if (view(mintBytes).getUint32(0, true) !== 1 || mintBytes[45] !== 1 || view(mintBytes).getUint32(46, true) !== 0) {
    throw new Error("Invalid feather mint encoding");
  }
  const config = await verifyGooseyConfiguration(runtime, configAccount, mintAccount);
  const enrollment = await anchor(enrollmentAccount, runtime.programAddress, 129, "Enrollment");
  const identity = await anchor(identityAccount, runtime.programAddress, 104, "EnrollmentIdentity");
  for (const bytes of [enrollment, identity]) {
    if (key(bytes, 8) !== canonical.config || key(bytes, 40) !== walletAddress
      || !bytes.subarray(72, 104).every((byte, i) => byte === identityDigest[i])) throw new Error("Invalid enrollment identity binding");
  }
  if (enrollment[128] !== canonical.enrollmentBump) throw new Error("Invalid enrollment bump");
  const data = view(enrollment), allowance = data.getBigUint64(104, true), claimed = data.getBigUint64(112, true);
  const expiresAt = data.getBigInt64(120, true), amount = allowance - claimed;
  if (allowance === 0n || allowance > config.perWalletCap || allowance > config.totalAuthorized
    || claimed > allowance || claimed > config.totalMinted || amount > config.totalAuthorized - config.totalMinted) {
    throw new Error("Invalid enrollment allowance/issuance counters");
  }
  if (amount === 0n) throw new Error("Feather grant already claimed");
  const clock = view(raw(clockAccount, SYSVAR_OWNER, 40)), chainTimestamp = clock.getBigInt64(32, true);
  if (clock.getBigUint64(0, true) !== batch.context.slot) throw new Error("Clock does not match finalized claim snapshot");
  if (expiresAt <= 0n || chainTimestamp >= expiresAt) throw new Error("Feather grant expired at finalized chain Clock");
  let observedBalance = 0n;
  if (tokenAccount !== null) {
    const bytes = raw(tokenAccount, TOKEN_PROGRAM_ADDRESS, 165), tokenView = view(bytes);
    if (![0, 1].includes(tokenView.getUint32(72, true)) || tokenView.getUint32(109, true) !== 0
      || ![0, 1].includes(tokenView.getUint32(129, true))) throw new Error("Invalid wallet token option encoding");
    const token = getTokenDecoder().decode(bytes);
    if (token.mint !== canonical.featherMint || token.owner !== walletAddress || token.state !== AccountState.Initialized
      || token.amount > config.supply) throw new Error("Invalid wallet feather account binding/state/supply");
    observedBalance = token.amount;
  }
  const plan = await buildClaimFeathersInstructions({ programAddress: runtime.programAddress, wallet, createAta: tokenAccount === null });
  if (wallet.address !== walletAddress || plan.enrollment !== canonical.enrollment || plan.walletTokens !== initialPlan.walletTokens) {
    throw new Error("Wallet changed during feather claim preparation");
  }
  if (await rpc.getGenesisHash().send({ abortSignal: signal }) !== runtime.genesisHash) throw new Error("Solana RPC genesis changed during claim preparation");
  const latest = await rpc.getLatestBlockhash({ commitment: "finalized", minContextSlot: batch.context.slot }).send({ abortSignal: signal });
  context(latest.context.slot, batch.context.slot);
  if (typeof latest.value.lastValidBlockHeight !== "bigint" || latest.value.lastValidBlockHeight < 0n) throw new Error("Invalid claim signing lifetime");
  const lifetime = { blockhash: blockhash(latest.value.blockhash), lastValidBlockHeight: latest.value.lastValidBlockHeight };
  signal.throwIfAborted();
  if (wallet.address !== walletAddress) throw new Error("Wallet changed during feather claim preparation");
  const message = pipe(createTransactionMessage({ version: 0 }), tx => setTransactionMessageFeePayerSigner(wallet, tx),
    tx => setTransactionMessageLifetimeUsingBlockhash(lifetime, tx), tx => appendTransactionMessageInstructions(plan.instructions, tx));
  const prepared = { message, sender: walletAddress, cluster: runtime.cluster, genesisHash: runtime.genesisHash } satisfies PreparedWalletTransaction;
  return { ...prepared, mint: canonical.featherMint, enrollment: canonical.enrollment, identity: canonical.identity,
    walletTokens: plan.walletTokens, amount, allowance, claimed, expiresAt, chainTimestamp, observedBalance,
    createsAta: tokenAccount === null, observedSlot: batch.context.slot, lifetime };
}
