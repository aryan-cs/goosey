import type { Prisma } from "@prisma/client";
import { address, signature } from "@solana/kit";
import { z } from "zod";

import { db, requireDatabaseStartup } from "@/lib/db";
import { ApiError } from "@/lib/market-service";
import { runSerializableTransaction, type TransactionRunner } from "@/lib/serializable-transaction";
import { PROGRAM_EVENT_LIMITS } from "./program-events";
import type { SolanaRuntime } from "./runtime";

const U64_MAX = (1n << 64n) - 1n;
const MAX_SLOT = (1n << 63n) - 1n;
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;
export const SOLANA_LEADERBOARD_EVENT_LIMIT = 50_000;

const querySchema = z.object({
  limit: z.union([z.number(), z.string().regex(/^[1-9][0-9]*$/).transform(Number)])
    .pipe(z.number().int().min(1).max(MAX_LIMIT)).default(DEFAULT_LIMIT),
}).strict();
export type SolanaLeaderboardQuery = z.infer<typeof querySchema>;

const payloadKeys = ["action", "canceled", "disposition", "filled", "kind", "market", "nonce",
  "orderId", "outcome", "price", "rested", "wallet"] as const;
type PayloadKey = typeof payloadKeys[number];
type OrderPayload = Record<PayloadKey, string>;

const eventSelect = {
  eventKey: true,
  logIndex: true,
  invocationDepth: true,
  kind: true,
  payload: true,
  schemaVersion: true,
  marketAddress: true,
  walletAddress: true,
  receipt: { select: { genesisHash: true, programAddress: true, signature: true, slot: true,
    status: true, decoderVersion: true } },
} as const satisfies Prisma.SolanaProgramEventSelect;
type SelectedEvent = Prisma.SolanaProgramEventGetPayload<{ select: typeof eventSelect }>;

export function parseSolanaLeaderboardQuery(input: Record<string, unknown>): SolanaLeaderboardQuery {
  const parsed = querySchema.safeParse(input);
  if (!parsed.success) throw new ApiError(400, "INVALID_QUERY", "The chain leaderboard query is invalid.");
  return parsed.data;
}

function u64(value: unknown, field: string, positive = false): bigint {
  if (typeof value !== "string" || !/^(0|[1-9][0-9]{0,19})$/.test(value)) {
    throw new Error(`Invalid order ${field}`);
  }
  const parsed = BigInt(value);
  if (parsed > U64_MAX || (positive && parsed === 0n)) throw new Error(`Invalid order ${field}`);
  return parsed;
}

function enumValue(value: unknown, field: string, max: bigint): bigint {
  const parsed = u64(value, field);
  if (parsed > max) throw new Error(`Invalid order ${field}`);
  return parsed;
}

function decodeOrderEvent(row: SelectedEvent, runtime: SolanaRuntime) {
  if (row.kind !== "OrderExecuted" || row.schemaVersion !== 1 || row.marketAddress === null
    || row.walletAddress === null || row.receipt.genesisHash !== runtime.genesisHash
    || row.receipt.programAddress !== runtime.programAddress || row.receipt.status !== "VERIFIED_SUCCESS"
    || row.receipt.decoderVersion !== 1 || !Number.isInteger(row.logIndex) || row.logIndex < 0
    || row.logIndex >= PROGRAM_EVENT_LIMITS.logs || !Number.isInteger(row.invocationDepth)
    || row.invocationDepth < 1 || row.invocationDepth > PROGRAM_EVENT_LIMITS.depth
    || typeof row.receipt.slot !== "bigint" || row.receipt.slot < 0n || row.receipt.slot > MAX_SLOT) {
    throw new Error("Invalid verified order journal row");
  }
  const transactionSignature = signature(row.receipt.signature);
  if (row.eventKey !== `${runtime.genesisHash}:${runtime.programAddress}:${transactionSignature}:${row.logIndex}`) {
    throw new Error("Invalid order event identity");
  }
  const market = address(row.marketAddress), wallet = address(row.walletAddress);
  let payload: Record<string, unknown>;
  try {
    const value: unknown = JSON.parse(row.payload);
    if (!value || typeof value !== "object" || Array.isArray(value)
      || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new Error();
    payload = value as Record<string, unknown>;
  } catch { throw new Error("Invalid order payload JSON"); }
  const keys = Object.keys(payload);
  if (keys.length !== payloadKeys.length || keys.some(key => !payloadKeys.includes(key as PayloadKey))) {
    throw new Error("Invalid order payload fields");
  }
  const canonical = JSON.stringify(Object.fromEntries(
    Object.entries(payload).sort(([left], [right]) => left.localeCompare(right)),
  ));
  if (canonical !== row.payload || payload.kind !== "OrderExecuted"
    || address(String(payload.market)) !== market || address(String(payload.wallet)) !== wallet) {
    throw new Error("Noncanonical order payload");
  }
  const value = payload as OrderPayload;
  const filled = u64(value.filled, "filled quantity");
  const canceled = u64(value.canceled, "canceled quantity");
  const rested = u64(value.rested, "rested quantity");
  if (filled + canceled + rested > U64_MAX) throw new Error("Invalid order quantity total");
  return {
    wallet,
    market,
    filled,
    canceled,
    rested,
    orderId: u64(value.orderId, "ID", true),
    nonce: u64(value.nonce, "nonce"),
    price: u64(value.price, "price", true),
    disposition: enumValue(value.disposition, "disposition", 7n),
    outcome: enumValue(value.outcome, "outcome", 1n),
    action: enumValue(value.action, "action", 1n),
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
    throw new Error("Invalid leaderboard index coverage cursor");
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

type Aggregate = {
  walletAddress: string;
  filledContracts: bigint;
  orderCommands: bigint;
  filledOrderCommands: bigint;
  markets: Set<string>;
};

/** Rank wallets by contract quantity filled while they were the submitted
 * (taker) order in finalized OrderExecuted events. This deliberately does not
 * claim equity, P&L, wallet balance, or full two-sided volume: maker ownership
 * is not present in TradeExecuted, and SQL financial rows are never consulted.
 */
export async function readSolanaLeaderboard(
  runtime: SolanaRuntime,
  input: SolanaLeaderboardQuery,
  client: TransactionRunner = db,
  eventLimit = SOLANA_LEADERBOARD_EVENT_LIMIT,
) {
  const query = parseSolanaLeaderboardQuery(input);
  address(runtime.genesisHash); address(runtime.programAddress);
  if (!Number.isSafeInteger(eventLimit) || eventLimit < 1 || eventLimit > SOLANA_LEADERBOARD_EVENT_LIMIT) {
    throw new Error("Invalid chain leaderboard event limit");
  }
  if (client === db) await requireDatabaseStartup();
  return runSerializableTransaction(client, async tx => {
    const coverageRow = await tx.solanaIngestionCursor.findUnique({ where: { genesisHash_programAddress: {
      genesisHash: runtime.genesisHash, programAddress: runtime.programAddress,
    } }, select: { genesisHash: true, programAddress: true, coverageStartSignature: true,
      committedHeadSignature: true, scanHeadSignature: true, scanBeforeSignature: true,
      backfillComplete: true, revision: true, updatedAt: true } });
    if (!coverageRow) return {
      metric: "taker_filled_contracts" as const,
      rows: [], participantCount: 0, observedOrderEvents: 0,
      eventWindow: { limit: eventLimit, truncated: false, semantics: "latest_finalized_order_events" as const },
      coverage: { status: "unavailable" as const, coverageStartSignature: null, headSignature: null,
        backfillComplete: false, revision: null, updatedAt: null, fullHistory: false as const },
    };
    const coverage = validateCoverage(coverageRow, runtime);
    const events = await tx.solanaProgramEvent.findMany({
      where: { kind: "OrderExecuted", schemaVersion: 1, walletAddress: { not: null },
        receipt: { is: { genesisHash: runtime.genesisHash, programAddress: runtime.programAddress,
          status: "VERIFIED_SUCCESS", decoderVersion: 1 } } },
      orderBy: [{ receipt: { slot: "desc" } }, { receipt: { signature: "desc" } }, { logIndex: "desc" }],
      take: eventLimit + 1,
      select: eventSelect,
    });
    const truncated = events.length > eventLimit;
    const selected = events.slice(0, eventLimit).map(row => decodeOrderEvent(row, runtime));
    const participants = new Map<string, Aggregate>();
    for (const event of selected) {
      let aggregate = participants.get(event.wallet);
      if (!aggregate) {
        aggregate = { walletAddress: event.wallet, filledContracts: 0n, orderCommands: 0n,
          filledOrderCommands: 0n, markets: new Set() };
        participants.set(event.wallet, aggregate);
      }
      aggregate.orderCommands += 1n;
      if (event.filled > 0n) {
        aggregate.filledContracts += event.filled;
        aggregate.filledOrderCommands += 1n;
        aggregate.markets.add(event.market);
      }
    }
    const ranked = [...participants.values()]
      .filter(row => row.filledContracts > 0n)
      .sort((left, right) => left.filledContracts === right.filledContracts
        ? left.walletAddress < right.walletAddress ? -1 : left.walletAddress > right.walletAddress ? 1 : 0
        : left.filledContracts > right.filledContracts ? -1 : 1)
      .map((row, index) => ({ rank: index + 1, walletAddress: row.walletAddress,
        filledContracts: row.filledContracts, filledOrderCommands: row.filledOrderCommands,
        orderCommands: row.orderCommands, marketsTraded: row.markets.size }));
    return {
      metric: "taker_filled_contracts" as const,
      rows: ranked.slice(0, query.limit),
      participantCount: ranked.length,
      observedOrderEvents: selected.length,
      eventWindow: { limit: eventLimit, truncated, semantics: "latest_finalized_order_events" as const },
      coverage,
    };
  });
}
