import Link from "next/link";
import { redirect } from "next/navigation";
import { MarketListRow } from "@/components/market";
import { EmptyState } from "@/components/states";
import { db } from "@/lib/db";
import { getServerUser } from "@/lib/server-session";
import { marketSummary } from "@/lib/view-models";
import { requiresEmailVerification } from "@/lib/auth";

export const dynamic = "force-dynamic";

export default async function WatchlistPage() {
  const user = await getServerUser();
  if (!user) return <div className="page-shell centered-state"><EmptyState title="Sign in to view saved markets" description="Your watchlist is only visible to you." action={<Link className="button button-primary" href="/login">Sign in</Link>} /></div>;
  if (requiresEmailVerification(user)) redirect("/verify-email?next=%2Fwatchlist");
  const entries = await db.watchlistEntry.findMany({ where: { userId: user.id, ...(user.role === "ADMIN" ? {} : { market: { status: { not: "DRAFT" } } }) }, orderBy: { createdAt: "desc" }, include: { market: { include: { priceHistory: { orderBy: { createdAt: "desc" }, take: 30 } } } } });
  return <div className="page-shell"><header className="page-header"><span className="eyebrow">Saved markets</span><h1>Watchlist</h1><p>Markets you saved, newest first.</p></header>{entries.length ? <div className="market-list browse-list">{entries.map(({ market }) => <MarketListRow key={market.id} market={marketSummary({ ...market, priceHistory: [...market.priceHistory].reverse() })} />)}</div> : <EmptyState title="Your watchlist is empty" description="Tap the bookmark on a market to save it here." action={<Link className="button button-primary" href="/markets">Browse markets</Link>} />}</div>;
}
