import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { readJsonObject } from "@/lib/http";
import { isValidPassword } from "@/lib/security";
import { issueWalletLinkChallenge } from "@/lib/solana/wallet-link-service";
import { mutationGate, privateResponse, walletAddressSchema, walletAuthentication, walletError } from "../_shared";

export const runtime = "nodejs";
const schema = z.object({ walletAddress: walletAddressSchema, password: z.string().max(72).refine(isValidPassword) }).strict();
export async function POST(request: NextRequest) {
  try {
    const authentication = await walletAuthentication(request, true);
    const body = schema.parse(await readJsonObject(request));
    const configuration = await mutationGate(request, authentication.userId, "challenge");
    const issued = await issueWalletLinkChallenge({ authentication, configuration, walletAddress: body.walletAddress, password: body.password });
    return privateResponse(NextResponse.json(issued, { status: 201 }));
  } catch (error) { return walletError(error); }
}
