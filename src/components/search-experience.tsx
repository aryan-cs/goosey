"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { FormEvent, useEffect, useRef, useState } from "react";
import { CalendarDays, Search, UserRound, X } from "lucide-react";

type MarketResult = {
  id: string;
  slug: string;
  title: string;
  shortTitle: string;
  category: string;
  status: string;
  probabilityYesBps: number | null;
};

type EventResult = {
  id: string;
  slug: string;
  title: string;
  shortTitle: string;
  description: string;
  category: string;
  marketCount: number;
};

type ProfileResult = {
  id: string;
  username: string;
  displayName: string;
  bio: string | null;
};

type SearchResponse = {
  query: string;
  markets: MarketResult[];
  events: EventResult[];
  profiles: ProfileResult[];
};

function SearchSkeleton() {
  return <div className="search-skeleton" aria-hidden="true">{[0, 1, 2, 3].map((item) => <span key={item} />)}</div>;
}

export function SearchExperience({ initialQuery = "" }: { initialQuery?: string }) {
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState(initialQuery);
  const [results, setResults] = useState<SearchResponse | null>(null);
  const [status, setStatus] = useState<"idle" | "loading" | "ready" | "error">(initialQuery.trim().length >= 2 ? "loading" : "idle");
  const [retry, setRetry] = useState(0);

  useEffect(() => {
    const normalized = query.trim();
    if (normalized.length < 2) return;
    const controller = new AbortController();
    const timer = window.setTimeout(async () => {
      try {
        const response = await fetch(`/api/search?q=${encodeURIComponent(normalized)}&limit=8`, { signal: controller.signal });
        if (!response.ok) throw new Error("Search is unavailable.");
        setResults(await response.json() as SearchResponse);
        setStatus("ready");
        router.replace(`/search?q=${encodeURIComponent(normalized)}`, { scroll: false });
      } catch (error) {
        if ((error as Error).name !== "AbortError") setStatus("error");
      }
    }, retry ? 0 : 240);
    return () => { window.clearTimeout(timer); controller.abort(); };
  }, [query, retry, router]);

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (query.trim().length >= 2) { setStatus("loading"); setRetry((value) => value + 1); }
  }

  function updateQuery(value: string) {
    setQuery(value);
    setResults(null);
    setStatus(value.trim().length >= 2 ? "loading" : "idle");
    if (!value.trim()) router.replace("/search", { scroll: false });
  }

  const count = results ? results.markets.length + results.events.length + results.profiles.length : 0;
  return <div className="search-experience">
    <form className="search-hero-form" role="search" onSubmit={submit}>
      <Search aria-hidden="true" />
      <label className="sr-only" htmlFor="site-search">Search Goosey</label>
      <input ref={inputRef} id="site-search" type="search" value={query} onChange={(event) => updateQuery(event.target.value)} placeholder="Search markets, events, or people" autoComplete="off" autoFocus />
      {query && <button type="button" className="search-clear" onClick={() => { updateQuery(""); inputRef.current?.focus(); }} aria-label="Clear search"><X /></button>}
    </form>

    <div className="search-feedback" aria-live="polite">
      {query.trim().length === 1 && <p>Type one more letter to search.</p>}
      {!query.trim() && <p>Try a market topic, an event, or someone&apos;s name.</p>}
      {status === "loading" && <><span className="sr-only">Searching</span><SearchSkeleton /></>}
      {status === "error" && <div className="search-error" role="alert"><p>Search did not load. Give it another try.</p><button className="button button-secondary" type="button" onClick={() => { setStatus("loading"); setRetry((value) => value + 1); }}>Try again</button></div>}
      {status === "ready" && count === 0 && <div className="search-empty"><Search /><h2>No matches for “{results?.query}”</h2><p>Try a shorter phrase or a different spelling.</p></div>}
    </div>

    {status === "ready" && count > 0 && <div className="search-results" aria-label={`Search results for ${results?.query}`}>
      {!!results?.markets.length && <section><div className="search-group-heading"><h2>Markets</h2><Link href={`/markets?q=${encodeURIComponent(results.query)}`}>See all</Link></div><div className="search-result-list">{results.markets.map((market) => <Link className="search-result-row" href={`/markets/${market.slug}`} key={market.id}><span className="search-result-icon market"><Search aria-hidden="true" /></span><span><strong>{market.shortTitle || market.title}</strong><small>{market.category} · {market.status.toLocaleLowerCase()}</small></span><b>{market.probabilityYesBps === null ? "No price" : `${(market.probabilityYesBps / 100).toFixed(0)}%`} <small>YES</small></b></Link>)}</div></section>}
      {!!results?.events.length && <section><div className="search-group-heading"><h2>Events</h2><Link href="/events">See all</Link></div><div className="search-result-list">{results.events.map((event) => <Link className="search-result-row" href={`/events/${event.slug}`} key={event.id}><span className="search-result-icon"><CalendarDays aria-hidden="true" /></span><span><strong>{event.shortTitle || event.title}</strong><small>{event.marketCount} market{event.marketCount === 1 ? "" : "s"} · {event.category}</small></span></Link>)}</div></section>}
      {!!results?.profiles.length && <section><div className="search-group-heading"><h2>People</h2></div><div className="search-result-list">{results.profiles.map((profile) => <Link className="search-result-row" href={`/users/${profile.username}`} key={profile.id}><span className="search-result-icon"><UserRound aria-hidden="true" /></span><span><strong>{profile.displayName}</strong><small>@{profile.username}{profile.bio ? ` · ${profile.bio}` : ""}</small></span></Link>)}</div></section>}
    </div>}
  </div>;
}
