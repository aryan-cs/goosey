import Link from "next/link";
import { MarketCanvasToolbar } from "@/components/market-canvas-toolbar";
import { ArrowRight, Radio, Sparkles, Trophy, Users } from "lucide-react";
import { FeatherIcon, GooseMark } from "@/components/brand";
import { db } from "@/lib/db";
import { marketSummary, formatFeathers } from "@/lib/view-models";
import { MarketCard, MarketListRow } from "@/components/market";
import { EmptyState } from "@/components/states";
import { getLeaderboardRows } from "@/lib/leaderboard";

export const dynamic = "force-dynamic";

export default async function HomePage() {
  const [markets, leaders, recentTrades] = await Promise.all([
    db.market.findMany({
      where: { status: "OPEN", closesAt: { gt: new Date() } },
      include: { priceHistory: { orderBy: { createdAt: "desc" }, take: 24 } },
      orderBy: [{ featured: "desc" }, { volumeMilli: "desc" }, { closesAt: "asc" }],
      take: 12,
    }),
    getLeaderboardRows(5),
    db.trade.findMany({
      include: { user: { select: { username: true, profilePublic: true } }, market: { select: { slug: true, shortTitle: true } } },
      orderBy: { createdAt: "desc" },
      take: 6,
    }),
  ]);
  const summaries = markets.map((market) => marketSummary({ ...market, priceHistory: [...market.priceHistory].reverse() }));
  const featured = summaries.slice(0, 3);
  const rest = summaries.slice(3);

  return (
    <div className="page-shell home-page">
      <section className="hero-intro">
        <div className="hero-mark" aria-hidden="true"><GooseMark /></div>
        <div className="hero-copy">
          <span className="eyebrow">Hack the North predictions</span>
          <h1>Make your call. Win some feathers.</h1>
          <p><span className="hero-description-desktop">Pick a side on demos, workshops, campus moments, and whatever happens at Hack the North. It is all play money.</span><span className="hero-description-mobile">Pick a side on Hack the North moments. It is all play money.</span></p>
          <div className="hero-actions">
            <Link className="button button-primary" href="/markets">Trade now <ArrowRight /></Link>
            <Link className="button button-secondary" href="/rules">How it works</Link>
          </div>
        </div>
        <aside className="field-note">
          <Sparkles />
          <div><strong>Start with 10,000 feathers</strong><p>Create an account, make some predictions, and move up the leaderboard.</p></div>
        </aside>
      </section>

      <section className="market-canvas" aria-label="Live prediction markets">
        <MarketCanvasToolbar />
        <div className="home-layout">
          <div className="home-main">
            <section aria-labelledby="featured-heading">
              <div className="section-heading"><div><span className="eyebrow eyebrow-with-icon"><Radio /> Live now</span><h2 id="featured-heading">Featured markets</h2></div></div>
              {featured.length ? <div className="featured-grid">{featured.map((market, index) => <MarketCard market={market} priority={index === 0} key={market.id} />)}</div> : <EmptyState title="No markets are live yet" description="Check back soon." />}
            </section>

            <aside className="home-sidebar">
              <section className="sidebar-panel" aria-labelledby="leader-preview">
                <div className="section-heading compact"><h2 id="leader-preview"><Trophy /> Leaderboard</h2><Link href="/leaderboard">All</Link></div>
                {leaders.length ? <ol className="mini-leaderboard">{leaders.map((leader) => <li key={leader.userId}><span className="rank">{leader.rank}</span><span><strong>{leader.displayName}</strong><small>@{leader.username}</small></span><b><FeatherIcon /> {formatFeathers(leader.pnlMilli)}</b></li>)}</ol> : <EmptyState title="No rankings yet" description="Rankings start after the first trade." />}
              </section>
              <section className="sidebar-panel" aria-labelledby="activity-preview">
                <div className="section-heading compact"><h2 id="activity-preview"><Users /> Live activity</h2></div>
                {recentTrades.length ? <ul className="activity-list">{recentTrades.map((trade) => <li key={trade.id}><span className={`activity-dot ${trade.side.toLowerCase()}`} /><p><strong>{trade.user.profilePublic ? `@${trade.user.username}` : "Someone"}</strong> {trade.action.toLowerCase()} {trade.quantity} {trade.side} on <Link href={`/markets/${trade.market.slug}`}>{trade.market.shortTitle}</Link></p></li>)}</ul> : <p className="muted-copy">New trades will show up here.</p>}
              </section>
            </aside>

            <section aria-labelledby="all-markets-heading">
              <div className="section-heading"><div><span className="eyebrow">Across campus</span><h2 id="all-markets-heading">More to predict</h2></div><Link href="/markets">Browse all</Link></div>
              <div className="market-grid">{rest.map((market) => <MarketCard market={market} key={market.id} />)}</div>
            </section>
          </div>
        </div>

        {summaries.length > 0 && <section className="dense-market-section" aria-labelledby="closing-heading"><div className="section-heading"><h2 id="closing-heading">Closing soon</h2></div><div className="market-list">{markets.slice().sort((a, b) => a.closesAt.getTime() - b.closesAt.getTime()).slice(0, 5).map((market) => <MarketListRow market={marketSummary({ ...market, priceHistory: [...market.priceHistory].reverse() })} key={market.id} />)}</div></section>}
      </section>
    </div>
  );
}
