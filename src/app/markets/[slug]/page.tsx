import { MarketActivityRefresh } from "@/components/market-activity-refresh";
import { TradeActivityDetails } from "@/components/trade-activity-details";
import Link from "next/link";
import styles from "./market-detail.module.css";
import { MobileOrderEntry } from "@/components/mobile-order-entry";
import { z } from "zod";
import { FeatherIcon } from "@/components/brand";
import { MarketStatusLabel } from "@/components/market-status";
import { notFound } from "next/navigation";
import { Bookmark, CalendarClock, ChevronRight, Share2 } from "lucide-react";
import { db } from "@/lib/db";
import { formatFeathers } from "@/lib/view-models";
import { loadMarketMarks } from "@/lib/market-marks";
import { runSerializableTransaction } from "@/lib/serializable-transaction";
import { impliedProbabilityBps } from "@/lib/order-book-pricing";
import { ProbabilityChart } from "@/components/market";
import { MarketTradingPanel } from "@/components/market-trading-panel";
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
  const initialAction = query.action === "SELL" ? "SELL" : "BUY";
  const user = await getServerUser();
  const data = await runSerializableTransaction(db, async (tx) => {
    const market = await tx.market.findUnique({
    where: { slug },
    include: {
      priceHistory: { orderBy: { createdAt: "desc" }, take: 500 },
      orderFills: { orderBy: { tradeSequence: "desc" }, take: 500, select: { id: true, canonicalYesPriceMilli: true, quantity: true, createdAt: true } },
      trades: { orderBy: { createdAt: "desc" }, take: 15, include: { user: { select: { id: true, username: true, profilePublic: true } } } },
    },
    });
    if (!market || (market.status === "DRAFT" && user?.role !== "ADMIN")) return null;
    const [firstTrade, firstSnapshot] = market.pricingModel === "ORDER_BOOK" ? [null, null] : await Promise.all([
      tx.trade.findFirst({ where: { marketId: market.id }, orderBy: [{ createdAt: "asc" }, { id: "asc" }], select: { createdAt: true, priceBeforeBps: true } }),
      tx.marketPriceSnapshot.findFirst({ where: { marketId: market.id }, orderBy: [{ createdAt: "asc" }, { id: "asc" }], select: { createdAt: true, yesProbabilityBps: true } }),
    ]);
    return { market, firstTrade, firstSnapshot, mark: (await loadMarketMarks(tx, [market])).get(market.id)! };
  });
  if (!data) notFound();
  const { market, mark } = data;
  const yesBps = mark.probabilityYesBps;
  const openingBps = data.firstTrade?.priceBeforeBps ?? data.firstSnapshot?.yesProbabilityBps ?? yesBps;
  const open = market.status === "OPEN" && market.acceptingOrders && market.closesAt > new Date();
  const orderBookMarket = market.pricingModel === "ORDER_BOOK";
  const points = orderBookMarket
    ? [...market.orderFills].reverse().map((fill) => ({ timestamp: fill.createdAt, probability: Number(impliedProbabilityBps(fill.canonicalYesPriceMilli, market.payoutMilli)) / 10_000 }))
    : [...market.priceHistory].reverse().map((point) => ({ timestamp: point.createdAt, probability: point.yesProbabilityBps / 10_000 }));

  return <div className={`page-shell market-detail-page ${styles.page}`}>
    <nav className="breadcrumbs" aria-label="Breadcrumb"><Link href="/markets">Markets</Link><ChevronRight /><Link href={`/markets?category=${encodeURIComponent(market.category)}`}>{market.category}</Link></nav>
    <div className="market-detail-layout">
      <article className="market-detail-main">
        <header className="market-detail-header">
          <div><span className="eyebrow">{market.category}</span><h1>{market.title}</h1><div className="market-meta"><MarketStatusLabel status={open ? "open" : market.status === "OPEN" ? "closed" : market.status} /><span><CalendarClock /> Closes {market.closesAt.toLocaleString("en-CA", { dateStyle: "medium", timeStyle: "short" })}</span><span><FeatherIcon /> {formatFeathers(market.volumeMilli)} volume</span></div></div>
          <div className="market-header-actions"><WatchlistButton marketId={market.id} signedIn={Boolean(user)} icon={<Bookmark />} /><ShareButton title={market.title} icon={<Share2 />} /></div>
        </header>

        <ProbabilityChart openingBaseline={orderBookMarket || openingBps === null ? undefined : {
          probability: openingBps / 10_000,
          until: (data.firstTrade?.createdAt ?? new Date()).getTime(),
        }} points={points} marketSlug={market.slug} label={orderBookMarket ? "YES execution price" : "YES probability"} executionPrices={orderBookMarket} height={260} />

      </article>
      {orderBookMarket
        ? <OrderBookPanel key={`${market.slug}-${initialOutcome}-${initialAction}`} marketSlug={market.slug} marketTitle={market.shortTitle} payoutMilli={market.payoutMilli.toString()} feeBps={market.feeBps} signedIn={Boolean(user)} disabled={!open} initialOutcome={initialOutcome} initialAction={initialAction} />
        : yesBps !== null && <MarketTradingPanel key={initialOutcome} marketId={market.slug} marketTitle={market.shortTitle} yesProbability={yesBps / 10_000} balanceMilli={user?.balanceMilli.toString()} signedIn={Boolean(user)} initialOutcome={initialOutcome} disabled={!open} quoteEndpoint={`/api/markets/${market.slug}/quote`} tradeEndpoint={`/api/markets/${market.slug}/trades`} />}
      <div className={styles.details}>
        <section className="market-copy"><span className="eyebrow">About this market</span><h2>What to know</h2><p>{market.description}</p></section>
        <section className="rules-panel" aria-labelledby="rules-heading"><div className="section-heading"><div><span className="eyebrow">How it is decided</span><h2 id="rules-heading">Market rules</h2></div></div><p>{market.rules}</p><div className="resolution-source"><strong>Source</strong><span>{market.resolutionSource}</span></div><dl><div><dt>Trading closes</dt><dd>{market.closesAt.toLocaleString("en-CA", { dateStyle: "long", timeStyle: "short" })}</dd></div><div><dt>Expected result</dt><dd>{market.resolvesAt.toLocaleString("en-CA", { dateStyle: "long", timeStyle: "short" })}</dd></div><div><dt>Winner pays</dt><dd>{formatFeathers(market.payoutMilli)} feathers</dd></div></dl></section>

        <section className="activity-panel" aria-labelledby="activity-heading"><MarketActivityRefresh /><div className="section-heading"><h2 id="activity-heading">Recent activity</h2></div>{orderBookMarket ? market.orderFills.length ? <ul className="trade-feed">{market.orderFills.slice(0, 15).map((fill) => <li key={fill.id}><span className="activity-dot yes" /><span>{fill.quantity} contract{fill.quantity === 1 ? "" : "s"} matched at YES {formatFeathers(fill.canonicalYesPriceMilli, 3)} feathers</span><time dateTime={fill.createdAt.toISOString()}>{fill.createdAt.toLocaleString("en-CA", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}</time></li>)}</ul> : <p className="muted-copy">No executions yet.</p> : market.trades.length ? <ul className="trade-feed" tabIndex={0} aria-label="Recent trades">{market.trades.map((trade) => <li key={trade.id}><span className={`activity-dot ${trade.side.toLowerCase()}`} /><span><strong title={trade.user.profilePublic || trade.user.id === user?.id ? `@${trade.user.username}` : "This trader keeps their profile private"}>{trade.user.profilePublic ? <Link href={`/users/${trade.user.username}`}>@{trade.user.username}</Link> : trade.user.id === user?.id ? `@${trade.user.username} (you)` : "Private trader"}</strong> <TradeActivityDetails trade={trade} /></span><time dateTime={trade.createdAt.toISOString()}>{trade.createdAt.toLocaleString("en-CA", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}</time></li>)}</ul> : <p className="muted-copy">No trades yet.</p>}</section>
        {focusedComment && !focusedComment.success
          ? <section className="comments-section" aria-labelledby="discussion-heading"><h2 id="discussion-heading">Linked discussion unavailable</h2><p>This comment link is invalid.</p><Link href={`/markets/${encodeURIComponent(market.slug)}#discussion-heading`}>View all discussion</Link></section>
          : <CommentSection marketId={market.id} marketSlug={market.slug} focusedCommentId={focusedCommentId} currentUserId={user?.id} endpoint={`/api/markets/${market.slug}/comments`} />}
      </div>
    </div>
    {orderBookMarket && open && <MobileOrderEntry key={`${market.slug}-${initialOutcome}-${initialAction}`} marketSlug={market.slug} className={styles.mobileTrade} />}
  </div>;
}
