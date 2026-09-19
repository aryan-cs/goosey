import { address, createSolanaRpc, type Address } from "@solana/kit";
import { readGooseyEscrow } from "./escrow-read";
import { verifyMarketTerms, MARKET_TERMS_MAX_BYTES, type MarketTerms } from "./market-terms";
import { resolveSolanaRuntime, type SolanaRuntime } from "./runtime";

type EscrowSnapshot = Awaited<ReturnType<typeof readGooseyEscrow>>;
export type ChainMarketSnapshot = EscrowSnapshot & {
  marketTerms: NonNullable<EscrowSnapshot["marketTerms"]>;
  orderBook: NonNullable<EscrowSnapshot["orderBook"]>;
  resolution: NonNullable<EscrowSnapshot["resolution"]>;
};
export type ChainMarketView = { snapshot: ChainMarketSnapshot; terms: MarketTerms; digest: string };
function requireValue(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}
function record(value: unknown): Record<string, unknown> {
  requireValue(value && typeof value === "object" && !Array.isArray(value), "Invalid chain-market response");
  return value as Record<string, unknown>;
}
const hex = (bytes: Uint8Array) => Array.from(bytes, value => value.toString(16).padStart(2, "0")).join("");

/** Browser-safe, read-only loader. API identity is checked, but every financial
 * value and terms expectation comes from a separately verified finalized RPC
 * snapshot. Call again before preparation/signing; never use a cached view as
 * authorization. No market-open assertion, signing, DB fallback or mutation.
 */
export async function loadChainMarket(supplied: SolanaRuntime, marketId: bigint, selectedWallet: Address,
  suppliedSignal?: AbortSignal): Promise<ChainMarketView> {
  const runtime = resolveSolanaRuntime({ GOOSEY_SOLANA_CLUSTER: supplied.cluster,
    GOOSEY_SOLANA_RPC_URL: supplied.rpcUrl, GOOSEY_SOLANA_GENESIS_HASH: supplied.genesisHash,
    GOOSEY_SOLANA_PROGRAM_ID: supplied.programAddress });
  const wallet = address(selectedWallet);
  requireValue(wallet !== "11111111111111111111111111111111" && typeof marketId === "bigint"
    && marketId >= 0n && marketId < 1n << 64n, "Invalid market/wallet selection");
  const signal = suppliedSignal ? AbortSignal.any([suppliedSignal, AbortSignal.timeout(15_000)]) : AbortSignal.timeout(15_000);
  signal.throwIfAborted();
  const url = `/api/solana/markets/${marketId}?wallet=${encodeURIComponent(wallet)}`;
  const response = await fetch(url, { signal, cache: "no-store", credentials: "same-origin", redirect: "error" });
  requireValue(response.ok, "A verified chain-market snapshot is unavailable");
  const api = record(await response.json()), apiWallet = record(api.wallet), apiTerms = record(api.terms);
  requireValue(api.version === 1 && api.source === "solana" && api.commitment === "finalized"
    && api.exchangeVerified === false && api.manifestVerified === false
    && api.cluster === runtime.cluster && api.genesisHash === runtime.genesisHash
    && api.programAddress === runtime.programAddress && api.marketId === marketId.toString()
    && apiWallet.address === wallet, "Chain-market API identity mismatch");
  requireValue(typeof api.finalizedSlot === "string" && /^(0|[1-9][0-9]{0,19})$/.test(api.finalizedSlot) && BigInt(api.finalizedSlot) < (1n << 64n), "Invalid API finalized slot");
  const rpc = createSolanaRpc(runtime.rpcUrl);
  const snapshot = await readGooseyEscrow(runtime, { marketId, wallet }, { rpc, signal, includeMarketTerms: true });
  requireValue(snapshot.marketTerms && snapshot.orderBook && snapshot.resolution, "Incomplete chain-market snapshot");
  requireValue(snapshot.wallet === wallet && snapshot.marketState.marketId === marketId
    && snapshot.market === api.marketAddress && snapshot.finalizedSlot >= BigInt(api.finalizedSlot), "Chain-market snapshot binding or freshness mismatch");
  const commitment = snapshot.marketTerms, digest = hex(commitment.digest);
  requireValue(apiTerms.address === commitment.address && apiTerms.digestHex === digest
    && apiTerms.manifestLength === commitment.manifestLength && apiTerms.version === commitment.version,
  "API terms commitment differs from finalized chain");
  const manifest = await fetch(`${url}&format=terms`, { signal, cache: "no-store", credentials: "same-origin", redirect: "error" });
  requireValue(manifest.ok, "Committed market terms are unavailable");
  const declared = manifest.headers.get("content-length");
  if (declared !== null) requireValue(/^[0-9]+$/.test(declared) && Number(declared) <= MARKET_TERMS_MAX_BYTES, "Terms response exceeds size limit");
  // Preserve exact bytes: parsing/re-serializing would erase noncanonical JSON.
  const reader = manifest.body?.getReader();
  requireValue(reader, "Empty terms response");
  const parts: Uint8Array[] = []; let size = 0;
  try {
    while (true) {
      signal.throwIfAborted();
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      requireValue(size <= MARKET_TERMS_MAX_BYTES && size <= commitment.manifestLength, "Terms response exceeds committed size");
      parts.push(part.value);
    }
  } finally { await reader.cancel(); reader.releaseLock(); }
  requireValue(size === commitment.manifestLength, "Terms manifest length mismatch");
  const bytes = new Uint8Array(size); let offset = 0;
  for (const part of parts) { bytes.set(part, offset); offset += part.length; }
  const market = snapshot.marketState;
  const terms = await verifyMarketTerms(bytes, { digest,
    binding: { cluster: runtime.cluster, genesisHash: runtime.genesisHash, program: runtime.programAddress,
      config: snapshot.config, market: snapshot.market, marketId: marketId.toString(), creator: market.creator, featherMint: snapshot.featherMint },
    economics: { payoutMilli: market.payoutMilli.toString(), feeBps: market.feeBps.toString(),
      closesAt: market.closesAt.toString(), resolvesAt: market.resolvesAt.toString(), decimals: 3 },
    proposer: commitment.proposer, approver: commitment.approver });
  requireValue(await rpc.getGenesisHash().send({ abortSignal: signal }) === runtime.genesisHash,
    "RPC genesis changed while verifying market terms");
  signal.throwIfAborted();
  return { snapshot: snapshot as ChainMarketSnapshot, terms, digest };
}
