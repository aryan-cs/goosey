import { createHash } from "node:crypto";

import { Prisma, type MarketEvent } from "@prisma/client";
import { isPrismaErrorCode } from "@/lib/prisma-errors";
import { z } from "zod";

import { ApiError, consumeRateLimit, prisma } from "@/lib/market-service";
import { jsonStringify } from "@/lib/serializers";
import { runSerializableTransaction } from "@/lib/serializable-transaction";

const MUTABLE_MARKET_STATUSES = ["DRAFT", "OPEN", "PAUSED", "CLOSED"] as const;
const eventColors = ["gold", "green", "blue", "sky", "orange", "red", "violet"] as const;

const cleanText = (minimum: number, maximum: number) =>
  z
    .string()
    .trim()
    .min(minimum)
    .max(maximum)
    .refine((value) => !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value), {
      message: "Text contains unsupported control characters.",
    });

const slugSchema = z
  .string()
  .trim()
  .min(3)
  .max(120)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);

const instantSchema = z
  .string()
  .datetime({ offset: true })
  .transform((value) => new Date(value));

const eventMetadataShape = {
  slug: slugSchema,
  title: cleanText(10, 240),
  shortTitle: cleanText(3, 90),
  description: cleanText(20, 5_000),
  category: cleanText(2, 60),
  featured: z.boolean(),
  color: z.enum(eventColors),
  icon: z.string().trim().min(1).max(40).regex(/^[a-z0-9-]+$/),
  startsAt: instantSchema,
  endsAt: instantSchema,
};

export const createEventSchema = z
  .object({
    ...eventMetadataShape,
    featured: eventMetadataShape.featured.default(false),
    color: eventMetadataShape.color.default("gold"),
    icon: eventMetadataShape.icon.default("sparkles"),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.endsAt <= value.startsAt) {
      context.addIssue({
        code: "custom",
        path: ["endsAt"],
        message: "Event end must be after its start.",
      });
    }
  });

export const updateEventSchema = z
  .object({
    expectedVersion: z.number().int().nonnegative().max(2_147_483_647),
    slug: eventMetadataShape.slug.optional(),
    title: eventMetadataShape.title.optional(),
    shortTitle: eventMetadataShape.shortTitle.optional(),
    description: eventMetadataShape.description.optional(),
    category: eventMetadataShape.category.optional(),
    featured: eventMetadataShape.featured.optional(),
    color: eventMetadataShape.color.optional(),
    icon: eventMetadataShape.icon.optional(),
    startsAt: eventMetadataShape.startsAt.optional(),
    endsAt: eventMetadataShape.endsAt.optional(),
  })
  .strict()
  .refine(
    (value) => Object.keys(value).some((key) => key !== "expectedVersion"),
    { message: "At least one event field must be supplied." },
  );

export const eventMembershipSchema = z
  .object({
    expectedMarketVersion: z.number().int().nonnegative().max(2_147_483_647),
    expectedEventVersion: z.number().int().nonnegative().max(2_147_483_647),
  })
  .strict();

type CreateEventInput = z.infer<typeof createEventSchema>;
type UpdateEventInput = z.infer<typeof updateEventSchema>;
type MembershipAction = "ATTACH" | "DETACH";

const eventSelect = {
  id: true,
  slug: true,
  title: true,
  shortTitle: true,
  description: true,
  category: true,
  featured: true,
  color: true,
  icon: true,
  startsAt: true,
  endsAt: true,
  version: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.MarketEventSelect;

function requestHash(value: unknown): string {
  return createHash("sha256").update(jsonStringify(value)).digest("hex");
}

async function requireActiveAdmin(
  tx: Prisma.TransactionClient,
  actorUserId: string,
): Promise<void> {
  const actor = await tx.user.findUnique({
    where: { id: actorUserId },
    select: { role: true, status: true },
  });
  if (!actor || actor.role !== "ADMIN" || actor.status !== "ACTIVE") {
    throw new ApiError(403, "ADMIN_REQUIRED", "An active administrator account is required.");
  }
}

function publicEvent(event: Pick<MarketEvent, keyof typeof eventSelect>) {
  return event;
}

export async function createAdminEvent(input: {
  actorUserId: string;
  idempotencyKey: string;
  event: CreateEventInput;
}) {
  await consumeRateLimit(prisma, `admin-event-create:${input.actorUserId}`, 10, 60_000);
  const hash = requestHash(input.event);

  try {
    return await runSerializableTransaction(prisma, async (tx) => {
      await requireActiveAdmin(tx, input.actorUserId);
      const previous = await tx.marketEventCreationRequest.findUnique({
        where: {
          actorUserId_key: {
            actorUserId: input.actorUserId,
            key: input.idempotencyKey,
          },
        },
        select: { requestHash: true, event: { select: eventSelect } },
      });
      if (previous) {
        if (previous.requestHash !== hash) {
          throw new ApiError(
            409,
            "IDEMPOTENCY_CONFLICT",
            "This idempotency key was used for a different event request.",
          );
        }
        return { event: publicEvent(previous.event), replayed: true };
      }

      const event = await tx.marketEvent.create({
        data: {
          ...input.event,
          createdById: input.actorUserId,
        },
        select: eventSelect,
      });
      await tx.marketEventCreationRequest.create({
        data: {
          actorUserId: input.actorUserId,
          eventId: event.id,
          key: input.idempotencyKey,
          requestHash: hash,
        },
      });
      await tx.auditLog.create({
        data: {
          actorUserId: input.actorUserId,
          action: "MARKET_EVENT_CREATED",
          entityType: "MARKET_EVENT",
          entityId: event.id,
          metadata: jsonStringify({ requestHash: hash, event }),
        },
      });
      return { event: publicEvent(event), replayed: false };
    });
  } catch (error) {
    if (!isPrismaErrorCode(error, "P2002")) {
      throw error;
    }
    const previous = await prisma.marketEventCreationRequest.findUnique({
      where: {
        actorUserId_key: {
          actorUserId: input.actorUserId,
          key: input.idempotencyKey,
        },
      },
      select: { requestHash: true, event: { select: eventSelect } },
    });
    if (!previous) {
      throw new ApiError(409, "EVENT_SLUG_UNAVAILABLE", "That event slug is already in use.");
    }
    if (previous.requestHash !== hash) {
      throw new ApiError(
        409,
        "IDEMPOTENCY_CONFLICT",
        "This idempotency key was used for a different event request.",
      );
    }
    return { event: publicEvent(previous.event), replayed: true };
  }
}

export async function updateAdminEvent(input: {
  actorUserId: string;
  eventId: string;
  update: UpdateEventInput;
}) {
  await consumeRateLimit(prisma, `admin-event-update:${input.actorUserId}`, 30, 60_000);

  try {
    return await runSerializableTransaction(prisma, async (tx) => {
      await requireActiveAdmin(tx, input.actorUserId);
      const current = await tx.marketEvent.findUnique({
        where: { id: input.eventId },
        select: eventSelect,
      });
      if (!current) throw new ApiError(404, "EVENT_NOT_FOUND", "Event not found.");
      if (current.version !== input.update.expectedVersion) {
        throw new ApiError(
          409,
          "STALE_EVENT_VERSION",
          "The event changed after this update was prepared. Refresh and review it again.",
        );
      }

      const { expectedVersion: _expectedVersion, ...changes } = input.update;
      void _expectedVersion;
      const startsAt = changes.startsAt ?? current.startsAt;
      const endsAt = changes.endsAt ?? current.endsAt;
      if (endsAt <= startsAt) {
        throw new ApiError(422, "INVALID_EVENT_RANGE", "Event end must be after its start.");
      }

      const changed = Object.entries(changes).some(([key, value]) => {
        const previous = current[key as keyof typeof current];
        return previous instanceof Date && value instanceof Date
          ? previous.getTime() !== value.getTime()
          : previous !== value;
      });
      if (!changed) return { event: publicEvent(current), replayed: true };

      const claimed = await tx.marketEvent.updateMany({
        where: { id: current.id, version: current.version },
        data: { ...changes, version: { increment: 1 } },
      });
      if (claimed.count !== 1) {
        throw new ApiError(409, "RETRYABLE_CONFLICT", "The event changed concurrently.");
      }
      const updated = await tx.marketEvent.findUniqueOrThrow({
        where: { id: current.id },
        select: eventSelect,
      });
      const changedKeys = Object.keys(changes) as Array<keyof typeof changes>;
      const before = Object.fromEntries(changedKeys.map((key) => [key, current[key]]));
      const after = Object.fromEntries(changedKeys.map((key) => [key, updated[key]]));
      await tx.auditLog.create({
        data: {
          actorUserId: input.actorUserId,
          action: "MARKET_EVENT_UPDATED",
          entityType: "MARKET_EVENT",
          entityId: current.id,
          metadata: jsonStringify({
            fromVersion: current.version,
            toVersion: updated.version,
            before,
            after,
          }),
        },
      });
      return { event: publicEvent(updated), replayed: false };
    });
  } catch (error) {
    if (isPrismaErrorCode(error, "P2002")) {
      throw new ApiError(409, "EVENT_SLUG_UNAVAILABLE", "That event slug is already in use.");
    }
    throw error;
  }
}

async function changeEventMembership(input: {
  actorUserId: string;
  eventId: string;
  marketId: string;
  expectedMarketVersion: number;
  expectedEventVersion: number;
  action: MembershipAction;
}) {
  await consumeRateLimit(prisma, `admin-event-membership:${input.actorUserId}`, 60, 60_000);

  return runSerializableTransaction(prisma, async (tx) => {
    await requireActiveAdmin(tx, input.actorUserId);
    const [event, market] = await Promise.all([
      tx.marketEvent.findUnique({
        where: { id: input.eventId },
        select: { id: true, version: true },
      }),
      tx.market.findUnique({
        where: { id: input.marketId },
        select: { id: true, eventId: true, status: true, version: true },
      }),
    ]);
    if (!event) throw new ApiError(404, "EVENT_NOT_FOUND", "Event not found.");
    if (!market) throw new ApiError(404, "MARKET_NOT_FOUND", "Market not found.");
    if (input.action === "ATTACH" && market.eventId === input.eventId) {
      return { market, eventVersion: event.version, replayed: true };
    }
    if (input.action === "DETACH" && market.eventId === null) {
      return { market, eventVersion: event.version, replayed: true };
    }
    if (market.version !== input.expectedMarketVersion) {
      throw new ApiError(
        409,
        "STALE_MARKET_VERSION",
        "The market changed after this membership request was prepared. Refresh and review it again.",
      );
    }
    if (event.version !== input.expectedEventVersion) {
      throw new ApiError(
        409,
        "STALE_EVENT_VERSION",
        "The event changed after this membership request was prepared. Refresh and review it again.",
      );
    }
    if (!MUTABLE_MARKET_STATUSES.includes(market.status as (typeof MUTABLE_MARKET_STATUSES)[number])) {
      throw new ApiError(
        409,
        "MARKET_RESOLUTION_IN_PROGRESS",
        "Resolving and terminal markets cannot change event membership.",
      );
    }

    if (input.action === "ATTACH") {
      if (market.eventId) {
        throw new ApiError(
          409,
          "MARKET_ALREADY_ATTACHED",
          "Detach the market from its current event before attaching it to another event.",
        );
      }
    } else {
      if (market.eventId !== input.eventId) {
        throw new ApiError(409, "MARKET_EVENT_MISMATCH", "The market belongs to a different event.");
      }
    }

    const nextEventId = input.action === "ATTACH" ? input.eventId : null;
    const marketClaim = await tx.market.updateMany({
      where: {
        id: market.id,
        version: market.version,
        status: { in: [...MUTABLE_MARKET_STATUSES] },
        eventId: input.action === "ATTACH" ? null : input.eventId,
      },
      data: { eventId: nextEventId, version: { increment: 1 } },
    });
    if (marketClaim.count !== 1) {
      throw new ApiError(409, "RETRYABLE_CONFLICT", "The market changed concurrently.");
    }
    const eventClaim = await tx.marketEvent.updateMany({
      where: { id: event.id, version: event.version },
      data: { version: { increment: 1 } },
    });
    if (eventClaim.count !== 1) {
      throw new ApiError(409, "RETRYABLE_CONFLICT", "The event changed concurrently.");
    }
    const [updatedMarket, updatedEvent] = await Promise.all([
      tx.market.findUniqueOrThrow({
        where: { id: market.id },
        select: { id: true, eventId: true, status: true, version: true },
      }),
      tx.marketEvent.findUniqueOrThrow({
        where: { id: event.id },
        select: { version: true },
      }),
    ]);
    await tx.auditLog.create({
      data: {
        actorUserId: input.actorUserId,
        action: `MARKET_EVENT_${input.action}`,
        entityType: "MARKET_EVENT",
        entityId: event.id,
        metadata: jsonStringify({
          marketId: market.id,
          fromEventId: market.eventId,
          toEventId: nextEventId,
          fromMarketVersion: market.version,
          toMarketVersion: updatedMarket.version,
          fromEventVersion: event.version,
          toEventVersion: updatedEvent.version,
        }),
      },
    });
    return { market: updatedMarket, eventVersion: updatedEvent.version, replayed: false };
  });
}

export function attachMarketToEvent(input: {
  actorUserId: string;
  eventId: string;
  marketId: string;
  expectedMarketVersion: number;
  expectedEventVersion: number;
}) {
  return changeEventMembership({ ...input, action: "ATTACH" });
}

export function detachMarketFromEvent(input: {
  actorUserId: string;
  eventId: string;
  marketId: string;
  expectedMarketVersion: number;
  expectedEventVersion: number;
}) {
  return changeEventMembership({ ...input, action: "DETACH" });
}
