import { NextResponse } from "next/server";
import { readGooseyConfiguration } from "@/lib/solana/configuration";
import { resolveSolanaRuntime } from "@/lib/solana/runtime";

export const dynamic = "force-dynamic";
const headers = { "Cache-Control": "no-store" };

/** Read-only public deployment information. Never return the private RPC URL,
 * provider error text, enrollment identities, or a false trading-ready badge.
 * RPC configuration comes only from the server environment, never query input.
 */
export async function GET() {
  if (!process.env.GOOSEY_SOLANA_CLUSTER) {
    return NextResponse.json({ status: "disabled", financialBackend: "database", exchangeVerified: false }, { headers });
  }
  try {
    const runtime = resolveSolanaRuntime();
    const config = await readGooseyConfiguration(runtime);
    return NextResponse.json({
      status: "foundation_verified",
      financialBackend: "database",
      exchangeVerified: false,
      cluster: runtime.cluster,
      genesisHash: runtime.genesisHash,
      programAddress: runtime.programAddress,
      configAddress: config.config,
      featherMint: config.featherMint,
      decimals: 3,
      finalizedSlot: config.finalizedSlot.toString(),
      checkedAt: new Date().toISOString(),
      // Exact decimal strings, never floating point display balances.
      supplyBaseUnits: config.supply.toString(),
      lifetimeMintedBaseUnits: config.totalMinted.toString(),
      lifetimeAuthorizedBaseUnits: config.totalAuthorized.toString(),
      campaignCapBaseUnits: config.campaignCap.toString(),
      currency: { name: "feathers", purchasable: false, cashRedeemable: false },
    }, { headers });
  } catch {
    return NextResponse.json({
      status: "unavailable", financialBackend: "database", exchangeVerified: false,
      error: "Solana deployment could not be verified. No transaction was submitted.",
    }, { status: 503, headers });
  }
}
