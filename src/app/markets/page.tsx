import { formatDistanceStrict } from "date-fns";
import { Filter, Search } from "lucide-react";
import Link from "next/link";

import { MarketListRow, type MarketSummary } from "@/components/market";
import { EmptyState } from "@/components/states";
import { MARKET_CATEGORIES } from "@/lib/market-categories";
import { MARKET_SUGGESTION_FORM_URL } from "@/lib/market-suggestion";
import {
  unifiedMarketReadRepository,
  type UnifiedMarket,
  type UnifiedSolanaMarket,
} from "@/lib/unified-market-repository";

import styles from "./markets.module.css";

export const dynamic = "force-dynamic";

type BrowseSort = "trending" | "new" | "closing";

function closesAt(market: UnifiedMarket) {
  return market.executionBackend === "SOLANA"
    ? market.financial.closesAt
    : market.financial.market.closesAt;
}

function closeLabel(date: Date, now: Date) {
  return date > now
    ? `in ${formatDistanceStrict(date, now)}`
    : `${formatDistanceStrict(date, now)} ago`;
}

function compareIds(left: UnifiedMarket, right: UnifiedMarket) {
  return left.editorial.id.localeCompare(right.editorial.id);
}

/** Solana projections deliberately do not expose an all-time volume or a
 * timestamped price series. Keep those fields unavailable rather than deriving
 * them from a potentially incomplete recent trade window. */
export function solanaMarketSummary(market: UnifiedSolanaMarket, now = new Date()): MarketSummary {
  const yesBps = market.financial.probabilityYesBps;
  return {
    id: market.editorial.id,
    slug: market.editorial.slug,
    title: market.editorial.title,
    category: market.editorial.category,
    closesAt: closeLabel(market.financial.closesAt, now),
    status: market.financial.status.toLowerCase() as MarketSummary["status"],
    volume: "—",
    outcomes: [
      { id: "YES", label: "Yes", probability: yesBps === null ? null : yesBps / 10_000 },
      { id: "NO", label: "No", probability: yesBps === null ? null : (10_000 - yesBps) / 10_000 },
    ],
    sparkline: [],
  };
}

export function sortBrowseMarkets(markets: readonly UnifiedMarket[], sort: BrowseSort) {
  return [...markets].sort((left, right) => {
    if (sort === "new") {
      return right.editorial.createdAt.getTime() - left.editorial.createdAt.getTime() || compareIds(left, right);
    }
    if (sort === "closing") {
      return closesAt(left).getTime() - closesAt(right).getTime() || compareIds(left, right);
    }

    // The finalized Solana projection has no all-time-volume field. Preserve
    // the established database volume ordering and place unknown-volume cards
    // after it instead of manufacturing a comparable value from recent trades.
    if (left.executionBackend !== right.executionBackend) return left.executionBackend === "DATABASE" ? -1 : 1;
    if (left.executionBackend === "DATABASE" && right.executionBackend === "DATABASE") {
      const leftVolume = left.financial.market.volumeMilli;
      const rightVolume = right.financial.market.volumeMilli;
      if (leftVolume !== rightVolume) return leftVolume > rightVolume ? -1 : 1;
    }
    return compareIds(left, right);
  });
}

export default async function MarketsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const params = await searchParams;
  const query = typeof params.q === "string" ? params.q.trim() : "";
  const category = typeof params.category === "string" && params.category !== "Trending" ? params.category : undefined;
  const sort: BrowseSort = params.sort === "new" || params.sort === "closing" ? params.sort : "trending";
  const now = new Date();
  const loaded = await unifiedMarketReadRepository.list({
    status: "OPEN",
    category,
    q: query || undefined,
    sort: sort === "new" ? "newest" : sort === "closing" ? "closing" : "featured",
    limit: 100,
  });
  const markets = sortBrowseMarkets(loaded.filter((market) =>
    market.executionBackend === "SOLANA" || market.financial.market.closesAt > now), sort);
  const summaries = markets.map((market) => market.executionBackend === "DATABASE"
    ? market.financial.summary
    : solanaMarketSummary(market, now));

  return <div className={`page-shell browse-page ${styles.page}`}>
    <div className={`browse-layout ${styles.layout}`}>
      <div className={styles.intro}>
        <header className={styles.header}><h1>Markets</h1><a className={`button button-secondary ${styles.suggest}`} href={MARKET_SUGGESTION_FORM_URL} target="_blank" rel="noreferrer" aria-label="Suggest a market (opens in a new tab)">Suggest a market</a></header>
        <p><Link href="/events">Browse grouped events →</Link></p>
      </div>
      <form className={`market-filters ${styles.filters}`} action="/markets">
        <label className="search-field"><Search /><span className="sr-only">Search markets</span><input type="search" name="q" defaultValue={query} placeholder="Search questions and topics" /></label>
        <label><span className="sr-only">Category</span><select name="category" defaultValue={category ?? ""}><option value="">All categories</option>{MARKET_CATEGORIES.filter((item) => item !== "Trending").map((item) => <option value={item} key={item}>{item}</option>)}</select></label>
        <label><Filter /><span className="sr-only">Sort markets</span><select name="sort" defaultValue={sort}><option value="trending">Trending</option><option value="new">Newest</option><option value="closing">Closing soon</option></select></label>
        <button className="button button-primary">Show markets</button>
      </form>
      <section className={`browse-results ${styles.results}`} aria-label="Market results">
        <div className="results-heading"><strong>{summaries.length} market{summaries.length === 1 ? "" : "s"}</strong>{category && <span className="filter-chip">{category}</span>}</div>
        {summaries.length ? <div className={`market-list browse-list ${styles.marketList}`}>{summaries.map((market) => <MarketListRow className={styles.marketRow} market={market} key={market.id} />)}</div> : <EmptyState title="No markets found" description="Try a broader search or another category." />}
      </section>
    </div>
  </div>;
}
