import { createSolanaRpc } from "@solana/kit";
import { z } from "zod";
import { db, requireDatabaseStartup } from "@/lib/db";
import { ApiError } from "@/lib/market-service";
import { isPrismaErrorCode } from "@/lib/prisma-errors";
import { runSerializableTransaction, type TransactionRunner } from "@/lib/serializable-transaction";
import { readGooseyEscrow } from "./escrow-read";
import { readRetainedMarketTerms } from "./market-terms-store";
import { resolveSolanaRuntime, type SolanaRuntime } from "./runtime";

const text = (min: number, max: number) => z.string().trim().min(min).max(max)
  .refine(value => !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value));
export const chainCatalogMetadataSchema = z.object({
  slug: z.string().min(3).max(120).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  shortTitle: text(3, 90), description: text(20, 5000), category: text(2, 60),
}).strict();

async function admin(tx: Parameters<Parameters<TransactionRunner["$transaction"]>[0]>[0], id: string) {
  const actor = await tx.user.findUnique({ where: { id }, select: { role: true, status: true } });
  if (actor?.role !== "ADMIN" || actor.status !== "ACTIVE") throw new ApiError(403, "ADMIN_REQUIRED", "An active administrator is required.");
}
function date(seconds: bigint) {
  const ms = seconds * 1000n;
  if (ms < 0n || ms > 8_640_000_000_000_000n) throw new Error("Market time cannot be represented in catalog");
  return new Date(Number(ms));
}

/** Register a verified chain market as a hidden DRAFT catalog entry only.
 * Caller supplies authenticated actor identity and server/operator-owned runtime
 * and retention directory. User input cannot choose those trust boundaries.
 * No deployment, signing, balances, collateral account, positions or settlement
 * is created here. The entry shares comments/watchlists, never SQL finances.
 * A separate chain-aware publication flow is required before public listing.
 */
export async function registerSolanaMarket(input: {
  actorUserId: string; runtime: SolanaRuntime; termsDirectory: string; chainMarketId: bigint;
  metadata: z.input<typeof chainCatalogMetadataSchema>; signal?: AbortSignal;
}, client: TransactionRunner = db) {
  const actorUserId = input.actorUserId, metadata = chainCatalogMetadataSchema.parse(input.metadata);
  const chainMarketId = input.chainMarketId, termsDirectory = input.termsDirectory;
  if (typeof chainMarketId !== "bigint" || chainMarketId < 0n || chainMarketId > (1n << 64n) - 1n) throw new Error("Invalid chain market ID");
  const supplied = { ...input.runtime };
  const runtime = resolveSolanaRuntime({ GOOSEY_SOLANA_CLUSTER: supplied.cluster, GOOSEY_SOLANA_RPC_URL: supplied.rpcUrl,
    GOOSEY_SOLANA_PROGRAM_ID: supplied.programAddress, GOOSEY_SOLANA_GENESIS_HASH: supplied.genesisHash });
  const signal = input.signal ?? AbortSignal.timeout(15_000);
  signal.throwIfAborted();
  if (client === db) await requireDatabaseStartup();
  await runSerializableTransaction(client, tx => admin(tx, actorUserId));
  const rpc = createSolanaRpc(runtime.rpcUrl);
  // Public program address is only a neutral selected wallet for this complete
  // account reader. No signer/ownership/enrollment is inferred from it.
  const snapshot = await readGooseyEscrow(runtime, { marketId: chainMarketId, wallet: runtime.programAddress },
    { rpc, signal, includeMarketTerms: true });
  const terms = snapshot.marketTerms;
  if (!terms?.sealed || terms.acceptanceBits !== 3 || !snapshot.resolution || !snapshot.orderBook) {
    throw new ApiError(409, "CHAIN_MARKET_NOT_PUBLISHED", "Sealed reviewed terms and initialized resolution are required.");
  }
  const retained = await readRetainedMarketTerms(termsDirectory, {
    digest: Buffer.from(terms.digest).toString("hex"), manifestLength: terms.manifestLength,
    binding: { cluster: runtime.cluster, genesisHash: runtime.genesisHash, program: runtime.programAddress,
      config: snapshot.config, market: snapshot.market, marketId: chainMarketId.toString(),
      creator: snapshot.marketState.creator, featherMint: snapshot.featherMint },
    economics: { payoutMilli: snapshot.marketState.payoutMilli.toString(), feeBps: snapshot.marketState.feeBps.toString(),
      closesAt: snapshot.marketState.closesAt.toString(), resolvesAt: snapshot.marketState.resolvesAt.toString(), decimals: 3 },
    proposer: terms.proposer, approver: terms.approver,
  });
  if (await rpc.getGenesisHash().send({ abortSignal: signal }) !== runtime.genesisHash) throw new Error("Catalog RPC genesis changed");
  signal.throwIfAborted();
  const manifest = retained.terms;
  const fields = { ...metadata, title: manifest.question,
    rules: `YES: ${manifest.rules.yes}\n\nNO: ${manifest.rules.no}\n\nVOID: ${manifest.rules.void}`,
    resolutionSource: manifest.sources.map(source => source.uri).join("\n"),
    closesAt: date(snapshot.marketState.closesAt), resolvesAt: date(snapshot.marketState.resolvesAt),
    payoutMilli: snapshot.marketState.payoutMilli, feeBps: snapshot.marketState.feeBps };
  const identity = { cluster: runtime.cluster, genesisHash: runtime.genesisHash, programAddress: runtime.programAddress,
    marketAddress: snapshot.market, chainMarketId: chainMarketId.toString() };
  try {
    return await runSerializableTransaction(client, async tx => {
      signal.throwIfAborted();
      await admin(tx, actorUserId);
      const prior = await tx.solanaMarketBinding.findUnique({ where: { genesisHash_programAddress_chainMarketId: {
        genesisHash: identity.genesisHash, programAddress: identity.programAddress, chainMarketId: identity.chainMarketId,
      } }, include: { market: true } });
      if (prior) {
        const same = Object.entries(identity).every(([key, value]) => prior[key as keyof typeof identity] === value)
          && Object.entries(fields).every(([key, value]) => {
            const stored = prior.market[key as keyof typeof fields];
            return value instanceof Date ? stored instanceof Date && stored.getTime() === value.getTime() : stored === value;
          });
        if (!same || prior.market.executionBackend !== "SOLANA" || prior.market.collateralAccountId !== null) {
          throw new ApiError(409, "CHAIN_CATALOG_CONFLICT", "This deployment/market is already registered differently.");
        }
        return { created: false, market: prior.market, binding: prior };
      }
      const market = await tx.market.create({ data: { ...fields, createdById: actorUserId,
        executionBackend: "SOLANA", collateralAccountId: null, pricingModel: "ORDER_BOOK",
        status: "DRAFT", acceptingOrders: false } });
      const binding = await tx.solanaMarketBinding.create({ data: { ...identity, marketId: market.id } });
      await tx.auditLog.create({ data: { actorUserId, action: "REGISTER_SOLANA_MARKET", entityType: "MARKET", entityId: market.id,
        metadata: JSON.stringify({ ...identity, digest: retained.digest, finalizedSlot: snapshot.finalizedSlot.toString(),
          visibility: "DRAFT", financialLedgerCreated: false }) } });
      return { created: true, market, binding };
    });
  } catch (error) {
    if (isPrismaErrorCode(error, "P2002")) throw new ApiError(409, "CHAIN_CATALOG_CONFLICT", "Market identity or slug is already registered. Read the existing entry before retrying.");
    throw error;
  }
}
