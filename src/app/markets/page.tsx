import Link from "next/link";
import styles from "./markets.module.css";
import { Filter, Search } from "lucide-react";
import { db } from "@/lib/db";
import { marketSummary } from "@/lib/view-models";
import { MarketListRow } from "@/components/market";
import { EmptyState } from "@/components/states";
import { MARKET_CATEGORIES } from "@/lib/market-categories";
import { loadMarketMarks } from "@/lib/market-marks";
import { runSerializableTransaction } from "@/lib/serializable-transaction";

export const dynamic = "force-dynamic";

export default async function MarketsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const params = await searchParams;
  const query = typeof params.q === "string" ? params.q.trim() : "";
  const category = typeof params.category === "string" && params.category !== "Trending" ? params.category : undefined;
  const sort = typeof params.sort === "string" ? params.sort : "trending";
  const markets = await runSerializableTransaction(db, async (tx) => {
    const rows = await tx.market.findMany({
    where: {
      ...(category ? { category } : {}),
      ...(query ? { OR: [{ title: { contains: query } }, { description: { contains: query } }] } : {}),
      status: "OPEN",
      closesAt: { gt: new Date() },
    },
    include: { priceHistory: { orderBy: { createdAt: "desc" }, take: 30 }, orderFills: { orderBy: { tradeSequence: "desc" }, take: 30, select: { canonicalYesPriceMilli: true, createdAt: true } } },
    orderBy: sort === "new" ? { createdAt: "desc" } : sort === "closing" ? { closesAt: "asc" } : { volumeMilli: "desc" },
    take: 100,
    });
    const marks = await loadMarketMarks(tx, rows);
    return rows.map((market) => ({ ...market, mark: marks.get(market.id)! }));
  });

  return <div className="page-shell browse-page">
    <header className={styles.header}><h1>Markets</h1><p>Hack the North + Waterloo. Pick a question and choose your side.</p><Link className={`button button-secondary ${styles.suggest}`} href="/markets/suggest">Suggest a market</Link></header>
    <p><Link href="/events">Browse grouped events →</Link></p>
    <div className="browse-layout">
      <form className="market-filters" action="/markets">
        <label className="search-field"><Search /><span className="sr-only">Search markets</span><input type="search" name="q" defaultValue={query} placeholder="Search questions and topics" /></label>
        <label><span className="sr-only">Category</span><select name="category" defaultValue={category ?? ""}><option value="">All categories</option>{MARKET_CATEGORIES.filter((item) => item !== "Trending").map((item) => <option value={item} key={item}>{item}</option>)}</select></label>
        <label><Filter /><span className="sr-only">Sort markets</span><select name="sort" defaultValue={sort}><option value="trending">Trending</option><option value="new">Newest</option><option value="closing">Closing soon</option></select></label>
        <button className="button button-primary">Show markets</button>
      </form>
      <section className="browse-results" aria-label="Market results">
        <div className="results-heading"><strong>{markets.length} market{markets.length === 1 ? "" : "s"}</strong>{category && <span className="filter-chip">{category}</span>}</div>
        {markets.length ? <div className="market-list browse-list">{markets.map((market) => <MarketListRow market={marketSummary({ ...market, priceHistory: [...market.priceHistory].reverse() }, market.mark.probabilityYesBps)} key={market.id} />)}</div> : <EmptyState title="No markets found" description="Try a broader search or another category." />}
      </section>
    </div>
  </div>;
}
