import { Prisma } from "@prisma/client";
import { z } from "zod";

import { ApiError, prisma } from "@/lib/market-service";
import { encodeCursor } from "@/lib/serializers";

const MAX_PAGE_SIZE = 100;
const DEFAULT_PAGE_SIZE = 50;
const MAX_METADATA_DEPTH = 24;
const MAX_METADATA_BYTES = 64 * 1_024;
const REDACTED = "[REDACTED]";
const TRUNCATED = "[TRUNCATED]";

const auditName = z.string().trim().min(1).max(120).regex(/^[A-Z][A-Z0-9_]*$/u);
const identifier = z.string().trim().min(1).max(191).regex(/^[A-Za-z0-9._:@-]+$/u);
const instant = z.string().datetime({ offset: true }).transform((value) => new Date(value));

const querySchema = z
  .object({
    actor: identifier.optional(),
    action: auditName.optional(),
    entityType: auditName.optional(),
    entityId: identifier.optional(),
    from: instant.optional(),
    to: instant.optional(),
    limit: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).default(DEFAULT_PAGE_SIZE),
    cursor: z.string().trim().min(1).max(1_024).optional(),
    format: z.enum(["json", "csv"]).default("json"),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.from && value.to && value.from > value.to) {
      context.addIssue({
        code: "custom",
        path: ["from"],
        message: "from must not be later than to.",
      });
    }
  });

export type AuditExportFormat = "json" | "csv";

export type AuditExportItem = {
  id: string;
  action: string;
  entityType: string;
  entityId: string;
  metadata: unknown;
  createdAt: Date;
  actor: {
    id: string;
    username: string;
    displayName: string;
  };
};

export type AuditExportPage = {
  items: AuditExportItem[];
  nextCursor: string | null;
  format: AuditExportFormat;
  limit: number;
};

const SENSITIVE_KEYS = new Set([
  "password",
  "passwordhash",
  "passwd",
  "passphrase",
  "secret",
  "clientsecret",
  "apisecret",
  "authentication",
  "authorization",
  "proxyauthorization",
  "bearer",
  "cookie",
  "setcookie",
  "session",
  "sessiontoken",
  "token",
  "tokenhash",
  "accesstoken",
  "refreshtoken",
  "apikey",
  "privatekey",
  "signingkey",
  "encryptionkey",
  "codehash",
  "invitecode",
  "recoverycode",
  "verificationcode",
  "mfacode",
  "otp",
  "csrf",
  "credential",
  "credentials",
  "clientassertion",
  "mnemonic",
  "seed",
  "idempotencykey",
]);

const SAFE_METADATA_KEYS = new Set([
  "amountmilli",
  "batchcount",
  "eventversion",
  "fromeventid",
  "frommarketversion",
  "fromversion",
  "liquidityparameter",
  "marketid",
  "outcome",
  "payoutmilli",
  "processedcount",
  "proposalid",
  "settlementcount",
  "settlementrunid",
  "status",
  "subsidymilli",
  "toeventid",
  "tomarketversion",
  "totalpayoutmilli",
  "toversion",
  "userid",
]);

function normalizedKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/gu, "");
}

function isSensitiveKey(key: string): boolean {
  const normalized = normalizedKey(key);
  return (
    SENSITIVE_KEYS.has(normalized) ||
    normalized.endsWith("password") ||
    normalized.endsWith("secret") ||
    normalized.endsWith("token") ||
    normalized.endsWith("accesstoken") ||
    normalized.endsWith("refreshtoken") ||
    normalized.endsWith("privatekey")
  );
}

export function redactAuditMetadata(value: unknown, depth = 0): unknown {
  if (depth >= MAX_METADATA_DEPTH) return TRUNCATED;
  if (Array.isArray(value)) {
    return value.map((entry) => redactAuditMetadata(entry, depth + 1));
  }
  if (value && typeof value === "object") {
    const redacted: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      redacted[key] = isSensitiveKey(key) || !SAFE_METADATA_KEYS.has(normalizedKey(key))
        ? REDACTED
        : redactAuditMetadata(entry, depth + 1);
    }
    return redacted;
  }
  return value;
}

export function parseAndRedactAuditMetadata(metadata: string): unknown {
  if (Buffer.byteLength(metadata, "utf8") > MAX_METADATA_BYTES) {
    return { _redacted: "Stored metadata exceeded the export size limit." };
  }
  try {
    return redactAuditMetadata(JSON.parse(metadata) as unknown);
  } catch {
    return { _redacted: "Stored metadata was not valid JSON." };
  }
}

function decodeAuditCursor(cursor: string): { createdAt: Date; id: string } {
  try {
    const raw = Buffer.from(cursor, "base64url").toString("utf8");
    const parsed = JSON.parse(raw) as unknown;
    const result = z
      .object({ createdAt: z.string().datetime({ offset: true }), id: identifier })
      .strict()
      .parse(parsed);
    return { createdAt: new Date(result.createdAt), id: result.id };
  } catch {
    throw new ApiError(400, "INVALID_CURSOR", "The audit-log cursor is invalid.");
  }
}

function rawQuery(searchParams: URLSearchParams): Record<string, string> {
  const allowed = new Set([
    "actor",
    "action",
    "entityType",
    "entityId",
    "from",
    "to",
    "limit",
    "cursor",
    "format",
  ]);
  const input: Record<string, string> = {};
  for (const [key, value] of searchParams) {
    if (!allowed.has(key) || key in input) {
      throw new ApiError(400, "INVALID_FILTERS", "Audit-log filters contain an unknown or repeated field.");
    }
    input[key] = value;
  }
  return input;
}

export async function readAuditExportPage(searchParams: URLSearchParams): Promise<AuditExportPage> {
  const query = querySchema.parse(rawQuery(searchParams));
  const cursor = query.cursor ? decodeAuditCursor(query.cursor) : undefined;
  const filters: Prisma.AuditLogWhereInput[] = [];

  if (query.actor) {
    filters.push({
      OR: [{ actorUserId: query.actor }, { actor: { username: query.actor } }],
    });
  }
  if (query.action) filters.push({ action: query.action });
  if (query.entityType) filters.push({ entityType: query.entityType });
  if (query.entityId) filters.push({ entityId: query.entityId });
  if (query.from || query.to) {
    filters.push({
      createdAt: {
        ...(query.from ? { gte: query.from } : {}),
        ...(query.to ? { lte: query.to } : {}),
      },
    });
  }
  if (cursor) {
    filters.push({
      OR: [
        { createdAt: { lt: cursor.createdAt } },
        { createdAt: cursor.createdAt, id: { lt: cursor.id } },
      ],
    });
  }

  const records = await prisma.auditLog.findMany({
    where: filters.length ? { AND: filters } : undefined,
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: query.limit + 1,
    select: {
      id: true,
      action: true,
      entityType: true,
      entityId: true,
      metadata: true,
      createdAt: true,
      actor: { select: { id: true, username: true, displayName: true } },
    },
  });

  const hasMore = records.length > query.limit;
  const pageRecords = hasMore ? records.slice(0, query.limit) : records;
  const last = pageRecords.at(-1);
  return {
    items: pageRecords.map((record) => ({
      ...record,
      metadata: parseAndRedactAuditMetadata(record.metadata),
    })),
    nextCursor:
      hasMore && last
        ? encodeCursor({ createdAt: last.createdAt.toISOString(), id: last.id })
        : null,
    format: query.format,
    limit: query.limit,
  };
}

function spreadsheetSafe(value: string): string {
  const withoutNul = value.replace(/\u0000/gu, "\uFFFD");
  return /^[\u0001-\u0020]*[=+\-@]/u.test(withoutNul) ? `'${withoutNul}` : withoutNul;
}

function csvCell(value: string): string {
  return `"${spreadsheetSafe(value).replace(/"/gu, '""')}"`;
}

export function serializeAuditCsv(items: AuditExportItem[]): string {
  const rows = [
    ["id", "createdAt", "actorId", "actorUsername", "actorDisplayName", "action", "entityType", "entityId", "metadata"],
    ...items.map((item) => [
      item.id,
      item.createdAt.toISOString(),
      item.actor.id,
      item.actor.username,
      item.actor.displayName,
      item.action,
      item.entityType,
      item.entityId,
      JSON.stringify(item.metadata) ?? "null",
    ]),
  ];
  return `${rows.map((row) => row.map(csvCell).join(",")).join("\r\n")}\r\n`;
}
