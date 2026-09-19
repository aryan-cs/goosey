import { address, createSolanaRpc } from "@solana/kit";
import { NextRequest, NextResponse } from "next/server";
import { enforceRateLimit, RateLimitError, requestRateLimitKey } from "@/lib/security";
import { jsonSafe } from "@/lib/serializers";
import { readGooseyEscrow } from "@/lib/solana/escrow-read";
import { resolveSolanaRuntime } from "@/lib/solana/runtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const headers = { "Cache-Control": "private, no-store, max-age=0" };
const failure = (status: number, code: string, message: string) =>
  NextResponse.json({ error: { code, message } }, { status, headers });

/** Public chain data only. Wallet selection is not proof of ownership or an
 * authorization to trade. There is deliberately no database-market fallback.
 * All quantities are decimal strings; the manifest itself needs separate digest
 * verification before a user signs an order. No ready-to-trade claim is made.
 */
export async function GET(request: NextRequest, context: { params: Promise<{ marketId: string }> }) {
  let marketId: bigint, wallet: ReturnType<typeof address>;
  try {
    const raw = (await context.params).marketId;
    const query = request.nextUrl.searchParams;
    if (!/^(0|[1-9][0-9]{0,19})$/.test(raw) || BigInt(raw) > (1n << 64n) - 1n
      || [...query.keys()].some(key => key !== "wallet") || query.getAll("wallet").length !== 1) throw new Error();
    marketId = BigInt(raw);
    const selected = query.get("wallet")!;
    if (selected.length < 32 || selected.length > 44 || selected === "11111111111111111111111111111111") throw new Error();
    wallet = address(selected);
  } catch { return failure(400, "INVALID_REQUEST", "Specify a canonical market ID and one wallet address."); }
  if (!process.env.GOOSEY_SOLANA_CLUSTER) return failure(503, "SOLANA_DISABLED", "Chain markets are disabled.");
  try {
    await enforceRateLimit(requestRateLimitKey(request, "solana:market:read"), 60, 60_000);
    const deployment = resolveSolanaRuntime();
    const signal = AbortSignal.any([request.signal, AbortSignal.timeout(10_000)]);
    const rpc = createSolanaRpc(deployment.rpcUrl);
    const snapshot = await readGooseyEscrow(deployment, { marketId, wallet }, { rpc, signal, includeMarketTerms: true });
    // Close the network identity check around the full financial snapshot.
    if (await rpc.getGenesisHash().send({ abortSignal: signal }) !== deployment.genesisHash) throw new Error();
    const terms = snapshot.marketTerms;
    if (!terms || !snapshot.orderBook || !snapshot.resolution) throw new Error();
    return NextResponse.json(jsonSafe({
      version: 1, source: "solana", commitment: "finalized", cluster: deployment.cluster,
      genesisHash: deployment.genesisHash, programAddress: deployment.programAddress,
      marketId, marketAddress: snapshot.market, finalizedSlot: snapshot.finalizedSlot,
      checkedAt: new Date().toISOString(), exchangeVerified: false, manifestVerified: false,
      market: snapshot.marketState, resolution: snapshot.resolution,
      book: { address: snapshot.orderBook.book, revision: snapshot.orderBook.revision,
        bids: snapshot.orderBook.bids, asks: snapshot.orderBook.asks, reservesReconciled: true },
      terms: { address: terms.address, version: terms.version, digestHex: Buffer.from(terms.digest).toString("hex"),
        manifestLength: terms.manifestLength, sealed: terms.sealed, acceptanceBits: terms.acceptanceBits,
        proposer: terms.proposer, approver: terms.approver },
      wallet: { address: wallet, registered: snapshot.registered, seat: snapshot.seat,
        tokenAmount: snapshot.walletTokenAmount },
      vault: { amount: snapshot.vaultAmount, surplus: snapshot.vaultSurplus },
    }), { headers });
  } catch (error) {
    if (error instanceof RateLimitError) {
      const response = failure(429, "RATE_LIMITED", "Too many chain-market reads.");
      response.headers.set("Retry-After", String(error.retryAfterSeconds));
      return response;
    }
    return failure(503, "CHAIN_SNAPSHOT_UNAVAILABLE", "A complete finalized chain-market snapshot could not be verified.");
  }
}
