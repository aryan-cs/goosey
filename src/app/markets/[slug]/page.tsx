import { TradeActivityDetails } from "@/components/trade-activity-details";
import Link from "next/link";
import { z } from "zod";
import { FeatherIcon } from "@/components/brand";
import { MarketStatusLabel } from "@/components/market-status";
import { notFound } from "next/navigation";
import { Bookmark, CalendarClock, ChevronRight, Share2 } from "lucide-react";
import { db } from "@/lib/db";
import { formatFeathers, marketProbabilityBps } from "@/lib/view-models";
import { ProbabilityChart } from "@/components/market";
import { MarketTradeLink, MarketTradingPanel } from "@/components/market-trading-panel";
import { CommentSection } from "@/components/comments";
import { WatchlistButton } from "@/components/watchlist-button";
import { ShareButton } from "@/components/share-button";
import { getServerUser } from "@/lib/server-session";
import { OrderBookPanel } from "@/components/order-book-panel";

export const dynamic = "force-dynamic";

export default async function MarketPage({ params, searchParams }: { params: Promise<{ slug: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { slug } = await params;
  const query = await searchParams;
  const focusedComment = query.comment === undefined ? null : z.string().max(128).cuid().safeParse(query.comment);
  const focusedCommentId = focusedComment?.success ? focusedComment.data : undefined;
  const initialOutcome = query.outcome === "NO" ? "NO" : "YES";
  const user = await getServerUser();
  const market = await db.market.findUnique({
    where: { slug },
    include: {
      priceHistory: { orderBy: { createdAt: "desc" }, take: 500 },
      trades: { orderBy: { createdAt: "desc" }, take: 15, include: { user: { select: { username: true, profilePublic: true } } } },
    },
  });
  if (!market || (market.status === "DRAFT" && user?.role !== "ADMIN")) notFound();
  const yesBps = marketProbabilityBps(market);
  const open = market.status === "OPEN" && market.closesAt > new Date();
  const orderBookMarket = market.pricingModel === "ORDER_BOOK";
  const points = [...market.priceHistory].reverse().map((point) => ({ timestamp: point.createdAt, probability: point.yesProbabilityBps / 10_000 }));

  return <div className="page-shell market-detail-page">
    <nav className="breadcrumbs" aria-label="Breadcrumb"><Link href="/markets">Markets</Link><ChevronRight /><Link href={`/markets?category=${encodeURIComponent(market.category)}`}>{market.category}</Link></nav>
    <div className="market-detail-layout">
      <article className="market-detail-main">
        <header className="market-detail-header">
          <div><span className="eyebrow">{market.category}</span><h1>{market.title}</h1><div className="market-meta"><MarketStatusLabel status={open ? "open" : market.status === "OPEN" ? "closed" : market.status} /><span><CalendarClock /> Closes {market.closesAt.toLocaleString("en-CA", { dateStyle: "medium", timeStyle: "short" })}</span><span><FeatherIcon /> {formatFeathers(market.volumeMilli)} volume</span></div></div>
          <div className="market-header-actions"><WatchlistButton marketId={market.id} signedIn={Boolean(user)} icon={<Bookmark />} /><ShareButton title={market.title} icon={<Share2 />} /></div>
        </header>

        <ProbabilityChart points={points} marketSlug={market.slug} label="YES probability" height={330} />
        <section className="chance-panel" aria-labelledby="chance-heading"><div className="section-heading"><div><span className="eyebrow">YES or NO</span><h2 id="chance-heading">Current forecast</h2></div></div><div className="chance-row"><span>YES</span><strong>{(yesBps / 100).toFixed(0)}%</strong>{orderBookMarket ? <a className="yes-pill" href="#order-book">Trade YES</a> : <MarketTradeLink className="yes-pill" outcome="YES" probability={Math.round(yesBps / 100)} />}<span className="muted-copy">Pays 100 feathers</span></div><div className="chance-row"><span>NO</span><strong>{((10_000 - yesBps) / 100).toFixed(0)}%</strong>{orderBookMarket ? <a className="no-pill" href="#order-book">Trade NO</a> : <MarketTradeLink className="no-pill" outcome="NO" probability={Math.round((10_000 - yesBps) / 100)} />}<span className="muted-copy">Pays 100 feathers</span></div></section>

        <section className="market-copy"><span className="eyebrow">About this market</span><h2>What to know</h2><p>{market.description}</p></section>
        <section className="rules-panel" aria-labelledby="rules-heading"><div className="section-heading"><div><span className="eyebrow">How it is decided</span><h2 id="rules-heading">Market rules</h2></div></div><p>{market.rules}</p><div className="resolution-source"><strong>Source</strong><span>{market.resolutionSource}</span></div><dl><div><dt>Trading closes</dt><dd>{market.closesAt.toLocaleString("en-CA", { dateStyle: "long", timeStyle: "short" })}</dd></div><div><dt>Expected result</dt><dd>{market.resolvesAt.toLocaleString("en-CA", { dateStyle: "long", timeStyle: "short" })}</dd></div><div><dt>Winner pays</dt><dd>100 feathers</dd></div></dl></section>

        <section className="activity-panel" aria-labelledby="activity-heading"><div className="section-heading"><h2 id="activity-heading">Recent activity</h2></div>{market.trades.length ? <ul className="trade-feed">{market.trades.map((trade) => <li key={trade.id}><span className={`activity-dot ${trade.side.toLowerCase()}`} /><span><strong>{trade.user.profilePublic ? `@${trade.user.username}` : "Someone"}</strong> <TradeActivityDetails trade={trade} /></span><time>{trade.createdAt.toLocaleString("en-CA", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}</time></li>)}</ul> : <p className="muted-copy">No trades yet. Be the first.</p>}</section>
        <CommentSection marketSlug={market.slug} focusedCommentId={focusedCommentId} marketId={market.id} currentUserId={user?.id} endpoint={`/api/markets/${market.slug}/comments`} />
      </article>
      {orderBookMarket
        ? <OrderBookPanel marketSlug={market.slug} marketTitle={market.shortTitle} payoutMilli={market.payoutMilli.toString()} signedIn={Boolean(user)} disabled={!open} />
        : <MarketTradingPanel key={initialOutcome} marketId={market.slug} marketTitle={market.shortTitle} yesProbability={yesBps / 10_000} balanceMilli={user?.balanceMilli.toString()} signedIn={Boolean(user)} initialOutcome={initialOutcome} disabled={!open} quoteEndpoint={`/api/markets/${market.slug}/quote`} tradeEndpoint={`/api/markets/${market.slug}/trades`} />}
    </div>
  </div>;
}
