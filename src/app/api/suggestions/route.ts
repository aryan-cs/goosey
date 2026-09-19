import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { apiErrorResponse, consumeRateLimit, jsonResponse, prisma, requireUser } from "@/lib/market-service";
import { readJsonObject } from "@/lib/http";

const suggestionSchema = z.object({
  title: z.string().trim().min(12).max(180),
  description: z.string().trim().min(30).max(2_000),
  category: z.string().trim().min(2).max(50),
}).strict();

export async function GET(request: NextRequest): Promise<NextResponse> {
  try {
    const user = await requireUser(request);
    const items = await prisma.marketSuggestion.findMany({ where: { userId: user.id }, orderBy: { createdAt: "desc" }, take: 50 });
    return jsonResponse({ items }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return apiErrorResponse(error); }
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    const user = await requireUser(request, true);
    await consumeRateLimit(prisma, `suggestion:${user.id}`, 5, 24 * 60 * 60 * 1_000);
    const body = suggestionSchema.parse(await readJsonObject(request));
    const suggestion = await prisma.marketSuggestion.create({ data: { ...body, userId: user.id } });
    return jsonResponse({ suggestion }, { status: 201, headers: { "Cache-Control": "no-store" } });
  } catch (error) { return apiErrorResponse(error); }
}
