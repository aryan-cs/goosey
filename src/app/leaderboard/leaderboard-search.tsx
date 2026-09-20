"use client";

import { Search } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useId, useRef, useState } from "react";
import styles from "./leaderboard.module.css";
import { UserProfileLink } from "@/components/user-profile-link";

export interface LeaderboardSearchResult {
  userId: string;
  username: string;
  displayName: string;
  rank: number;
  page: number;
}

export function leaderboardPlayerHref(player: Pick<LeaderboardSearchResult, "userId" | "page">) {
  return `/leaderboard?page=${player.page}&focus=${encodeURIComponent(player.userId)}#player-${encodeURIComponent(player.userId)}`;
}

export function LeaderboardSearch() {
  const router = useRouter();
  const listId = useId();
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<LeaderboardSearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const [open, setOpen] = useState(false);
  const requestSequence = useRef(0);

  useEffect(() => {
    const trimmed = query.trim();
    if (!trimmed) return;

    const sequence = ++requestSequence.current;
    const controller = new AbortController();
    const timer = window.setTimeout(async () => {
      try {
        const response = await fetch(`/api/leaderboard/search?q=${encodeURIComponent(trimmed)}&limit=8`, { signal: controller.signal });
        if (!response.ok) throw new Error("Leaderboard search failed");
        const payload = await response.json() as { players?: LeaderboardSearchResult[] };
        if (sequence !== requestSequence.current) return;
        setResults(Array.isArray(payload.players) ? payload.players : []);
        setActiveIndex(-1);
      } catch {
        if (controller.signal.aborted || sequence !== requestSequence.current) return;
        setResults([]);
      } finally {
        if (sequence === requestSequence.current) setLoading(false);
      }
    }, 220);

    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [query]);

  const choose = (player: LeaderboardSearchResult) => {
    setOpen(false);
    setQuery(`@${player.username}`);
    router.push(leaderboardPlayerHref(player));
  };

  const status = loading ? "Searching…" : results.length ? `${results.length} ${results.length === 1 ? "person" : "people"} found` : query.trim() ? "No people found" : "";

  return <div className={styles.searchWrap}>
    <label className="sr-only" htmlFor={`${listId}-input`}>Search leaderboard people</label>
    <div className={styles.searchField}>
      <Search aria-hidden="true" />
      <input
        id={`${listId}-input`}
        type="search"
        value={query}
        placeholder="Search people"
        autoComplete="off"
        role="combobox"
        aria-autocomplete="list"
        aria-controls={listId}
        aria-expanded={open}
        aria-activedescendant={activeIndex >= 0 ? `${listId}-${activeIndex}` : undefined}
        onChange={(event) => {
          const value = event.target.value;
          setQuery(value);
          setResults([]);
          setActiveIndex(-1);
          setLoading(Boolean(value.trim()));
          setOpen(Boolean(value.trim()));
        }}
        onFocus={() => query.trim() && setOpen(true)}
        onKeyDown={(event) => {
          if (event.key === "Escape") { setOpen(false); return; }
          if (event.key === "ArrowDown") {
            event.preventDefault();
            setOpen(true);
            setActiveIndex((index) => Math.min(index + 1, results.length - 1));
          } else if (event.key === "ArrowUp") {
            event.preventDefault();
            setActiveIndex((index) => Math.max(index - 1, 0));
          } else if (event.key === "Enter" && results.length) {
            event.preventDefault();
            choose(results[activeIndex >= 0 ? activeIndex : 0]);
          }
        }}
      />
    </div>
    <span className="sr-only" role="status" aria-live="polite">{status}</span>
    {open && query.trim() && <div className={styles.searchResults} id={listId} role="listbox" aria-label="Leaderboard people">
      {loading ? <p className={styles.searchMessage}>Searching…</p> : results.length ? results.map((player, index) => <div
        id={`${listId}-${index}`}
        role="option"
        aria-selected={index === activeIndex}
        className={`${styles.searchResult} ${index === activeIndex ? styles.searchResultActive : ""}`}
        key={player.userId}
        onMouseDown={(event) => event.preventDefault()}
        onMouseEnter={() => setActiveIndex(index)}
      ><button type="button" onClick={() => choose(player)}><span><strong>{player.displayName}</strong></span><b>#{player.rank.toLocaleString()}</b></button><UserProfileLink className={styles.searchProfile} username={player.username}>@{player.username}</UserProfileLink></div>) : <p className={styles.searchMessage}>No people found</p>}
    </div>}
  </div>;
}
