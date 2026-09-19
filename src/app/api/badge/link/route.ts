import { NextRequest } from "next/server";
import { z } from "zod";
import { ApiError, apiErrorResponse, consumeRateLimit, jsonResponse, prisma, requireUser } from "@/lib/market-service";
import { readJsonObject } from "@/lib/http";
import { runAuthenticatedMutation } from "@/lib/mutation-session";
import { BADGE_ACCESS_PURPOSE, BADGE_ACCESS_TTL_MS } from "@/lib/badge-access";

const schema = z.object({ challenge: z.string().regex(/^[a-f0-9]{64}$/) }).strict();

export async function POST(request: NextRequest) {
  try {
    const body = schema.parse(await readJsonObject(request));
    const user = await requireUser(request, true);
    if (user.role !== "USER") throw new ApiError(403, "PARTICIPANT_REQUIRED", "Use a participant account to link a trading badge.");
    await consumeRateLimit(prisma, `badge-link:${user.id}`, 10, 3600000);
    const device = await runAuthenticatedMutation(request, user.id, async (tx) => {
      const existing = await tx.accountToken.findUnique({ where: { tokenHash: body.challenge } });
      if (existing) {
        if (existing.userId !== user.id || existing.purpose !== BADGE_ACCESS_PURPOSE || existing.consumedAt || existing.expiresAt <= new Date()) {
          throw new ApiError(409, "BADGE_LINK_CONFLICT", "Start a new link request from the badge gateway.");
        }
        return existing;
      }
      return tx.accountToken.create({ data: {
        userId: user.id, purpose: BADGE_ACCESS_PURPOSE, tokenHash: body.challenge,
        expiresAt: new Date(Date.now() + BADGE_ACCESS_TTL_MS),
      } });
    });
    return jsonResponse({ linked: true, username: user.username, expiresAt: device.expiresAt });
  } catch (error) { return apiErrorResponse(error); }
}

export async function GET(request: NextRequest) {
  try {
    const user = await requireUser(request);
    const devices = await prisma.accountToken.findMany({
      where: { userId: user.id, purpose: BADGE_ACCESS_PURPOSE, consumedAt: null, expiresAt: { gt: new Date() } },
      select: { id: true, tokenHash: true, createdAt: true, expiresAt: true }, orderBy: { createdAt: "desc" },
    });
    return jsonResponse({ devices: devices.map(({ tokenHash, ...device }) => ({ ...device, code: tokenHash.slice(0, 8).toUpperCase() })) });
  } catch (error) { return apiErrorResponse(error); }
}

export async function DELETE(request: NextRequest) {
  try {
    const { id } = z.object({ id: z.string().cuid() }).strict().parse(await readJsonObject(request));
    const user = await requireUser(request, true);
    await runAuthenticatedMutation(request, user.id, (tx) => tx.accountToken.updateMany({
      where: { id, userId: user.id, purpose: BADGE_ACCESS_PURPOSE, consumedAt: null }, data: { consumedAt: new Date() },
    }));
    return jsonResponse({ revoked: true });
  } catch (error) { return apiErrorResponse(error); }
}
