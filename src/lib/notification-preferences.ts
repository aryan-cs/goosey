import type { Prisma } from "@prisma/client";
import { z } from "zod";
import { db } from "@/lib/db";

export const notificationPreferencesSchema = z.object({
  trades: z.boolean(),
  resolutions: z.boolean(),
  replies: z.boolean(),
  suggestions: z.boolean(),
}).strict();
export type NotificationPreferencesValue = z.infer<typeof notificationPreferencesSchema>;
export const defaultNotificationPreferences: NotificationPreferencesValue = {
  trades: true, resolutions: true, replies: true, suggestions: true,
};
const typesByPreference = {
  trades: ["TRADE_CONFIRMED", "COMPLETE_SET_REDEEMED"],
  resolutions: ["MARKET_RESOLVED"],
  replies: ["COMMENT_REPLY"],
  suggestions: ["SUGGESTION_REVIEWED"],
} satisfies Record<keyof NotificationPreferencesValue, string[]>;

/** Old accounts and invalid stored values retain delivery by default. */
export function parseNotificationPreferences(value: string | null | undefined): NotificationPreferencesValue {
  try {
    const parsed: unknown = JSON.parse(value ?? "{}");
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { ...defaultNotificationPreferences };
    return Object.fromEntries(Object.entries(defaultNotificationPreferences).map(([key, fallback]) => {
      const stored = (parsed as Record<string, unknown>)[key];
      return [key, typeof stored === "boolean" ? stored : fallback];
    })) as NotificationPreferencesValue;
  } catch { return { ...defaultNotificationPreferences }; }
}

export function notificationTypeFilter(preferences: NotificationPreferencesValue): Prisma.NotificationWhereInput {
  const hiddenTypes = (Object.keys(typesByPreference) as (keyof NotificationPreferencesValue)[])
    .flatMap((key) => preferences[key] ? [] : typesByPreference[key]);
  // Exclude only known optional types. Moderation and future/unknown types stay visible.
  return hiddenTypes.length ? { type: { notIn: hiddenTypes } } : {};
}

type NotificationPreferenceReader = Pick<Prisma.TransactionClient, "user">;

export async function getNotificationFilter(
  userId: string,
  client: NotificationPreferenceReader = db,
): Promise<Prisma.NotificationWhereInput> {
  const user = await client.user.findUniqueOrThrow({ where: { id: userId }, select: { notificationPreferences: true } });
  return notificationTypeFilter(parseNotificationPreferences(user.notificationPreferences));
}
