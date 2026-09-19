import { createSolanaRpc } from "@solana/kit";

import { readSolanaCatalog } from "./catalog-read";
import { readGooseyConfiguration } from "./configuration";
import { readGooseyEscrow } from "./escrow-read";
import { readPublicSolanaIndexerStatus } from "./indexer-health";
import { readRetainedMarketTerms } from "./market-terms-store";
import { probeSolanaRuntime, type SolanaRuntime } from "./runtime";
import type { ReleaseReadinessDependencies } from "./release-readiness";

async function readCompletePublishedCatalog(runtime: SolanaRuntime) {
  const items: { marketId: string; marketAddress: Awaited<ReturnType<typeof readSolanaCatalog>>["items"][number]["chain"]["marketAddress"] }[] = [];
  const seen = new Set<string>();
  let cursor: string | undefined;
  for (let pageNumber = 0; pageNumber < 201; pageNumber++) {
    const page = await readSolanaCatalog(runtime, { limit: 50, ...(cursor ? { cursor } : {}) });
    for (const item of page.items) {
      if (seen.has(item.chain.marketId)) throw new Error("Duplicate published chain market");
      seen.add(item.chain.marketId);
      items.push({ marketId: item.chain.marketId, marketAddress: item.chain.marketAddress });
    }
    if (!page.hasMore) return items;
    if (!page.nextCursor || page.nextCursor === cursor) throw new Error("Invalid catalog pagination");
    cursor = page.nextCursor;
  }
  throw new Error("Published chain market catalog exceeds release-gate bound");
}

/** Production adapters intentionally expose only read methods. Keep this module
 * separate so the pure state machine can be tested without initializing Prisma.
 */
export const defaultReleaseReadinessDependencies: ReleaseReadinessDependencies = {
  async probe(runtime, signal) {
    const result = await probeSolanaRuntime(runtime, createSolanaRpc(runtime.rpcUrl), signal);
    return { finalizedSlot: result.finalizedSlot, programExecutable: result.programExecutable };
  },
  async configuration(runtime, signal) {
    const result = await readGooseyConfiguration(runtime, signal);
    return { config: result.config, featherMint: result.featherMint, mintAuthority: result.mintAuthority,
      admin: result.admin, enrollmentAuthority: result.enrollmentAuthority, decimals: 3,
      finalizedSlot: result.finalizedSlot.toString() };
  },
  catalog: readCompletePublishedCatalog,
  async market(runtime, marketId, signal) {
    const result = await readGooseyEscrow(runtime, { marketId, wallet: runtime.programAddress }, {
      signal, includeMarketTerms: true,
    });
    const terms = result.marketTerms;
    return {
      market: result.market, config: result.config, featherMint: result.featherMint,
      creator: result.marketState.creator, payoutMilli: result.marketState.payoutMilli.toString(),
      feeBps: result.marketState.feeBps.toString(), closesAt: result.marketState.closesAt.toString(),
      resolvesAt: result.marketState.resolvesAt.toString(), finalizedSlot: result.finalizedSlot.toString(),
      terms: terms ? { digest: Buffer.from(terms.digest).toString("hex"), manifestLength: terms.manifestLength,
        sealed: terms.sealed, acceptanceBits: terms.acceptanceBits, proposer: terms.proposer, approver: terms.approver } : null,
      hasOrderBook: result.orderBook !== null, hasResolution: result.resolution !== null,
    };
  },
  retainedTerms: readRetainedMarketTerms,
  indexer: readPublicSolanaIndexerStatus,
};
