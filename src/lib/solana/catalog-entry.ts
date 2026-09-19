import { db, requireDatabaseStartup } from "@/lib/db";
import { ApiError } from "@/lib/market-service";
import { deriveGooseyMarketAddresses } from "./escrow-client";
import { projectSolanaCatalogItem, solanaCatalogSelect } from "./catalog-read";
import type { SolanaRuntime } from "./runtime";

export function parseCatalogMarketId(value: string): bigint {
  if (!/^(0|[1-9][0-9]{0,19})$/.test(value) || BigInt(value) > (1n << 64n) - 1n) {
    throw new ApiError(400, "INVALID_MARKET_ID", "Specify a canonical u64 chain market ID.");
  }
  return BigInt(value);
}

/** Editorial lookup only, not a chain snapshot or trading-admission assertion.
 * `id` is the SQL identity for social services; chain.marketId is the u64 ID.
 * Callers supply the trusted server runtime, never request-selected deployment.
 */
export async function readSolanaCatalogEntry(runtime: SolanaRuntime, marketId: string,
  client: Pick<typeof db, "market"> = db) {
  if (process.env.GOOSEY_SOLANA_CATALOG_ENABLED !== "true") {
    throw new ApiError(503, "CHAIN_CATALOG_UNAVAILABLE", "Public chain catalog is not enabled.");
  }
  const deployment = { ...runtime };
  const parsed = parseCatalogMarketId(marketId);
  const canonical = await deriveGooseyMarketAddresses({ programAddress: deployment.programAddress, marketId: parsed });
  if (client === db) await requireDatabaseStartup();
  const row = await client.market.findFirst({
    where: { executionBackend: "SOLANA", collateralAccountId: null, status: "OPEN", acceptingOrders: false,
      solanaBinding: { is: { cluster: deployment.cluster, genesisHash: deployment.genesisHash,
        programAddress: deployment.programAddress, chainMarketId: marketId, marketAddress: canonical.market } } },
    select: solanaCatalogSelect,
  });
  if (!row || row.solanaBinding?.chainMarketId !== marketId) return null;
  let item;
  try { item = await projectSolanaCatalogItem(row, deployment); }
  catch { return null; } // Malformed or unpublished bindings are never public.
  // Explicit editorial allowlist: no SQL financial defaults or private fields.
  return { id: row.id, slug: item.slug, title: item.title, shortTitle: item.shortTitle,
    description: item.description, rules: item.rules, resolutionSource: item.resolutionSource,
    category: item.category, status: item.status, featured: item.featured, color: item.color,
    icon: item.icon, closesAt: item.closesAt, resolvesAt: item.resolvesAt,
    createdAt: item.createdAt, updatedAt: item.updatedAt, href: item.href, chain: item.chain };
}
