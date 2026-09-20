import { INDEPENDENT_DANCE_GROUP, INDEPENDENT_DANCE_MARKETS } from "@/lib/september-market-additions";
import { DanceMarketPanel } from "@/components/dance-market-panel";
import { LivePageRefresh } from "@/components/live-page-refresh";
import { DANCE_MARKET_GROUP, DANCE_MARKET_OUTCOMES } from "@/lib/dance-market";
import { getServerUser } from "@/lib/server-session";
import Link from "next/link";
import { notFound } from "next/navigation";
import { db } from "@/lib/db";
import { getPublicEvent } from "@/lib/public-events";
import styles from "../events.module.css";
import { probabilityBpsToWholePercent } from "@/lib/probability-format";
import { LocalTime } from "@/components/local-time";

export const dynamic = "force-dynamic";

export default async function EventPage({ params, searchParams }: { params: Promise<{ slug: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const event = await getPublicEvent(db, (await params).slug);
  if (!event) notFound();
  if (event.slug === DANCE_MARKET_GROUP.slug || event.slug === INDEPENDENT_DANCE_GROUP.slug) {
    const independent = event.slug === INDEPENDENT_DANCE_GROUP.slug;
    const definitions = independent ? INDEPENDENT_DANCE_MARKETS : DANCE_MARKET_OUTCOMES;
    const [user, query] = await Promise.all([getServerUser(), searchParams]);
    const options = definitions.flatMap(option => {
      const market = event.markets.find(market => market.slug === option.slug);
      if (!market) return [];
      return [{ ...market, acceptingOrders: market.acceptingOrders && market.closesAt > new Date() && event.markets.length === definitions.length && market.pricingModel === "LMSR", label: option.label, rules: option.rules, closesAt: market.closesAt.toISOString(), payoutMilli: market.payoutMilli.toString(), volumeMilli: market.volumeMilli.toString() }];
    });
    return <div className="page-shell"><nav aria-label="Breadcrumb"><Link href="/markets">Markets</Link> / <Link href="/events">Events</Link></nav>
      {!independent && <p role="note">These original first-dance contracts keep their rules and positions. <Link href={`/events/${INDEPENDENT_DANCE_GROUP.slug}`}>Trade each dance independently</Link>.</p>}
      <DanceMarketPanel independent={independent} title={event.title} markets={options} signedIn={Boolean(user)} balanceMilli={user?.balanceMilli.toString()} initialSlug={typeof query.option === "string" ? query.option : undefined} initialAction={query.action === "SELL" ? "SELL" : "BUY"} />
    </div>;
  }
  return <div className={`page-shell ${styles.page}`}><LivePageRefresh showButton={false} />
    <nav aria-label="Breadcrumb"><Link href="/events">Events</Link><span aria-hidden="true"> / </span><span>{event.category}</span></nav>
    <header><p className={styles.eyebrow}>{event.category}</p><h1>{event.title}</h1><p>{event.description}</p><p className={styles.meta}><LocalTime value={event.startsAt} preset="medium" /> – <LocalTime value={event.endsAt} preset="medium" /></p></header>
    <aside className={styles.notice}>These markets are independent contracts. Their YES probabilities do not have to add up to 100%. Read each market’s rules before trading.</aside>
    <section aria-label="Event markets" className={styles.markets}>
      <div className={styles.sectionTitle}><h2>{event.markets.length} markets</h2><span>YES probability</span></div>
      {event.markets.map((market) => <Link className={styles.market} href={`/markets/${market.slug}`} key={market.id}>
        <div><h3>{market.shortTitle || market.title}</h3><p>{market.status === "RESOLVED" ? `Resolved ${market.resolution}` : market.status === "OPEN" && market.acceptingOrders && market.closesAt > new Date() ? "Trading open" : "Trading closed"} · {market.traderCount} traders</p></div>
        <div className={styles.forecast}><strong>{market.status === "VOID" || market.resolution === "VOID" ? "Voided" : market.probabilityYesBps === null ? "No price yet" : `${probabilityBpsToWholePercent(market.probabilityYesBps)}%`}</strong><small>{market.probabilityYesBps === null ? "Awaiting a market price" : market.probabilitySource === "SETTLEMENT" ? "Final outcome" : market.probabilityStale ? "Last price · stale" : "Market-implied"}</small></div>
      </Link>)}
    </section>
  </div>;
}
