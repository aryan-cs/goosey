import Link from "next/link";
import { notFound } from "next/navigation";
import { db } from "@/lib/db";
import { getPublicEvent } from "@/lib/public-events";
import styles from "../events.module.css";

export const dynamic = "force-dynamic";

export default async function EventPage({ params }: { params: Promise<{ slug: string }> }) {
  const event = await getPublicEvent(db, (await params).slug);
  if (!event) notFound();
  const date = (value: Date) => value.toLocaleString("en-CA", { timeZone: "America/Toronto", month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short" });
  return <div className={`page-shell ${styles.page}`}>
    <nav aria-label="Breadcrumb"><Link href="/events">Events</Link><span aria-hidden="true"> / </span><span>{event.category}</span></nav>
    <header><p className={styles.eyebrow}>{event.category}</p><h1>{event.title}</h1><p>{event.description}</p><p className={styles.meta}><time dateTime={event.startsAt.toISOString()}>{date(event.startsAt)}</time> – <time dateTime={event.endsAt.toISOString()}>{date(event.endsAt)}</time></p></header>
    <aside className={styles.notice}>These markets are independent contracts. Their YES probabilities do not have to add up to 100%. Read each market’s rules before trading.</aside>
    <section aria-label="Event markets" className={styles.markets}>
      <div className={styles.sectionTitle}><h2>{event.markets.length} markets</h2><span>YES probability</span></div>
      {event.markets.map((market) => <Link className={styles.market} href={`/markets/${market.slug}`} key={market.id}>
        <div><h3>{market.shortTitle || market.title}</h3><p>{market.status === "RESOLVED" ? `Resolved ${market.resolution}` : market.status === "OPEN" && market.acceptingOrders && market.closesAt > new Date() ? "Trading open" : "Trading closed"} · {market.traderCount} traders</p></div>
        <div className={styles.forecast}><strong>{market.status === "VOID" || market.resolution === "VOID" ? "Voided" : market.probabilityYesBps === null ? "No price yet" : `${Math.round(market.probabilityYesBps / 100)}%`}</strong><small>{market.probabilityYesBps === null ? "Awaiting a market price" : market.probabilitySource === "SETTLEMENT" ? "Final outcome" : market.probabilityStale ? "Last price · stale" : "Market-implied"}</small></div>
      </Link>)}
    </section>
  </div>;
}
