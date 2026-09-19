import Link from "next/link";
import { notFound } from "next/navigation";

import { ChainMarketReviewerKeeper } from "@/components/chain-market-reviewer-keeper";

export const metadata = { title: "On-chain market review · Goosey" };

export default async function ChainMarketReviewPage({ params }: { params: Promise<{ marketId: string }> }) {
  const { marketId } = await params;
  if (!/^(0|[1-9][0-9]{0,19})$/.test(marketId) || BigInt(marketId) >= 1n << 64n) notFound();
  return <div className="page-shell">
    <header className="page-header"><div><p className="eyebrow">Goosey on Solana</p><h1>Market review</h1></div>
      <Link className="section-link" href={`/chain/markets/${marketId}`}>Back to market</Link></header>
    <ChainMarketReviewerKeeper marketId={marketId} />
  </div>;
}
