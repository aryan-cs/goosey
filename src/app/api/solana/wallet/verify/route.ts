import { NextRequest, NextResponse } from "next/server";
import { readJsonObject } from "@/lib/http";
import { consumeWalletLinkChallenge } from "@/lib/solana/wallet-link-service";
import { mutationGate, privateResponse, publicLink, verifySchema, walletAuthentication, walletError } from "../_shared";

export const runtime = "nodejs";
export async function POST(request: NextRequest) {
  try {
    const authentication = await walletAuthentication(request, true);
    const body = verifySchema.parse(await readJsonObject(request));
    const configuration = await mutationGate(request, authentication.userId, "verify");
    const link = await consumeWalletLinkChallenge({ ...body, authentication, configuration });
    return privateResponse(NextResponse.json({ wallet: publicLink(link) }));
  } catch (error) { return walletError(error); }
}
