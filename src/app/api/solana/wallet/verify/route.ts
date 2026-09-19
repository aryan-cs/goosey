import { NextRequest, NextResponse } from "next/server";
import { readJsonObject } from "@/lib/http";
import { setSessionCookie } from "@/lib/auth";
import { consumeWalletLinkChallenge } from "@/lib/solana/wallet-link-service";
import { mutationGate, privateResponse, publicLink, verifySchema, walletAuthentication, walletError } from "../_shared";

export const runtime = "nodejs";
export async function POST(request: NextRequest) {
  try {
    const authentication = await walletAuthentication(request, true);
    const body = verifySchema.parse(await readJsonObject(request));
    const configuration = await mutationGate(request, authentication.userId, "verify");
    const linked = await consumeWalletLinkChallenge({ ...body, authentication, configuration });
    const response = privateResponse(NextResponse.json({ wallet: publicLink(linked.wallet) }));
    setSessionCookie(response, linked.session);
    return response;
  } catch (error) { return walletError(error); }
}
