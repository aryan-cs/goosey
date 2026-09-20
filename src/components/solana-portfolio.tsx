"use client";

import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { FeatherIcon } from "./brand";
import { formatFeathers } from "@/lib/feather-format";
import styles from "./solana-portfolio.module.css";

const PAGE_SIZE = 10;
export const MAX_PORTFOLIO_PAGES = 10;
const U64_MAX = (1n << 64n) - 1n;

type WalletBalance = {
  status: "available";
  amount: string;
  decimals: 3;
  accountStatus: "present" | "absent";
  finalizedSlot: string;
} | { status: "unavailable"; code: "WALLET_BALANCE_UNAVAILABLE" };

type AvailableMarket = {
  marketId: string;
  marketAddress: string;
  title: string;
  slug: string;
  href: string;
  status: "available";
  finalizedSlot: string;
  registered: boolean;
  seat: null | {
    availableCash: string;
    reservedCash: string;
    yes: string;
    no: string;
    reservedYes: string;
    reservedNo: string;
  };
  orders: Array<{
    id: string;
    outcome: "YES" | "NO";
    action: "BUY" | "SELL";
    limitPrice: string;
    remaining: string;
    expiresAt: string | null;
  }>;
};

type UnavailableMarket = Pick<AvailableMarket, "marketId" | "marketAddress" | "title" | "slug" | "href"> & {
  status: "unavailable";
  code: "MARKET_STATE_UNAVAILABLE";
};

export type SolanaPortfolioData = {
  status: "linked";
  wallet: { address: string; balance: WalletBalance };
  items: Array<AvailableMarket | UnavailableMarket>;
  hasMore: boolean;
  nextCursor: string | null;
} | {
  status: "not-linked";
  wallet: null;
  items: [];
  hasMore: false;
  nextCursor: null;
};

type ReadErrorKind = "signed-out" | "unavailable" | "rate-limited" | "invalid" | "failed";
export class PortfolioReadError extends Error {
  constructor(public readonly kind: ReadErrorKind) {
    super(kind);
    this.name = "PortfolioReadError";
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactU64(value: unknown): value is string {
  if (typeof value !== "string" || !/^(0|[1-9][0-9]{0,19})$/.test(value)) return false;
  try { return BigInt(value) <= U64_MAX; } catch { return false; }
}

function requiredString(value: unknown, maximum = 500): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maximum;
}

function canonicalMarketHref(value: unknown, marketId: string): value is string {
  return value === `/chain/markets/${marketId}`;
}

function parseSeat(value: unknown): AvailableMarket["seat"] | undefined {
  if (value === null) return null;
  if (!record(value)) return undefined;
  const keys = ["availableCash", "reservedCash", "yes", "no", "reservedYes", "reservedNo"] as const;
  if (!keys.every(key => exactU64(value[key]))) return undefined;
  if (BigInt(value.reservedYes as string) > BigInt(value.yes as string)
    || BigInt(value.reservedNo as string) > BigInt(value.no as string)) return undefined;
  return Object.fromEntries(keys.map(key => [key, value[key]])) as NonNullable<AvailableMarket["seat"]>;
}

function parseMarket(value: unknown): AvailableMarket | UnavailableMarket | null {
  if (!record(value) || !exactU64(value.marketId) || !requiredString(value.marketAddress, 100)
    || !requiredString(value.title) || !requiredString(value.slug, 200)
    || !canonicalMarketHref(value.href, value.marketId)) return null;
  const identity = { marketId: value.marketId, marketAddress: value.marketAddress,
    title: value.title, slug: value.slug, href: value.href };
  if (value.status === "unavailable" && value.code === "MARKET_STATE_UNAVAILABLE") {
    return { ...identity, status: "unavailable", code: value.code };
  }
  if (value.status !== "available" || !exactU64(value.finalizedSlot) || typeof value.registered !== "boolean") return null;
  const seat = parseSeat(value.seat);
  if (seat === undefined || value.registered !== (seat !== null) || !Array.isArray(value.orders)) return null;
  const orders = value.orders.map(order => {
    if (!record(order) || !exactU64(order.id) || !["YES", "NO"].includes(order.outcome as string)
      || !["BUY", "SELL"].includes(order.action as string) || !exactU64(order.limitPrice)
      || !exactU64(order.remaining) || !(order.expiresAt === null || exactU64(order.expiresAt))) return null;
    return { id: order.id as string, outcome: order.outcome as "YES" | "NO", action: order.action as "BUY" | "SELL",
      limitPrice: order.limitPrice as string, remaining: order.remaining as string, expiresAt: order.expiresAt as string | null };
  });
  if (orders.some(order => order === null)) return null;
  return { ...identity, status: "available", finalizedSlot: value.finalizedSlot, registered: value.registered, seat,
    orders: orders as AvailableMarket["orders"] };
}

export function parsePortfolioResponse(value: unknown): SolanaPortfolioData {
  if (!record(value) || !Array.isArray(value.items) || value.items.length > PAGE_SIZE
    || typeof value.hasMore !== "boolean" || !(value.nextCursor === null
      || (typeof value.nextCursor === "string" && value.nextCursor.length > 0 && value.nextCursor.length <= 4096))) {
    throw new PortfolioReadError("invalid");
  }
  if (value.hasMore !== (value.nextCursor !== null)) throw new PortfolioReadError("invalid");
  if (value.items.length === 0 && value.hasMore) throw new PortfolioReadError("invalid");
  if (value.status === "not-linked") {
    if (value.wallet !== null || value.items.length || value.hasMore || value.nextCursor !== null) throw new PortfolioReadError("invalid");
    return { status: "not-linked", wallet: null, items: [], hasMore: false, nextCursor: null };
  }
  if (value.status !== "linked" || !record(value.wallet) || !requiredString(value.wallet.address, 100)
    || !record(value.wallet.balance)) throw new PortfolioReadError("invalid");
  let balance: WalletBalance;
  if (value.wallet.balance.status === "unavailable" && value.wallet.balance.code === "WALLET_BALANCE_UNAVAILABLE") {
    balance = { status: "unavailable", code: "WALLET_BALANCE_UNAVAILABLE" };
  } else if (value.wallet.balance.status === "available" && exactU64(value.wallet.balance.amount)
    && value.wallet.balance.decimals === 3 && (value.wallet.balance.accountStatus === "present" || value.wallet.balance.accountStatus === "absent")
    && exactU64(value.wallet.balance.finalizedSlot)) {
    balance = { status: "available", amount: value.wallet.balance.amount, decimals: 3,
      accountStatus: value.wallet.balance.accountStatus, finalizedSlot: value.wallet.balance.finalizedSlot };
  } else throw new PortfolioReadError("invalid");
  const items = value.items.map(parseMarket);
  if (items.some(item => item === null)) throw new PortfolioReadError("invalid");
  return { status: "linked", wallet: { address: value.wallet.address, balance },
    items: items as Array<AvailableMarket | UnavailableMarket>, hasMore: value.hasMore, nextCursor: value.nextCursor };
}

export async function requestPortfolioPage(cursor: string | null, signal: AbortSignal,
  fetcher: typeof fetch = fetch): Promise<SolanaPortfolioData> {
  const query = new URLSearchParams({ limit: PAGE_SIZE.toString() });
  if (cursor) query.set("cursor", cursor);
  const response = await fetcher(`/api/solana/portfolio?${query}`, {
    method: "GET", credentials: "same-origin", cache: "no-store", signal,
    headers: { Accept: "application/json" },
  });
  if (!response.ok) {
    if (response.status === 401) throw new PortfolioReadError("signed-out");
    if (response.status === 503) throw new PortfolioReadError("unavailable");
    if (response.status === 429) throw new PortfolioReadError("rate-limited");
    throw new PortfolioReadError("failed");
  }
  try { return parsePortfolioResponse(await response.json()); }
  catch (error) { if (error instanceof PortfolioReadError) throw error; throw new PortfolioReadError("invalid"); }
}

export function formatFeatherAmount(value: string) {
  if (!exactU64(value)) throw new Error("Invalid feather amount");
  return formatFeathers(BigInt(value));
}

function contracts(value: string) {
  if (!exactU64(value)) throw new Error("Invalid contract amount");
  return BigInt(value).toLocaleString("en-CA");
}

export function mergePortfolioItems(current: SolanaPortfolioData | null, incoming: SolanaPortfolioData) {
  if (incoming.status !== "linked") return incoming;
  const unique = new Map((current?.status === "linked" ? current.items : []).map(item => [item.marketAddress, item]));
  for (const item of incoming.items) if (!unique.has(item.marketAddress)) unique.set(item.marketAddress, item);
  return { ...incoming, items: [...unique.values()] } satisfies SolanaPortfolioData;
}

function StateAction({ kind, retry }: { kind: ReadErrorKind; retry: () => void }) {
  const signedOut = kind === "signed-out";
  const title = kind === "unavailable" ? "Portfolio temporarily unavailable"
    : kind === "rate-limited" ? "Portfolio refresh paused"
      : signedOut ? "Sign in again to view your portfolio" : "Could not load your portfolio";
  const copy = kind === "unavailable" ? "Your current balance and positions could not be verified. No cached amounts are shown."
    : kind === "rate-limited" ? "Too many refreshes were requested. Wait a moment, then retry."
      : signedOut ? "Your session ended. Your account has not changed."
        : "Your portfolio response could not be verified. No balances are shown.";
  return <div className={styles.state} role="alert"><h3>{title}</h3><p>{copy}</p>
    {signedOut ? <Link className="button button-primary" href="/login?next=%2Fportfolio">Sign in</Link>
      : <button type="button" className="button button-secondary" onClick={retry}>Retry</button>}</div>;
}

function WalletCard({ wallet }: { wallet: Extract<SolanaPortfolioData, { status: "linked" }>["wallet"] }) {
  return <article className={`${styles.card} ${styles.walletCard}`}>
    <div className={styles.cardHeading}><div><span className={styles.eyebrow}>Account balance</span><h3>Feathers ready to use</h3></div></div>
    {wallet.balance.status === "available" ? <>
      <strong className={styles.walletAmount}><FeatherIcon /> {formatFeatherAmount(wallet.balance.amount)}</strong>
      {wallet.balance.accountStatus === "absent" && <p className={styles.note}>No feathers are available in your account yet.</p>}
    </> : <div className={styles.inlineUnavailable} role="status"><strong>Balance unavailable</strong><p>Market positions may still be shown below. This balance is not treated as zero.</p></div>}
  </article>;
}

function MarketCard({ item, nowMs }: { item: AvailableMarket | UnavailableMarket; nowMs: number }) {
  const marketHref = `/markets/${encodeURIComponent(item.slug)}`;
  return <article className={styles.marketCard}>
    <header className={styles.marketHeader}><div><span className={styles.eyebrow}>Active market</span><h3><Link href={marketHref}>{item.title}</Link></h3></div>
      <span className={`${styles.badge} ${item.status === "available" && item.registered ? styles.active : ""}`}>
        {item.status === "unavailable" ? "Unavailable" : item.registered ? "Active" : "No position"}
      </span></header>
    {item.status === "unavailable" ? <div className={styles.inlineUnavailable} role="status"><strong>Market details unavailable</strong><p>No reserved feathers, positions, or orders are shown for this market.</p></div>
      : item.seat === null ? <div className={styles.noSeat}><p>You have no active position in this market.</p></div>
        : <><div className={styles.marketSections}>
          <section aria-label={`${item.title} feathers`}><h4>Feathers in this market</h4><dl className={styles.values}>
            <div><dt>Available</dt><dd><FeatherIcon /> {formatFeatherAmount(item.seat.availableCash)}</dd></div>
            <div><dt>Reserved</dt><dd><FeatherIcon /> {formatFeatherAmount(item.seat.reservedCash)}</dd></div>
          </dl></section>
          <section aria-label={`${item.title} positions`}><h4>Positions</h4><dl className={styles.values}>
            <div><dt>YES contracts</dt><dd>{contracts(item.seat.yes)}</dd></div>
            <div><dt>Reserved YES</dt><dd>{contracts(item.seat.reservedYes)}</dd></div>
            <div><dt>NO contracts</dt><dd>{contracts(item.seat.no)}</dd></div>
            <div><dt>Reserved NO</dt><dd>{contracts(item.seat.reservedNo)}</dd></div>
          </dl></section>
        </div>{item.orders.length > 0 && <section className={styles.orders} aria-label={`${item.title} open orders`}><h4>Open orders</h4><ul>{item.orders.map(order => {
          const expired = order.expiresAt !== null && BigInt(order.expiresAt) * 1000n <= BigInt(nowMs);
          return <li key={order.id}><span className={`side-badge ${order.outcome.toLowerCase()}`}>{order.action === "BUY" ? "Buy" : "Sell"} {order.outcome}</span><span>{contracts(order.remaining)} {order.remaining === "1" ? "contract" : "contracts"}</span><span><FeatherIcon /> {formatFeatherAmount(order.limitPrice)} each</span>{expired && <small>Expired · cleanup pending</small>}</li>;
        })}</ul></section>}<p className={styles.note}>Contract totals include amounts reserved by open orders.</p></>}
    <Link className={styles.marketLink} href={marketHref}>View market <ArrowRight size={15} aria-hidden="true" /></Link>
  </article>;
}

export function SolanaPortfolioView({ data, loading, loadingMore, error, capped, nowMs, onRetry, onLoadMore }: {
  data: SolanaPortfolioData | null;
  loading: boolean;
  loadingMore: boolean;
  error: ReadErrorKind | null;
  capped: boolean;
  nowMs: number;
  onRetry: () => void;
  onLoadMore: () => void;
}) {
  const visibleItems = data?.status === "linked"
    ? data.items.filter(item => item.status === "unavailable" || item.seat !== null)
    : [];
  return <section className={styles.root} aria-labelledby="managed-portfolio-heading" aria-busy={loading || loadingMore}>
    <header className={styles.heading}><div><span className={styles.eyebrow}>Current account</span>
      <h2 id="managed-portfolio-heading">Active positions</h2><p>Your available feathers, open positions, and resting orders.</p></div></header>
    <aside className={styles.integrity}><p>Balances are verified independently. They stay separate here so an unavailable market cannot be mistaken for a zero balance.</p></aside>
    {loading && !data && <div className={styles.loading} role="status"><span>Loading your portfolio…</span><div /><div /></div>}
    {!loading && !data && error && <StateAction kind={error} retry={onRetry} />}
    {data?.status === "not-linked" && <div className={styles.state}><h3>Your trading account is getting ready</h3><p>Your active positions will appear here after your first trade.</p><Link className="button button-primary" href="/markets">Find a market</Link></div>}
    {data?.status === "linked" && <div className={styles.content}>
      <WalletCard wallet={data.wallet} />
      <div className={styles.marketTitle}><h3>Open markets</h3><p>Only active positions and resting orders appear here.</p></div>
      {!visibleItems.length ? <div className={styles.state}><h3>No active positions</h3><p>Your positions and orders will appear here after you trade.</p><Link className="button button-secondary" href="/markets">Find a market</Link></div>
        : <div className={styles.markets}>{visibleItems.map(item => <MarketCard key={item.marketAddress} item={item} nowMs={nowMs} />)}</div>}
      {error && <StateAction kind={error} retry={onRetry} />}
      <div className={styles.pagination}>
        <span role="status">{visibleItems.length ? `${visibleItems.length} ${visibleItems.length === 1 ? "market" : "markets"} shown` : ""}</span>
        {data.nextCursor && !capped && <button type="button" className="button button-secondary" disabled={loadingMore} onClick={onLoadMore}>{loadingMore ? "Loading more…" : "Load more"}</button>}
      </div>
      {capped && <p className={styles.cap} role="status">Showing the first {data.items.length} active markets.</p>}
    </div>}
  </section>;
}

export function SolanaPortfolio() {
  const [data, setData] = useState<SolanaPortfolioData | null>(null);
  const [request, setRequest] = useState<{ cursor: string | null; attempt: number }>({ cursor: null, attempt: 0 });
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<ReadErrorKind | null>(null);
  const [pages, setPages] = useState(0);
  const [capped, setCapped] = useState(false);
  const [nowMs, setNowMs] = useState(0);
  const cursors = useRef(new Set<string>());

  useEffect(() => {
    const controller = new AbortController();
    requestPortfolioPage(request.cursor, controller.signal).then(incoming => {
      if (controller.signal.aborted) return;
      if (request.cursor && incoming.status !== "linked") throw new PortfolioReadError("invalid");
      const nextPages = request.cursor ? pages + 1 : 1;
      const repeatedCursor = incoming.nextCursor !== null && (incoming.nextCursor === request.cursor || cursors.current.has(incoming.nextCursor));
      if (!request.cursor) cursors.current.clear();
      if (request.cursor) cursors.current.add(request.cursor);
      const merged = mergePortfolioItems(request.cursor ? data : null, incoming);
      setData(repeatedCursor && merged.status === "linked" ? { ...merged, hasMore: false, nextCursor: null } : merged);
      setPages(nextPages); setCapped(repeatedCursor || nextPages >= MAX_PORTFOLIO_PAGES && incoming.nextCursor !== null);
      setError(repeatedCursor ? "invalid" : null);
    }).catch(reason => {
      if (!controller.signal.aborted) setError(reason instanceof PortfolioReadError ? reason.kind : "failed");
    }).finally(() => {
      if (!controller.signal.aborted) { setLoading(false); setLoadingMore(false); }
    });
    return () => controller.abort();
    // data/pages are snapshots tied to the explicit request and must not retrigger a read.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [request]);

  useEffect(() => {
    function refresh() {
      if (document.visibilityState !== "visible" || !navigator.onLine || loading || loadingMore || error || request.cursor) return;
      setRequest(current => ({ cursor: null, attempt: current.attempt + 1 }));
    }
    const timer = window.setInterval(refresh, 15_000);
    window.addEventListener("focus", refresh);
    window.addEventListener("online", refresh);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", refresh);
      window.removeEventListener("online", refresh);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [loading, loadingMore, error, request.cursor]);

  useEffect(() => {
    const update = () => setNowMs(Date.now());
    update();
    const timer = window.setInterval(update, 60_000);
    return () => window.clearInterval(timer);
  }, []);

  function retry() {
    if (loading || loadingMore) return;
    setError(null);
    if (data && request.cursor) setLoadingMore(true); else setLoading(true);
    setRequest(current => ({ ...current, attempt: current.attempt + 1 }));
  }
  function loadMore() {
    if (data?.status !== "linked" || !data.nextCursor || loading || loadingMore || pages >= MAX_PORTFOLIO_PAGES) return;
    setError(null); setLoadingMore(true);
    setRequest(current => ({ cursor: data.nextCursor, attempt: current.attempt + 1 }));
  }

  return <SolanaPortfolioView data={data} loading={loading} loadingMore={loadingMore} error={error} capped={capped} nowMs={nowMs} onRetry={retry} onLoadMore={loadMore} />;
}
