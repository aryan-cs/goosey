import { NextRequest } from "next/server";
import { assertAdmin } from "@/lib/admin-service";
import { balanceDebitSchema, debitUserBalance } from "@/lib/admin-balance-adjustment";
import { readJsonObject } from "@/lib/http";
import { ApiError, apiErrorResponse, consumeRateLimit, jsonResponse, parseIdempotencyKey, prisma, requireUser } from "@/lib/market-service";
import { canonicalizeUsername, constantTimeEqual } from "@/lib/security";

async function actor(request: NextRequest): Promise<{ id: string; session: boolean }> {
  const authorization = request.headers.get("authorization");
  if (authorization) {
    const token = /^Bearer ([A-Za-z0-9_-]{43,128})$/.exec(authorization)?.[1];
    const configured = process.env.GOOSEY_OPERATOR_API_TOKEN;
    if (!token || !configured || !constantTimeEqual(token, configured)) throw new ApiError(401, "OPERATOR_AUTHENTICATION_REQUIRED", "Valid operator authentication is required.");
    const username = canonicalizeUsername(process.env.GOOSEY_OPERATOR_ACTOR_USERNAME);
    if (!username) throw new ApiError(503, "OPERATOR_NOT_CONFIGURED", "The operator actor is not configured.");
    const configuredActor = await prisma.user.findUnique({ where: { username }, select: { id: true, role: true, status: true } });
    if (configuredActor?.role === "ADMIN" && configuredActor.status === "ACTIVE") return { id: configuredActor.id, session: false };
    const activeAdministrators = await prisma.user.findMany({ where: { role: "ADMIN", status: "ACTIVE" }, orderBy: { id: "asc" }, take: 2, select: { id: true } });
    if (activeAdministrators.length !== 1) throw new ApiError(503, "OPERATOR_NOT_CONFIGURED", "The configured operator actor is unavailable and there is not exactly one active administrator.");
    return { id: activeAdministrators[0].id, session: false };
  }
  const user = await requireUser(request, true); assertAdmin(user); return { id: user.id, session: true };
}

export async function POST(request: NextRequest) {
  try {
    const principal = await actor(request);
    await consumeRateLimit(prisma, `admin-balance-debit:${principal.id}`, 20, 60_000);
    const debit = balanceDebitSchema.parse(await readJsonObject(request));
    const result = await debitUserBalance({ actorUserId: principal.id, idempotencyKey: parseIdempotencyKey(request), debit, sessionRequest: principal.session ? request : undefined });
    return jsonResponse({ ...result, balanceMilli: result.balanceMilli.toString() }, { status: result.replayed ? 200 : 201, headers: { "Cache-Control": "no-store" } });
  } catch (error) { return apiErrorResponse(error); }
}
