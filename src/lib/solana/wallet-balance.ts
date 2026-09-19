import { address, createSolanaRpc, getBase64Decoder, getBase64Encoder, type Address } from "@solana/kit";
import { AccountState, findAssociatedTokenPda, getTokenDecoder, TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";
import { SYSTEM_PROGRAM_ADDRESS } from "@solana-program/system";
import { readGooseyConfiguration } from "./configuration";
import { resolveSolanaRuntime, type SolanaRuntime } from "./runtime";

const MAX_U64 = (1n << 64n) - 1n;
function unsigned(value: bigint, label: string) {
  if (typeof value !== "bigint" || value < 0n || value > MAX_U64) throw new Error(`Invalid ${label}`);
  return value;
}

/** Read-only, advisory finalized balances, NOT a transaction fee quote or proof
 * of signing capability. Configuration/mint pinning precedes a single coherent
 * wallet+ATA batch; its earlier supply must not cap a later balance after claims.
 * An arbitrary program-owned address may be inspected, but its SOL is never
 * advertised as ordinary wallet fee funding. Only a non-executable, empty-data
 * System account is classified as an ordinary fee-payer account here.
 */
export async function readGooseyWalletBalance(input: {
  runtime: SolanaRuntime; wallet: Address; signal?: AbortSignal;
}) {
  const supplied = { ...input.runtime }, wallet = address(input.wallet);
  const signal = input.signal ?? AbortSignal.timeout(10_000);
  const runtime = resolveSolanaRuntime({ GOOSEY_SOLANA_CLUSTER: supplied.cluster,
    GOOSEY_SOLANA_RPC_URL: supplied.rpcUrl, GOOSEY_SOLANA_PROGRAM_ID: supplied.programAddress,
    GOOSEY_SOLANA_GENESIS_HASH: supplied.genesisHash });
  signal.throwIfAborted();
  const configuration = await readGooseyConfiguration(runtime, signal);
  const configurationSlot = unsigned(configuration.finalizedSlot, "configuration slot");
  const mint = address(configuration.featherMint);
  const [walletTokens] = await findAssociatedTokenPda({ mint, owner: wallet, tokenProgram: TOKEN_PROGRAM_ADDRESS });
  signal.throwIfAborted();
  const rpc = createSolanaRpc(runtime.rpcUrl);
  const snapshot = await rpc.getMultipleAccounts([wallet, walletTokens], {
    encoding: "base64", commitment: "finalized", minContextSlot: configurationSlot,
  }).send({ abortSignal: signal });
  const observedSlot = unsigned(snapshot.context.slot, "wallet snapshot slot");
  if (observedSlot < configurationSlot || !Array.isArray(snapshot.value) || snapshot.value.length !== 2) {
    throw new Error("Invalid finalized wallet snapshot");
  }
  const [walletAccount, tokenAccount] = snapshot.value;
  let solLamports = 0n, walletAccountOwner: Address | null = null, ordinaryFeePayerAccount = false;
  if (walletAccount !== null) {
    walletAccountOwner = address(walletAccount.owner);
    solLamports = unsigned(walletAccount.lamports, "wallet lamports");
    if (typeof walletAccount.executable !== "boolean" || !Array.isArray(walletAccount.data)
      || walletAccount.data.length !== 2 || typeof walletAccount.data[0] !== "string" || walletAccount.data[1] !== "base64") {
      throw new Error("Invalid wallet account envelope");
    }
    ordinaryFeePayerAccount = walletAccountOwner === SYSTEM_PROGRAM_ADDRESS
      && walletAccount.executable === false && walletAccount.data[0] === "";
  }
  let featherAmount = 0n;
  if (tokenAccount !== null) {
    if (!tokenAccount || tokenAccount.owner !== TOKEN_PROGRAM_ADDRESS || tokenAccount.executable !== false
      || !Array.isArray(tokenAccount.data) || tokenAccount.data.length !== 2 || tokenAccount.data[1] !== "base64"
      || typeof tokenAccount.data[0] !== "string" || tokenAccount.data[0].length !== 220) {
      throw new Error("Invalid feather ATA owner/encoding/size");
    }
    const bytes = new Uint8Array(getBase64Encoder().encode(tokenAccount.data[0]));
    if (bytes.length !== 165 || getBase64Decoder().decode(bytes) !== tokenAccount.data[0]) throw new Error("Invalid feather ATA bytes");
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (![0, 1].includes(view.getUint32(72, true)) || view.getUint32(109, true) !== 0
      || ![0, 1].includes(view.getUint32(129, true))) throw new Error("Invalid feather ATA option encoding");
    const token = getTokenDecoder().decode(bytes);
    if (token.mint !== mint || token.owner !== wallet || token.state !== AccountState.Initialized) {
      throw new Error("Invalid feather ATA wallet/mint/unfrozen binding");
    }
    featherAmount = unsigned(token.amount, "feather amount");
  }
  if (await rpc.getGenesisHash().send({ abortSignal: signal }) !== runtime.genesisHash) {
    throw new Error("Solana RPC genesis changed during wallet balance read");
  }
  signal.throwIfAborted();
  return { wallet, mint, walletTokens, featherAmount, featherDecimals: 3 as const,
    featherAccountStatus: tokenAccount === null ? "absent" as const : "present" as const,
    solLamports, walletAccountStatus: walletAccount === null ? "absent" as const : "present" as const,
    walletAccountOwner, ordinaryFeePayerAccount, observedSlot, configurationSlot,
    cluster: runtime.cluster, genesisHash: runtime.genesisHash, programAddress: runtime.programAddress };
}
