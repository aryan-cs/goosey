import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/market-service";
import { privateResponse, publicLink, walletAuthentication, walletConfiguration, walletError } from "./_shared";

export const runtime = "nodejs";
export async function GET(request: NextRequest) {
  try {
    const { userId } = await walletAuthentication(request, false);
    const { configuration } = walletConfiguration();
    const items = await prisma.solanaWalletLink.findMany({
      where: { userId, chainId: configuration.chainId, genesisHash: configuration.genesisHash },
      select: { id: true, chainId: true, genesisHash: true, walletAddress: true, verifiedAt: true },
      orderBy: { verifiedAt: "desc" }, take: 1,
    });
    return privateResponse(NextResponse.json({ items: items.map(publicLink) }));
  } catch (error) { return walletError(error); }
}
