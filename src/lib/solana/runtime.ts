import { address, createSolanaRpc, type Address } from "@solana/kit";

// No mainnet mode: Goosey feathers have no monetary value. Genesis pinning
// catches an RPC URL that silently points at a different Solana network.
// Full 32-byte getGenesisHash values, not shortened explorer identifiers.
export const DEVNET_GENESIS_HASH = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";
export const MAINNET_GENESIS_HASH = "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d";
export const TESTNET_GENESIS_HASH = "4uhcVJyU9pJkvQyS88uRDiswHXSCkY3zQawwpjk2NsNY";
export type SolanaRuntime = Readonly<{
  cluster: "localnet" | "devnet";
  rpcUrl: string;
  programAddress: Address;
  genesisHash: string;
}>;

export function resolveSolanaRuntime(env: Record<string, string | undefined> = process.env): SolanaRuntime {
  const cluster = env.GOOSEY_SOLANA_CLUSTER;
  if (cluster !== "localnet" && cluster !== "devnet") {
    throw new Error("GOOSEY_SOLANA_CLUSTER must explicitly select localnet or devnet; mainnet is unsupported.");
  }
  let rpc: URL;
  try { rpc = new URL(env.GOOSEY_SOLANA_RPC_URL ?? ""); }
  catch { throw new Error("GOOSEY_SOLANA_RPC_URL must be an absolute RPC URL."); }
  const loopback = ["127.0.0.1", "localhost", "[::1]"].includes(rpc.hostname);
  if (rpc.username || rpc.password || rpc.hash || !["http:", "https:"].includes(rpc.protocol)) {
    throw new Error("RPC URL must use HTTP(S), without embedded credentials or a fragment.");
  }
  if (cluster === "localnet" && !loopback) throw new Error("Localnet RPC must use a loopback host.");
  if (cluster === "devnet" && rpc.protocol !== "https:") throw new Error("Devnet RPC requires HTTPS.");
  let programAddress: Address;
  try { programAddress = address(env.GOOSEY_SOLANA_PROGRAM_ID ?? ""); }
  catch { throw new Error("GOOSEY_SOLANA_PROGRAM_ID must be a valid Solana address."); }
  const genesisHash = cluster === "devnet" ? DEVNET_GENESIS_HASH : env.GOOSEY_SOLANA_GENESIS_HASH;
  if (!genesisHash || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(genesisHash)) {
    throw new Error("Localnet requires its actual GOOSEY_SOLANA_GENESIS_HASH; read it from your validator.");
  }
  try { address(genesisHash); }
  catch { throw new Error("Genesis hash must decode to exactly 32 bytes."); }
  if (genesisHash === MAINNET_GENESIS_HASH || genesisHash === TESTNET_GENESIS_HASH || (cluster === "localnet" && genesisHash === DEVNET_GENESIS_HASH)) {
    throw new Error("The configured genesis hash does not identify the selected non-mainnet cluster.");
  }
  if (cluster === "devnet" && env.GOOSEY_SOLANA_GENESIS_HASH && env.GOOSEY_SOLANA_GENESIS_HASH !== DEVNET_GENESIS_HASH) {
    throw new Error("Devnet genesis hash cannot be overridden.");
  }
  return { cluster, rpcUrl: rpc.toString(), programAddress, genesisHash };
}

export type SolanaProbeClient = Pick<ReturnType<typeof createSolanaRpc>, "getGenesisHash" | "getAccountInfo">;

/** A read-only connectivity/deployment check, NOT proof the exchange is ready.
 * No signatures, transactions, grants, or database accounting are synthesized.
 */
export async function probeSolanaRuntime(
  config: SolanaRuntime,
  rpc: SolanaProbeClient = createSolanaRpc(config.rpcUrl),
  signal: AbortSignal = AbortSignal.timeout(8_000),
) {
  const genesisHash = await rpc.getGenesisHash().send({ abortSignal: signal });
  if (genesisHash !== config.genesisHash) throw new Error("Solana RPC genesis mismatch; refusing this network.");
  const program = await rpc.getAccountInfo(config.programAddress, {
    encoding: "base64", commitment: "finalized", dataSlice: { offset: 0, length: 0 },
  }).send({ abortSignal: signal });
  if (!program.value?.executable) throw new Error("Configured Goosey program is not deployed and executable.");
  // Anchor deploys under the upgradeable BPF loader. An executable system
  // account is not an acceptable substitute for a Goosey program deployment.
  if (program.value.owner !== "BPFLoaderUpgradeab1e11111111111111111111111") {
    throw new Error("Configured program does not use the expected Solana program loader.");
  }
  return {
    cluster: config.cluster,
    genesisHash,
    programAddress: config.programAddress,
    finalizedSlot: program.context.slot.toString(),
    programExecutable: true,
    // Program binary/config verification and a successful exchange journey are
    // separate release gates; RPC connectivity alone must not green-light them.
    exchangeVerified: false,
  } as const;
}
