import { NextRequest } from "next/server";
import { z } from "zod";
import { assertAdmin } from "@/lib/admin-service";
import { readJsonObject } from "@/lib/http";
import { ApiError, apiErrorResponse, consumeRateLimit, jsonResponse, prisma, requireUser } from "@/lib/market-service";
import { assertMutationSession } from "@/lib/mutation-session";
import { chainCatalogMetadataSchema, registerSolanaMarket } from "@/lib/solana/market-catalog";
import { resolveSolanaRuntime } from "@/lib/solana/runtime";

export const runtime = "nodejs";
const schema = z.object({
  chainMarketId: z.string().regex(/^(0|[1-9][0-9]{0,19})$/)
    .refine(value => /^(0|[1-9][0-9]{0,19})$/.test(value) && BigInt(value) <= (1n << 64n) - 1n),
  metadata: chainCatalogMetadataSchema,
}).strict();

/** Register metadata only. Chain identity is the idempotency key; no deployment,
 * signing, financial writes or public-listing transition takes place here. */
export async function POST(request: NextRequest) {
  try {
    const actor = await requireUser(request, true);
    assertAdmin(actor);
    await consumeRateLimit(prisma, `solana-catalog-register:${actor.id}`, 10, 60_000);
    const body = schema.parse(await readJsonObject(request));
    const env = { ...process.env };
    let deployment;
    const termsDirectory = env.GOOSEY_SOLANA_TERMS_DIRECTORY;
    try {
      if (!termsDirectory || ![env.GOOSEY_SOLANA_CLUSTER, env.GOOSEY_SOLANA_RPC_URL,
        env.GOOSEY_SOLANA_PROGRAM_ID, env.GOOSEY_SOLANA_GENESIS_HASH].every(Boolean)) throw new Error("Missing configuration");
      deployment = resolveSolanaRuntime(env);
    } catch {
      throw new ApiError(503, "CHAIN_CATALOG_UNAVAILABLE", "Chain catalog registration is not configured.");
    }
    const result = await registerSolanaMarket({ actorUserId: actor.id, runtime: deployment, termsDirectory,
      chainMarketId: BigInt(body.chainMarketId), metadata: body.metadata,
      signal: AbortSignal.any([request.signal, AbortSignal.timeout(15_000)]),
      authorize: async tx => { await assertMutationSession(tx, request, actor.id); },
    });
    // Explicit projection: no internal balances/default price fields or nested ORM records.
    return jsonResponse({ created: result.created, market: { id: result.market.id,
      slug: result.market.slug, title: result.market.title, status: result.market.status,
      executionBackend: result.market.executionBackend }, binding: {
      cluster: result.binding.cluster, genesisHash: result.binding.genesisHash,
      programAddress: result.binding.programAddress, marketAddress: result.binding.marketAddress,
      chainMarketId: result.binding.chainMarketId,
    } }, { status: result.created ? 201 : 200 });
  } catch (error) { return apiErrorResponse(error); }
}
