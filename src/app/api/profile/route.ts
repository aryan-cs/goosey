import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { readJsonObject } from "@/lib/http";
import { apiErrorResponse, jsonResponse, prisma, requireUser } from "@/lib/market-service";

const profileSchema = z.object({ displayName: z.string().trim().min(2).max(40), bio: z.string().trim().max(280), profilePublic: z.boolean(), leaderboardVisible: z.boolean() }).strict();

export async function PATCH(request: NextRequest): Promise<NextResponse> {
  try {
    const user = await requireUser(request, true); const body = profileSchema.parse(await readJsonObject(request));
    const profile = await prisma.user.update({ where: { id: user.id }, data: body, select: { username: true, displayName: true, bio: true, profilePublic: true, leaderboardVisible: true } });
    return jsonResponse({ profile }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return apiErrorResponse(error); }
}
