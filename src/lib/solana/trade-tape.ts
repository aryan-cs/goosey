import type { Prisma } from "@prisma/client";
import { address, signature } from "@solana/kit";
import { z } from "zod";
import { db, requireDatabaseStartup } from "@/lib/db";
import { ApiError } from "@/lib/market-service";
import { runSerializableTransaction, type TransactionRunner } from "@/lib/serializable-transaction";
import { deriveGooseyMarketAddresses } from "./escrow-client";
import { PROGRAM_EVENT_LIMITS } from "./program-events";
import type { SolanaRuntime } from "./runtime";

const U64_MAX = (1n << 64n) - 1n;
const MAX_SLOT = (1n << 63n) - 1n;
const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 50;
const MAX_CURSOR_LENGTH = 512;

const querySchema = z.object({
  limit: z.union([z.number(), z.string().regex(/^[1-9][0-9]*$/).transform(Number)])
    .pipe(z.number().int().min(1).max(MAX_LIMIT)).default(DEFAULT_LIMIT),
  cursor: z.string().min(1).max(MAX_CURSOR_LENGTH).optional(),
}).strict();
export type TradeTapeQuery = z.infer<typeof querySchema>;

const cursorSchema = z.object({
  v: z.literal(1),
  marketAddress: z.string().min(32).max(44),
  slot: z.string().regex(/^(0|[1-9][0-9]{0,18})$/),
  signature: z.string().min(64).max(88),
  logIndex: z.number().int().min(0).max(PROGRAM_EVENT_LIMITS.logs - 1),
}).strict();
type TradeTapeCursor = z.infer<typeof cursorSchema>;

const payloadKeys = ["kind", "makerAction", "makerFee", "makerOrderId", "makerOutcome", "makerSeat",
  "market", "quantity", "takerAction", "takerFee", "takerOrderId", "takerOutcome", "takerSeat", "yesPrice"] as const;
type PayloadKey = typeof payloadKeys[number];
type TradePayload = Record<PayloadKey, string>;

const eventSelect = {
  eventKey: true,
  logIndex: true,
  invocationDepth: true,
  kind: true,
  payload: true,
  schemaVersion: true,
  marketAddress: true,
  receipt: {
    select: {
      genesisHash: true,
      programAddress: true,
      signature: true,
      slot: true,
      status: true,
      decoderVersion: true,
    },
  },
} as const satisfies Prisma.SolanaProgramEventSelect;
type SelectedEvent = Prisma.SolanaProgramEventGetPayload<{ select: typeof eventSelect }>;

function invalidCursor(): never {
  throw new ApiError(400, "INVALID_CURSOR", "The chain trade cursor is invalid.");
}
function encodeCursor(value: TradeTapeCursor) {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}
function decodeCursor(value: string, marketAddress: string): TradeTapeCursor {
  try {
    if (value.length > MAX_CURSOR_LENGTH || !/^[A-Za-z0-9_-]+$/.test(value)) invalidCursor();
    const bytes = Buffer.from(value, "base64url");
    if (bytes.toString("base64url") !== value) invalidCursor();
    const parsed = cursorSchema.parse(JSON.parse(bytes.toString("utf8")));
    address(parsed.marketAddress); signature(parsed.signature);
    const slot = BigInt(parsed.slot);
    if (slot > MAX_SLOT || parsed.marketAddress !== marketAddress || encodeCursor(parsed) !== value) invalidCursor();
    return parsed;
  } catch (error) {
    if (error instanceof ApiError) throw error;
    return invalidCursor();
  }
}

export function parseTradeTapeQuery(input: Record<string, unknown>): TradeTapeQuery {
  const parsed = querySchema.safeParse(input);
  if (!parsed.success) throw new ApiError(400, "INVALID_QUERY", "The chain trade query is invalid.");
  return parsed.data;
}

export function parseTradeTapeMarketId(value: string): bigint {
  if (!/^(0|[1-9][0-9]{0,19})$/.test(value)) {
    throw new ApiError(400, "INVALID_MARKET_ID", "The chain market ID is invalid.");
  }
  const marketId = BigInt(value);
  if (marketId > U64_MAX) throw new ApiError(400, "INVALID_MARKET_ID", "The chain market ID is invalid.");
  return marketId;
}

function u64(value: unknown, field: string, positive = false): bigint {
  if (typeof value !== "string" || !/^(0|[1-9][0-9]{0,19})$/.test(value)) throw new Error(`Invalid trade ${field}`);
  const parsed = BigInt(value);
  if (parsed > U64_MAX || (positive && parsed === 0n)) throw new Error(`Invalid trade ${field}`);
  return parsed;
}
function enumValue(value: unknown, field: string, names: readonly [string, string]) {
  const parsed = u64(value, field);
  if (parsed > 1n) throw new Error(`Invalid trade ${field}`);
  return names[Number(parsed)];
}
function decodePayload(row: SelectedEvent, runtime: SolanaRuntime, marketAddress: string) {
  if (row.kind !== "TradeExecuted" || row.schemaVersion !== 1 || row.marketAddress !== marketAddress
    || row.receipt.genesisHash !== runtime.genesisHash || row.receipt.programAddress !== runtime.programAddress
    || row.receipt.status !== "VERIFIED_SUCCESS" || row.receipt.decoderVersion !== 1
    || !Number.isInteger(row.logIndex) || row.logIndex < 0 || row.logIndex >= PROGRAM_EVENT_LIMITS.logs
    || !Number.isInteger(row.invocationDepth) || row.invocationDepth < 1 || row.invocationDepth > PROGRAM_EVENT_LIMITS.depth
    || typeof row.receipt.slot !== "bigint" || row.receipt.slot < 0n || row.receipt.slot > MAX_SLOT) {
    throw new Error("Invalid verified trade journal row");
  }
  const transactionSignature = signature(row.receipt.signature);
  if (row.eventKey !== `${runtime.genesisHash}:${runtime.programAddress}:${transactionSignature}:${row.logIndex}`) {
    throw new Error("Invalid trade event identity");
  }
  let payload: Record<string, unknown>;
  try {
    const value: unknown = JSON.parse(row.payload);
    if (!value || typeof value !== "object" || Array.isArray(value)
      || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new Error();
    payload = value as Record<string, unknown>;
  } catch { throw new Error("Invalid trade payload JSON"); }
  const keys = Object.keys(payload);
  if (keys.length !== payloadKeys.length || keys.some(key => !payloadKeys.includes(key as PayloadKey))) {
    throw new Error("Invalid trade payload fields");
  }
  const canonical = JSON.stringify(Object.fromEntries(Object.entries(payload).sort(([left], [right]) => left.localeCompare(right))));
  if (canonical !== row.payload || payload.kind !== "TradeExecuted" || payload.market !== marketAddress) {
    throw new Error("Noncanonical trade payload");
  }
  // Address parsing independently rejects malformed payload text even when the
  // denormalized marketAddress column happens to match the expected market.
  if (address(String(payload.market)) !== marketAddress) throw new Error("Invalid trade market");
  const value = payload as TradePayload;
  return {
    signature: transactionSignature,
    slot: row.receipt.slot,
    logIndex: row.logIndex,
    makerOrderId: u64(value.makerOrderId, "maker order ID", true),
    takerOrderId: u64(value.takerOrderId, "taker order ID", true),
    makerSeat: u64(value.makerSeat, "maker seat"),
    takerSeat: u64(value.takerSeat, "taker seat"),
    quantity: u64(value.quantity, "quantity", true),
    yesPrice: u64(value.yesPrice, "YES price", true),
    makerFee: u64(value.makerFee, "maker fee"),
    takerFee: u64(value.takerFee, "taker fee"),
    makerOutcome: enumValue(value.makerOutcome, "maker outcome", ["YES", "NO"]),
    makerAction: enumValue(value.makerAction, "maker action", ["BUY", "SELL"]),
    takerOutcome: enumValue(value.takerOutcome, "taker outcome", ["YES", "NO"]),
    takerAction: enumValue(value.takerAction, "taker action", ["BUY", "SELL"]),
  };
}

function validateCoverage(cursor: {
  genesisHash: string; programAddress: string; coverageStartSignature: string;
  committedHeadSignature: string | null; scanHeadSignature: string | null; scanBeforeSignature: string | null;
  backfillComplete: boolean; revision: number; updatedAt: Date;
}, runtime: SolanaRuntime) {
  if (cursor.genesisHash !== runtime.genesisHash || cursor.programAddress !== runtime.programAddress
    || !Number.isInteger(cursor.revision) || cursor.revision < 0 || cursor.revision > 2_147_483_647
    || !(cursor.updatedAt instanceof Date) || !Number.isFinite(cursor.updatedAt.getTime())
    || (cursor.scanHeadSignature === null) !== (cursor.scanBeforeSignature === null)
    || cursor.backfillComplete !== (cursor.committedHeadSignature !== null)) {
    throw new Error("Invalid trade index coverage cursor");
  }
  signature(cursor.coverageStartSignature);
  if (cursor.committedHeadSignature) signature(cursor.committedHeadSignature);
  if (cursor.scanHeadSignature) signature(cursor.scanHeadSignature);
  if (cursor.scanBeforeSignature) signature(cursor.scanBeforeSignature);
  return {
    status: cursor.backfillComplete ? "bounded_complete" as const : "partial" as const,
    coverageStartSignature: cursor.coverageStartSignature,
    headSignature: cursor.committedHeadSignature ?? cursor.scanHeadSignature,
    backfillComplete: cursor.backfillComplete,
    revision: cursor.revision,
    updatedAt: cursor.updatedAt,
    fullHistory: false as const,
  };
}

/** Read an immutable finalized-event journal projection. "bounded_complete"
 * means only the explicit inclusive start-to-head scan window is complete; it
 * never claims genesis/full-market history or derives any financial balance.
 */
export async function readSolanaTradeTape(runtime: SolanaRuntime, marketId: bigint, input: TradeTapeQuery,
  client: TransactionRunner = db) {
  const query = parseTradeTapeQuery(input);
  if (typeof marketId !== "bigint" || marketId < 0n || marketId > U64_MAX) throw new Error("Invalid chain market ID");
  address(runtime.genesisHash); address(runtime.programAddress);
  const canonical = await deriveGooseyMarketAddresses({ programAddress: runtime.programAddress, marketId });
  const cursor = query.cursor ? decodeCursor(query.cursor, canonical.market) : null;
  if (client === db) await requireDatabaseStartup();
  return runSerializableTransaction(client, async tx => {
    const coverageRow = await tx.solanaIngestionCursor.findUnique({ where: { genesisHash_programAddress: {
      genesisHash: runtime.genesisHash, programAddress: runtime.programAddress,
    } }, select: { genesisHash: true, programAddress: true, coverageStartSignature: true,
      committedHeadSignature: true, scanHeadSignature: true, scanBeforeSignature: true,
      backfillComplete: true, revision: true, updatedAt: true } });
    if (!coverageRow) return {
      items: [], nextCursor: null,
      ordering: { direction: "desc" as const, keys: ["slot", "signature", "logIndex"] as const,
        semantics: "deterministic_journal_display_only" as const },
      coverage: { status: "unavailable" as const, coverageStartSignature: null, headSignature: null,
        backfillComplete: false, revision: null, updatedAt: null, fullHistory: false as const },
    };
    const coverage = validateCoverage(coverageRow, runtime);
    const domain = { genesisHash: runtime.genesisHash, programAddress: runtime.programAddress,
      status: "VERIFIED_SUCCESS", decoderVersion: 1 };
    const where: Prisma.SolanaProgramEventWhereInput = {
      kind: "TradeExecuted", schemaVersion: 1, marketAddress: canonical.market,
      receipt: { is: domain },
      ...(cursor ? { AND: [{ OR: [
        { receipt: { is: { ...domain, slot: { lt: BigInt(cursor.slot) } } } },
        { receipt: { is: { ...domain, slot: BigInt(cursor.slot), signature: { lt: cursor.signature } } } },
        { receipt: { is: { ...domain, slot: BigInt(cursor.slot), signature: cursor.signature } },
          logIndex: { lt: cursor.logIndex } },
      ] }] } : {}),
    };
    const rows = await tx.solanaProgramEvent.findMany({ where,
      orderBy: [{ receipt: { slot: "desc" } }, { receipt: { signature: "desc" } }, { logIndex: "desc" }],
      take: query.limit + 1, select: eventSelect });
    const page = rows.slice(0, query.limit);
    const items = page.map(row => decodePayload(row, runtime, canonical.market));
    const last = items.at(-1);
    return {
      items,
      nextCursor: rows.length > query.limit && last ? encodeCursor({ v: 1, marketAddress: canonical.market,
        slot: last.slot.toString(), signature: last.signature, logIndex: last.logIndex }) : null,
      ordering: { direction: "desc" as const, keys: ["slot", "signature", "logIndex"] as const,
        semantics: "deterministic_journal_display_only" as const },
      coverage,
    };
  });
}
