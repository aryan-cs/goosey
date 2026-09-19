import { z } from "zod";

const encodedCursorSchema = z.string().min(1).max(512).regex(/^[A-Za-z0-9_-]+$/);
const cursorPayloadSchema = z.object({
  createdAt: z.string().datetime({ offset: true }),
  id: z.string().cuid(),
}).strict();

export type NotificationCursor = {
  createdAt: Date;
  id: string;
};

export class NotificationCursorError extends Error {
  constructor() {
    super("The notification cursor is invalid.");
    this.name = "NotificationCursorError";
  }
}

export function encodeNotificationCursor(value: NotificationCursor): string {
  const payload = cursorPayloadSchema.parse({
    createdAt: value.createdAt.toISOString(),
    id: value.id,
  });
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

export function decodeNotificationCursor(value: string): NotificationCursor {
  try {
    const encoded = encodedCursorSchema.parse(value);
    const bytes = Buffer.from(encoded, "base64url");
    if (bytes.toString("base64url") !== encoded) throw new NotificationCursorError();
    const payload = cursorPayloadSchema.parse(JSON.parse(bytes.toString("utf8")) as unknown);
    return { createdAt: new Date(payload.createdAt), id: payload.id };
  } catch {
    throw new NotificationCursorError();
  }
}
