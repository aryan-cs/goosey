import { address, createSolanaRpc, type Address } from "@solana/kit";
import { db, requireDatabaseStartup } from "@/lib/db";
import { ApiError } from "@/lib/market-service";
import { parseSolanaCatalogQuery, readSolanaCatalog } from "./catalog-read";
import { readGooseyWalletBalance } from "./wallet-balance";
import { readGooseyEscrow } from "./escrow-read";
import { resolveSolanaRuntime, type SolanaRuntime } from "./runtime";

export const PORTFOLIO_MAX_MARKETS = 20;
export const PORTFOLIO_RPC_CONCURRENCY = 3;
export function parsePortfolioQuery(input: Record<string, unknown>) {
  const query = parseSolanaCatalogQuery({ ...input, limit: input.limit ?? 10 });
  if (query.limit > PORTFOLIO_MAX_MARKETS) throw new ApiError(400, "INVALID_QUERY", "Portfolio limit must be between 1 and 20.");
  return query;
}
const unavailable = () => new ApiError(503, "PORTFOLIO_UNAVAILABLE", "On-chain portfolio is unavailable.");

/** Server-only read. Published catalog pagination, NOT a complete wallet inventory.
 * Each market is a coherent finalized snapshot, but different markets and the
 * wallet ATA may have different slots. Never sum them into a global balance.
 * YES/NO include reserved holdings; available cash excludes reserved cash.
 */
export async function readSolanaPortfolio(input: { userId: string; runtime: SolanaRuntime;
  query: Record<string, unknown>; signal?: AbortSignal }) {
  const userId = input.userId, query = parsePortfolioQuery(input.query), supplied = { ...input.runtime };
  if (!userId || process.env.GOOSEY_SOLANA_CATALOG_ENABLED !== "true") throw unavailable();
  let runtime: SolanaRuntime;
  try { runtime = resolveSolanaRuntime({ GOOSEY_SOLANA_CLUSTER: supplied.cluster, GOOSEY_SOLANA_RPC_URL: supplied.rpcUrl,
    GOOSEY_SOLANA_PROGRAM_ID: supplied.programAddress, GOOSEY_SOLANA_GENESIS_HASH: supplied.genesisHash }); }
  catch { throw unavailable(); }
  const signal = AbortSignal.any([...(input.signal ? [input.signal] : []), AbortSignal.timeout(15_000)]);
  signal.throwIfAborted();
  await requireDatabaseStartup();
  const network = { userId, chainId: `solana:${runtime.cluster}`, genesisHash: runtime.genesisHash } as const;
  const [managedIdentity, links] = await Promise.all([
    db.solanaCustodyIdentity.findUnique({
      where: { userId_chainId_genesisHash: network },
      select: { walletAddress: true },
    }),
    db.solanaWalletLink.findMany({ where: network, select: { walletAddress: true }, take: 2 }),
  ]);
  signal.throwIfAborted();
  const deployment = { cluster: runtime.cluster, genesisHash: runtime.genesisHash, programAddress: runtime.programAddress };
  const scope = "published-catalog-page" as const;
  const units = { cash: "feather-base-units", featherDecimals: 3, positions: "contracts" } as const;
  const consistency = "independent-finalized-snapshots" as const;
  // Ordinary Goosey accounts trade through the app-managed identity. A legacy
  // linked wallet remains a read-only fallback only when no managed identity
  // exists, so creating invisible custody cannot accidentally switch financial
  // reads to a user-selected address.
  const selected = managedIdentity ?? (links.length === 1 ? links[0] : null);
  if (!selected && links.length === 0) return { status: "not-linked" as const, deployment, scope, units, consistency, wallet: null, items: [], hasMore: false, nextCursor: null };
  if (!selected) throw unavailable();
  let wallet: Address;
  try { wallet = address(selected.walletAddress); if (wallet === "11111111111111111111111111111111") throw unavailable(); }
  catch { throw unavailable(); }
  const rpc = createSolanaRpc(runtime.rpcUrl);
  async function checkGenesis() {
    try { if (await rpc.getGenesisHash().send({ abortSignal: signal }) !== runtime.genesisHash) throw unavailable(); }
    catch { throw unavailable(); }
  }
  await checkGenesis();
  // Catalog helper enforces OPEN/SOLANA/null collateral/exact deployment and
  // canonical PDA projection. Never query SQL balances, positions or orders.
  const page = await readSolanaCatalog(runtime, query);
  if (page.items.length > query.limit) throw unavailable();
  let balance;
  try {
    const value = await readGooseyWalletBalance({ runtime, wallet, signal });
    balance = { status: "available" as const, mint: value.mint, tokenAccount: value.walletTokens,
      amount: value.featherAmount.toString(), decimals: value.featherDecimals,
      accountStatus: value.featherAccountStatus, finalizedSlot: value.observedSlot.toString() };
  } catch { balance = { status: "unavailable" as const, code: "WALLET_BALANCE_UNAVAILABLE" as const }; }
  async function market(item: (typeof page.items)[number]) {
    const identity = { marketId: item.chain.marketId, marketAddress: item.chain.marketAddress,
      title: item.title, slug: item.slug, href: item.href };
    try {
      signal.throwIfAborted();
      const snapshot = await readGooseyEscrow(runtime, { marketId: BigInt(item.chain.marketId), wallet }, { signal, includeMarketTerms: true });
      if (snapshot.market !== item.chain.marketAddress || !snapshot.orderBook || !snapshot.resolution || !snapshot.marketTerms) throw unavailable();
      const seat = snapshot.seat;
      return { ...identity, status: "available" as const, finalizedSlot: snapshot.finalizedSlot.toString(),
        registered: seat !== null, seat: seat === null ? null : { index: seat.index,
          availableCash: seat.availableCash.toString(), reservedCash: seat.reservedCash.toString(),
          yes: seat.yes.toString(), no: seat.no.toString(), reservedYes: seat.reservedYes.toString(), reservedNo: seat.reservedNo.toString(),
          nextNonce: seat.nextNonce.toString(), everTraded: seat.everTraded },
        resolutionPhase: snapshot.resolution.phase };
    } catch { return { ...identity, status: "unavailable" as const, code: "MARKET_STATE_UNAVAILABLE" as const }; }
  }
  const items = new Array<Awaited<ReturnType<typeof market>>>(page.items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(PORTFOLIO_RPC_CONCURRENCY, page.items.length) }, async () => {
    while (next < page.items.length) { const index = next++; items[index] = await market(page.items[index]); }
  }));
  // Identity bracket around the whole read; never return amounts if the endpoint
  // changed genesis. Amount failures otherwise remain explicit, never zeroes.
  await checkGenesis();
  return { status: "linked" as const, deployment, scope, units, consistency, wallet: { address: wallet, balance }, items,
    hasMore: page.hasMore, nextCursor: page.nextCursor };
}
