import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { readJsonObject } from "@/lib/http";
import { ApiError, apiErrorResponse, jsonResponse, prisma, requireUser } from "@/lib/market-service";
import { isPrismaErrorCode } from "@/lib/prisma-errors";
import { canonicalizeUsername } from "@/lib/security";

const usernameSchema = z.string().transform((value, context) => {
  const username = canonicalizeUsername(value);
  if (!username) {
    context.addIssue({ code: "custom", message: "Use 3–24 letters, numbers, or underscores, starting and ending with a letter or number." });
    return z.NEVER;
  }
  return username;
});

const profileSchema = z.object({
  username: usernameSchema.optional(),
  displayName: z.string().trim().min(2).max(40).optional(),
  bio: z.string().trim().max(280).optional(),
  profilePublic: z.boolean().optional(),
  leaderboardVisible: z.boolean().optional(),
}).strict().refine((body) => Object.values(body).some((value) => value !== undefined), {
  message: "Provide at least one profile setting to update.",
});

export async function PATCH(request: NextRequest): Promise<NextResponse> {
  try {
    const user = await requireUser(request, true);
    const body = profileSchema.parse(await readJsonObject(request));
    const data = body.username === undefined ? body : { ...body, displayName: body.username };
    const profile = await prisma.user.update({ where: { id: user.id }, data, select: { username: true, displayName: true, bio: true, profilePublic: true, leaderboardVisible: true } });
    return jsonResponse({ profile }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    if (isPrismaErrorCode(error, "P2002")) {
      return apiErrorResponse(new ApiError(409, "USERNAME_TAKEN", "That username is already taken. Choose another."));
    }
    return apiErrorResponse(error);
  }
}
