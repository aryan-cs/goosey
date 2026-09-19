import type { Prisma } from "@prisma/client";
import { address, type Address } from "@solana/kit";
import { z } from "zod";
import { db, requireDatabaseStartup } from "@/lib/db";
import { ApiError } from "@/lib/market-service";
import type { SolanaRuntime } from "./runtime";
import { deriveGooseyMarketAddresses } from "./escrow-client";

const U64_MAX = (1n << 64n) - 1n;
const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 50;
const MAX_CURSOR_LENGTH = 512;

const querySchema = z.object({
  limit: z.union([z.number(), z.string().regex(/^[1-9][0-9]*$/).transform(Number)])
    .pipe(z.number().int().min(1).max(MAX_LIMIT)).default(DEFAULT_LIMIT),
  cursor: z.string().min(1).max(MAX_CURSOR_LENGTH).optional(),
}).strict();

const exactDate = z.string().datetime().refine((value) => {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) && date.toISOString() === value;
});
const cursorSchema = z.object({
  v: z.literal(1),
  createdAt: exactDate,
  id: z.string().min(1).max(200).regex(/^[A-Za-z0-9_-]+$/),
}).strict();

export type SolanaCatalogQuery = z.infer<typeof querySchema>;
type CatalogCursor = z.infer<typeof cursorSchema>;
type CatalogClient = Pick<typeof db, "market">;

const marketSelect = {
  id: true,
  executionBackend: true,
  collateralAccountId: true,
  acceptingOrders: true,
  slug: true,
  title: true,
  shortTitle: true,
  description: true,
  rules: true,
  resolutionSource: true,
  category: true,
  status: true,
  featured: true,
  color: true,
  icon: true,
  closesAt: true,
  resolvesAt: true,
  payoutMilli: true,
  feeBps: true,
  createdAt: true,
  updatedAt: true,
  solanaBinding: {
    select: {
      cluster: true,
      genesisHash: true,
      programAddress: true,
      marketAddress: true,
      chainMarketId: true,
    },
  },
} as const satisfies Prisma.MarketSelect;

type SelectedMarket = Prisma.MarketGetPayload<{ select: typeof marketSelect }>;

// Shared projection and binding validation for the exact social-catalog lookup.
export { marketSelect as solanaCatalogSelect, publicItem as projectSolanaCatalogItem };

function invalidCursor(): never {
  throw new ApiError(400, "INVALID_CURSOR", "The chain catalog cursor is invalid.");
}

function encodeCursor(value: CatalogCursor): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

function decodeCursor(value: string): CatalogCursor {
  try {
    if (value.length > MAX_CURSOR_LENGTH || !/^[A-Za-z0-9_-]+$/.test(value)) invalidCursor();
    const bytes = Buffer.from(value, "base64url");
    if (bytes.toString("base64url") !== value) invalidCursor();
    const cursor = cursorSchema.parse(JSON.parse(bytes.toString("utf8")));
    if (encodeCursor(cursor) !== value) invalidCursor();
    return cursor;
  } catch (error) {
    if (error instanceof ApiError) throw error;
    return invalidCursor();
  }
}

export function parseSolanaCatalogQuery(input: Record<string, unknown>): SolanaCatalogQuery {
  const parsed = querySchema.safeParse(input);
  if (!parsed.success) throw new ApiError(400, "INVALID_QUERY", "The chain catalog query is invalid.");
  if (parsed.data.cursor) decodeCursor(parsed.data.cursor);
  return parsed.data;
}

function parseChainMarketId(value: string): bigint {
  if (!/^(0|[1-9][0-9]{0,19})$/.test(value)) throw new Error("Invalid stored chain market ID");
  const parsed = BigInt(value);
  if (parsed > U64_MAX) throw new Error("Stored chain market ID exceeds u64");
  return parsed;
}

async function publicItem(row: SelectedMarket, runtime: SolanaRuntime) {
  const binding = row.solanaBinding;
  if (row.executionBackend !== "SOLANA" || row.collateralAccountId !== null || row.acceptingOrders || row.status !== "OPEN" || !binding
    || binding.cluster !== runtime.cluster || binding.genesisHash !== runtime.genesisHash
    || binding.programAddress !== runtime.programAddress) {
    throw new Error("Invalid chain catalog row binding");
  }
  const chainMarketId = parseChainMarketId(binding.chainMarketId);
  let marketAddress: Address;
  try { marketAddress = address(binding.marketAddress); }
  catch { throw new Error("Invalid stored chain market address"); }
  const canonical = await deriveGooseyMarketAddresses({ programAddress: runtime.programAddress, marketId: chainMarketId });
  if (canonical.market !== marketAddress) throw new Error("Stored chain market address is not canonical");
  const { id: _id, executionBackend: _backend, collateralAccountId: _collateral, acceptingOrders: _accepting,
    solanaBinding: _binding, ...metadata } = row;
  void _id; void _backend; void _collateral; void _accepting; void _binding;
  return {
    ...metadata,
    status: "OPEN" as const,
    href: `/chain/markets/${binding.chainMarketId}`,
    chain: {
      cluster: binding.cluster,
      genesisHash: binding.genesisHash,
      programAddress: binding.programAddress,
      marketAddress,
      marketId: binding.chainMarketId,
    },
  };
}

/** Read only discoverable metadata and immutable chain identity. This function
 * does not read RPC, SQL prices, volume, positions, balances, or order state.
 */
export async function readSolanaCatalog(runtime: SolanaRuntime, input: SolanaCatalogQuery,
  client: CatalogClient = db): Promise<{ items: Awaited<ReturnType<typeof publicItem>>[]; nextCursor: string | null; hasMore: boolean }> {
  const query = parseSolanaCatalogQuery(input);
  const cursor = query.cursor ? decodeCursor(query.cursor) : null;
  if (client === db) await requireDatabaseStartup();
  const where: Prisma.MarketWhereInput = {
    executionBackend: "SOLANA",
    collateralAccountId: null,
    acceptingOrders: false,
    status: "OPEN",
    solanaBinding: { is: { cluster: runtime.cluster, genesisHash: runtime.genesisHash,
      programAddress: runtime.programAddress } },
    ...(cursor ? { AND: [{ OR: [
      { createdAt: { lt: new Date(cursor.createdAt) } },
      { createdAt: new Date(cursor.createdAt), id: { lt: cursor.id } },
    ] }] } : {}),
  };
  const rows = await client.market.findMany({ where, orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: query.limit + 1, select: marketSelect });
  const page = rows.slice(0, query.limit);
  const hasMore = rows.length > query.limit;
  const last = page.at(-1);
  return {
    items: await Promise.all(page.map(row => publicItem(row, runtime))),
    hasMore,
    nextCursor: hasMore && last ? encodeCursor({ v: 1, createdAt: last.createdAt.toISOString(), id: last.id }) : null,
  };
}
