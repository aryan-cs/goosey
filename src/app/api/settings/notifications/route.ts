import { NextRequest } from "next/server";
import { readJsonObject } from "@/lib/http";
import { apiErrorResponse, jsonResponse, prisma, requireUser } from "@/lib/market-service";
import { notificationPreferencesSchema, parseNotificationPreferences } from "@/lib/notification-preferences";

const responseOptions = { headers: { "Cache-Control": "no-store" } };

export async function GET(request: NextRequest) {
  try {
    const user = await requireUser(request);
    const account = await prisma.user.findUniqueOrThrow({ where: { id: user.id }, select: { notificationPreferences: true } });
    return jsonResponse({ preferences: parseNotificationPreferences(account.notificationPreferences) }, responseOptions);
  } catch (error) { return apiErrorResponse(error); }
}

export async function PATCH(request: NextRequest) {
  try {
    const user = await requireUser(request, true);
    const preferences = notificationPreferencesSchema.parse(await readJsonObject(request));
    await prisma.user.update({ where: { id: user.id }, data: { notificationPreferences: JSON.stringify(preferences) }, select: { id: true } });
    return jsonResponse({ preferences }, responseOptions);
  } catch (error) { return apiErrorResponse(error); }
}
