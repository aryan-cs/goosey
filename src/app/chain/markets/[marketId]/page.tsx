import { notFound } from "next/navigation";
import Link from "next/link";
import { ChainMarket } from "@/components/chain-market";

export default async function ChainMarketPage({ params }: { params: Promise<{ marketId: string }> }) {
  const { marketId } = await params;
  if (!/^(0|[1-9][0-9]{0,19})$/.test(marketId) || BigInt(marketId) >= 1n << 64n) notFound();
  return <div className="page-shell"><ChainMarket key={marketId} marketId={marketId} />
    <p><Link className="section-link" href={`/chain/markets/${marketId}/review`}>Reviewer and keeper actions</Link></p>
  </div>;
}
