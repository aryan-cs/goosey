import Link from "next/link";
import { redirect } from "next/navigation";
import { LivePageRefresh } from "@/components/live-page-refresh";
import { MarketListRow } from "@/components/market";
import { EmptyState } from "@/components/states";
import { db } from "@/lib/db";
import { DATABASE_MARKET_FILTER } from "@/lib/market-backend";
import { getServerUser } from "@/lib/server-session";
import { marketSummary } from "@/lib/view-models";
import { requiresEmailVerification } from "@/lib/auth";
import { loadMarketMarks } from "@/lib/market-marks";
import { runSerializableTransaction } from "@/lib/serializable-transaction";

export const dynamic = "force-dynamic";

export default async function WatchlistPage() {
  const user = await getServerUser();
  if (!user) return <div className="page-shell centered-state"><EmptyState title="Sign in to view saved markets" description="Your watchlist is only visible to you." action={<Link className="button button-primary" href="/login?next=%2Fwatchlist">Sign in</Link>} /></div>;
  if (requiresEmailVerification(user)) redirect("/verify-email?next=%2Fwatchlist");
  const { entries, marks } = await runSerializableTransaction(db, async (tx) => {
    const entries = await tx.watchlistEntry.findMany({ where: { userId: user.id, market: { ...DATABASE_MARKET_FILTER, ...(user.role === "ADMIN" ? {} : { status: { not: "DRAFT" } }) } }, orderBy: { createdAt: "desc" }, include: { market: { include: { priceHistory: { orderBy: { createdAt: "desc" }, take: 30 }, orderFills: { orderBy: { tradeSequence: "desc" }, take: 30, select: { canonicalYesPriceMilli: true, createdAt: true } } } } } });
    return { entries, marks: await loadMarketMarks(tx, entries.map((entry) => entry.market)) };
  });
  return <div className="page-shell"><LivePageRefresh showButton={false} /><header className="page-header"><span className="eyebrow">Saved markets</span><h1>Watchlist</h1></header>{entries.length ? <div className="market-list browse-list">{entries.map(({ market }) => <MarketListRow key={market.id} market={marketSummary({ ...market, priceHistory: [...market.priceHistory].reverse() }, marks.get(market.id)!.probabilityYesBps)} />)}</div> : <EmptyState title="Your watchlist is empty" description="Tap the bookmark on a market to save it here." action={<Link className="button button-primary" href="/markets">Browse markets</Link>} />}</div>;
}
