import Link from "next/link";
import { db } from "@/lib/db";
import { ApiError } from "@/lib/market-service";
import { listPublicEvents, parseEventListQuery } from "@/lib/public-events";
import styles from "./events.module.css";

export const dynamic = "force-dynamic";

export default async function EventsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const params = await searchParams;
  let query;
  try {
    // An empty category is the form's explicit “all categories” selection.
    query = parseEventListQuery({ ...params, category: params.category === "" ? undefined : params.category, limit: 12 });
    if (params.limit !== undefined) throw new ApiError(400, "INVALID_QUERY", "Page size cannot be changed.");
  } catch (error) {
    if (!(error instanceof ApiError)) throw error;
    return <div className={`page-shell ${styles.page}`}><h1>Invalid event filters</h1><p>Choose a timing and category, or start again from all events.</p><Link className="button button-secondary" href="/events">Reset filters</Link></div>;
  }
  const [result, categories] = await Promise.all([
    listPublicEvents(db, query),
    db.marketEvent.findMany({ where: { markets: { some: { status: { not: "DRAFT" } } } }, distinct: ["category"], select: { category: true }, orderBy: { category: "asc" } }),
  ]);
  const next = new URLSearchParams({ timing: query.timing });
  if (query.category) next.set("category", query.category);
  if (result.nextCursor) next.set("cursor", result.nextCursor);
  return <div className={`page-shell ${styles.page}`}>
    <header><p className={styles.eyebrow}>THE BIGGER PICTURE</p><h1>Events</h1><p>One weekend. Many outcomes. Explore the questions behind each Waterloo moment.</p></header>
    <form action="/events" className={styles.filters}>
      <label>Event timing<select name="timing" defaultValue={query.timing}><option value="all">All events</option><option value="live">Live</option><option value="upcoming">Upcoming</option><option value="past">Past</option></select></label>
      <label>Category<select name="category" defaultValue={query.category ?? ""}><option value="">All categories</option>{[...new Set([...categories.map((item) => item.category), ...(query.category ? [query.category] : [])])].sort().map((category) => <option key={category}>{category}</option>)}</select></label>
      <button className="button button-primary">Show events</button>
    </form>
    <section className={styles.grid} aria-label="Event results">{result.items.map((event) => <Link href={`/events/${event.slug}`} className={styles.card} key={event.id}>
      <span className={styles.eyebrow}>{event.category}</span><h2>{event.shortTitle || event.title}</h2><p>{event.description}</p><span className={styles.meta}>{event.markets.length} markets · {event.startsAt.toLocaleDateString("en-CA", { timeZone: "America/Toronto", month: "short", day: "numeric", year: "numeric" })}</span><strong>Explore event →</strong>
    </Link>)}</section>
    {!result.items.length && <section className={styles.notice}><h2>No events found</h2><p>Try another timing or category.</p><Link href="/events">See all events</Link></section>}
    <nav className={styles.pagination} aria-label="Event pages">{query.cursor && <Link href={`/events?${new URLSearchParams({ timing: query.timing, ...(query.category ? { category: query.category } : {}) })}`}>First page</Link>}{result.nextCursor && <Link className="button button-secondary" href={`/events?${next}`}>More events</Link>}</nav>
  </div>;
}
