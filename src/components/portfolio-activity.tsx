"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { apiFetch } from "@/lib/client-api";
import { EmptyState, ErrorState, LoadingState } from "./states";
import styles from "./portfolio-activity.module.css";

type Activity = {
  orderId: string; fillId?: string; market: { slug: string; title: string; payoutMilli: string };
  outcome: "YES" | "NO"; action: "BUY" | "SELL"; createdAt: string;
  status?: string; role?: string; limitPriceMilli?: string; executionPriceMilli?: string;
  initialQuantity?: number; filledQuantity?: number; remainingQuantity?: number;
  quantity?: number; cumulativeFeeMilli?: string; feeMilli?: string;
};

function feathers(value: string = "0") {
  const amount = BigInt(value);
  const negative = amount < 0n;
  const absolute = negative ? -amount : amount;
  const fraction = (absolute % 1000n).toString().padStart(3, "0").replace(/0+$/, "");
  return `${negative ? "−" : ""}${(absolute / 1000n).toLocaleString("en-CA")}${fraction ? `.${fraction}` : ""} feathers`;
}

function readable(value: string) { return value.toLowerCase().replaceAll("_", " "); }

function History({ kind }: { kind: "orders" | "fills" }) {
  const [rows, setRows] = useState<Activity[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [signedOut, setSignedOut] = useState(false);
  const [request, setRequest] = useState<{ cursor: string | null; attempt: number }>({ cursor: null, attempt: 0 });
  useEffect(() => {
    const controller = new AbortController();
    const query = new URLSearchParams({ limit: "20" });
    if (request.cursor) query.set("cursor", request.cursor);
    apiFetch(`/api/v1/${kind}?${query}`, { signal: controller.signal, cache: "no-store" })
      .then(async response => {
        if (response.status === 401) { setRows([]); setSignedOut(true); return; }
        if (!response.ok) throw new Error("Please try again. Your activity has not changed.");
        const body = await response.json() as { orders?: Activity[]; fills?: Activity[]; nextCursor: string | null };
        if (controller.signal.aborted) return;
        const incoming = body[kind];
        if (!Array.isArray(incoming)) throw new Error("Activity could not be read. Please try again.");
        setRows(previous => request.cursor ? [...new Map([...previous, ...incoming].map(row => [row.fillId ?? row.orderId, row])).values()] : incoming);
        setCursor(body.nextCursor);
        setError(null);
      }).catch(reason => { if (!controller.signal.aborted) setError(reason.message); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [kind, request]);

  function load(next: string | null) {
    setLoading(true); setError(null);
    setRequest(previous => ({ cursor: next, attempt: previous.attempt + 1 }));
  }

  if (signedOut) return <EmptyState title="Sign in to see your activity" description="Your session has ended. Your orders and fills are still saved." action={<Link className="button button-primary" href="/login?next=%2Fportfolio%2Factivity">Sign in</Link>} />;
  return <section aria-label={`${kind === "orders" ? "Order" : "Fill"} history`} aria-busy={loading}>
    <p className={styles.help}>{kind === "orders" ? "Your order-book orders, newest first. Unfilled orders are not completed trades." : "Completed order-book matches, newest first. Prices and fees are for your side of each trade."}</p>
    {error && <ErrorState message={error} onRetry={() => load(request.cursor)} />}
    <ol className={styles.list}>{rows.map(row => <li key={row.fillId ?? row.orderId} className={styles.card}>
      <div className={styles.top}><span className={`side-badge ${row.outcome.toLowerCase()}`}>{row.action === "BUY" ? "Buy" : "Sell"} {row.outcome}</span><span className={styles.status}>{kind === "orders" ? readable(row.status ?? "") : "Filled"}</span></div>
      <Link className={styles.title} href={`/markets/${encodeURIComponent(row.market.slug)}`}>{row.market.title}</Link>
      <dl className={styles.facts}>
        <div><dt>{kind === "orders" ? "Limit price" : "Fill price"}</dt><dd>{feathers(kind === "orders" ? row.outcome === "NO" ? (BigInt(row.market.payoutMilli) - BigInt(row.limitPriceMilli!)).toString() : row.limitPriceMilli : row.executionPriceMilli)}</dd></div>
        <div><dt>Quantity</dt><dd>{(kind === "orders" ? row.initialQuantity : row.quantity)?.toLocaleString("en-CA")} {(kind === "orders" ? row.initialQuantity : row.quantity) === 1 ? "contract" : "contracts"}</dd></div>
        <div><dt>{kind === "orders" ? "Filled / remaining" : "Your role"}</dt><dd>{kind === "orders" ? `${row.filledQuantity?.toLocaleString("en-CA")} / ${row.remainingQuantity?.toLocaleString("en-CA")}` : readable(row.role ?? "")}</dd></div>
        <div><dt>{kind === "orders" ? "Fees so far" : "Your fee"}</dt><dd>{feathers(kind === "orders" ? row.cumulativeFeeMilli : row.feeMilli)}</dd></div>
      </dl>
      <time className={styles.time} dateTime={row.createdAt}>{new Date(row.createdAt).toLocaleString("en-CA", { dateStyle: "medium", timeStyle: "short", timeZone: "America/Toronto" })} Toronto time</time>
    </li>)}</ol>
    {loading && <LoadingState rows={rows.length ? 1 : 3} label={`Loading ${kind}`} />}
    {!loading && !error && !rows.length && <EmptyState title={kind === "orders" ? "No orders yet" : "No fills yet"} description={kind === "orders" ? "Orders you place on order-book markets will appear here." : "When one of your orders matches, you can see the price and fee here."} action={<Link className="button button-secondary" href="/markets">Explore markets</Link>} />}
    <div className={styles.pagination}><span role="status">{rows.length ? `${rows.length} ${rows.length === 1 ? kind.slice(0, -1) : kind} shown` : ""}</span>{cursor && <button className="button button-secondary" disabled={loading} onClick={() => load(cursor)}>{loading ? "Loading…" : "Load more"}</button>}</div>
  </section>;
}

export function PortfolioActivity() {
  const [kind, setKind] = useState<"orders" | "fills">("orders");
  const [revision, setRevision] = useState(0);
  return <div className={styles.root}><div className={styles.toolbar}><div className={styles.tabs} aria-label="Activity type">{(["orders", "fills"] as const).map(value => <button key={value} type="button" aria-pressed={kind === value} onClick={() => setKind(value)}>{value === "orders" ? "Orders" : "Fills"}</button>)}</div><button className="button button-secondary" onClick={() => setRevision(value => value + 1)}>Refresh</button></div><History key={`${kind}-${revision}`} kind={kind} /></div>;
}
