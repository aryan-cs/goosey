import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { SESSION_COOKIE_NAME } from "@/lib/auth";
import { readJsonObject } from "@/lib/http";
import { ApiError, apiErrorResponse, jsonResponse, prisma, requireUser } from "@/lib/market-service";
import { sha256 } from "@/lib/security";
import { runAuthenticatedMutation } from "@/lib/mutation-session";

const revokeSchema = z.object({ sessionId: z.string().cuid().optional(), allOther: z.boolean().optional() }).strict().refine((body) => Boolean(body.sessionId) !== Boolean(body.allOther), { message: "Choose one session revocation mode." });

function privateNoStore(response: NextResponse): NextResponse {
  response.headers.set("Cache-Control", "private, no-store, max-age=0");
  response.headers.set("Pragma", "no-cache");
  response.headers.append("Vary", "Cookie");
  return response;
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  try {
    const user = await requireUser(request);
    const currentHash = request.cookies.get(SESSION_COOKIE_NAME)?.value ? sha256(request.cookies.get(SESSION_COOKIE_NAME)!.value) : null;
    const sessions = await prisma.session.findMany({ where: { userId: user.id, expiresAt: { gt: new Date() } }, orderBy: { createdAt: "desc" }, select: { id: true, tokenHash: true, userAgent: true, createdAt: true, expiresAt: true } });
    return privateNoStore(jsonResponse({ items: sessions.map(({ tokenHash, ...session }) => ({ ...session, current: tokenHash === currentHash })) }));
  } catch (error) { return privateNoStore(apiErrorResponse(error)); }
}

export async function DELETE(request: NextRequest): Promise<NextResponse> {
  try {
    const user = await requireUser(request, true);
    const body = revokeSchema.parse(await readJsonObject(request));
    const currentToken = request.cookies.get(SESSION_COOKIE_NAME)?.value;
    if (!currentToken) throw new ApiError(401, "AUTHENTICATION_REQUIRED", "Sign in to continue.");
    const currentHash = sha256(currentToken);
    const result = await runAuthenticatedMutation(request, user.id, async (tx) => {
      const deleted = await tx.session.deleteMany({ where: {
        ...(!body.allOther ? { id: body.sessionId } : {}),
        userId: user.id, tokenHash: { not: currentHash },
      } });
      if (!body.allOther && deleted.count !== 1) throw new ApiError(404, "SESSION_NOT_FOUND", "That revocable session was not found.");
      return deleted;
    });
    return privateNoStore(jsonResponse({ revoked: result.count }));
  } catch (error) { return privateNoStore(apiErrorResponse(error)); }
}
