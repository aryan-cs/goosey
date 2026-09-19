"use client";

import Link from "next/link";
import { ArrowRight, Feather, ShieldCheck, Wallet } from "lucide-react";
import { useEffect, useRef, useState } from "react";
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
  if (seat === undefined || value.registered !== (seat !== null)) return null;
  return { ...identity, status: "available", finalizedSlot: value.finalizedSlot, registered: value.registered, seat };
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
  const amount = BigInt(value);
  return `${(amount / 1000n).toLocaleString("en-CA")}.${(amount % 1000n).toString().padStart(3, "0")} 🪶`;
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
  const title = kind === "unavailable" ? "On-chain portfolio unavailable"
    : kind === "rate-limited" ? "Portfolio refresh paused"
      : signedOut ? "Sign in again to view your portfolio" : "Could not load on-chain portfolio";
  const copy = kind === "unavailable" ? "The on-chain catalog is disabled or its verified data source is unavailable. No cached balances are shown."
    : kind === "rate-limited" ? "Too many refreshes were requested. Wait a moment, then retry."
      : signedOut ? "Your session ended. Your on-chain accounts have not changed."
        : "The private portfolio response could not be verified. No balances are shown.";
  return <div className={styles.state} role="alert"><h3>{title}</h3><p>{copy}</p>
    {signedOut ? <Link className="button button-primary" href="/login?next=%2Fportfolio">Sign in</Link>
      : <button type="button" className="button button-secondary" onClick={retry}>Retry</button>}</div>;
}

function WalletCard({ wallet }: { wallet: Extract<SolanaPortfolioData, { status: "linked" }>["wallet"] }) {
  return <article className={`${styles.card} ${styles.walletCard}`}>
    <div className={styles.cardHeading}><div><span className={styles.eyebrow}>Wallet-held</span><h3>Feathers outside market escrow</h3></div><Wallet aria-hidden="true" size={20} /></div>
    {wallet.balance.status === "available" ? <>
      <strong className={styles.walletAmount}>{formatFeatherAmount(wallet.balance.amount)}</strong>
      <p className={styles.slot}>Finalized at slot {wallet.balance.finalizedSlot}</p>
      {wallet.balance.accountStatus === "absent" && <p className={styles.note}>No feather token account exists for this wallet yet. The verified wallet-held balance is zero.</p>}
    </> : <div className={styles.inlineUnavailable} role="status"><strong>Wallet balance unavailable</strong><p>Market escrow snapshots may still be shown below. This balance is not treated as zero.</p></div>}
    <Link className={styles.manageLink} href="/wallet">Wallet setup and account link <ArrowRight size={15} aria-hidden="true" /></Link>
  </article>;
}

function MarketCard({ item }: { item: AvailableMarket | UnavailableMarket }) {
  return <article className={styles.marketCard}>
    <header className={styles.marketHeader}><div><span className={styles.eyebrow}>On-chain market</span><h3><Link href={item.href}>{item.title}</Link></h3></div>
      <span className={`${styles.badge} ${item.status === "available" && item.registered ? styles.active : ""}`}>
        {item.status === "unavailable" ? "Unavailable" : item.registered ? "Seat registered" : "No market seat"}
      </span></header>
    {item.status === "unavailable" ? <div className={styles.inlineUnavailable} role="status"><strong>Market state unavailable</strong><p>No escrow or position amounts are shown for this market.</p></div>
      : item.seat === null ? <div className={styles.noSeat}><p>This wallet has no escrow or position seat in this market.</p><p className={styles.slot}>Verified at finalized slot {item.finalizedSlot}</p></div>
        : <><div className={styles.marketSections}>
          <section aria-label={`${item.title} escrow`}><h4>Market escrow</h4><dl className={styles.values}>
            <div><dt>Available feathers</dt><dd>{formatFeatherAmount(item.seat.availableCash)}</dd></div>
            <div><dt>Reserved feathers</dt><dd>{formatFeatherAmount(item.seat.reservedCash)}</dd></div>
          </dl></section>
          <section aria-label={`${item.title} positions`}><h4>Positions</h4><dl className={styles.values}>
            <div><dt>YES contracts</dt><dd>{contracts(item.seat.yes)}</dd></div>
            <div><dt>Reserved YES</dt><dd>{contracts(item.seat.reservedYes)}</dd></div>
            <div><dt>NO contracts</dt><dd>{contracts(item.seat.no)}</dd></div>
            <div><dt>Reserved NO</dt><dd>{contracts(item.seat.reservedNo)}</dd></div>
          </dl></section>
        </div><p className={styles.slot}>Finalized at slot {item.finalizedSlot}. Contract totals include their reserved amounts.</p></>}
    <Link className={styles.marketLink} href={item.href}>Open verified market <ArrowRight size={15} aria-hidden="true" /></Link>
  </article>;
}

export function SolanaPortfolioView({ data, loading, loadingMore, error, capped, onRetry, onLoadMore }: {
  data: SolanaPortfolioData | null;
  loading: boolean;
  loadingMore: boolean;
  error: ReadErrorKind | null;
  capped: boolean;
  onRetry: () => void;
  onLoadMore: () => void;
}) {
  return <section className={styles.root} aria-labelledby="solana-portfolio-heading" aria-busy={loading || loadingMore}>
    <header className={styles.heading}><div><span className={styles.eyebrow}><Feather size={14} aria-hidden="true" /> Goosey on Solana</span>
      <h2 id="solana-portfolio-heading">On-chain portfolio</h2><p>Wallet and market holdings from verified finalized chain reads.</p></div>
      <Link className="button button-secondary" href="/chain">Browse on-chain markets</Link></header>
    <aside className={styles.integrity}><ShieldCheck size={19} aria-hidden="true" /><p>Wallet-held feathers and every market escrow can be observed at different finalized slots. They are displayed separately; no combined total is calculated.</p></aside>
    {loading && !data && <div className={styles.loading} role="status"><span>Loading private on-chain portfolio…</span><div /><div /></div>}
    {!loading && !data && error && <StateAction kind={error} retry={onRetry} />}
    {data?.status === "not-linked" && <div className={styles.state}><h3>Link a Solana wallet</h3><p>Link the wallet you use for Goosey to read its feathers and published-market positions.</p><Link className="button button-primary" href="/wallet">Set up wallet</Link></div>}
    {data?.status === "linked" && <div className={styles.content}>
      <WalletCard wallet={data.wallet} />
      <div className={styles.marketTitle}><h3>Published market holdings</h3><p>Each card is an independent market snapshot.</p></div>
      {!data.items.length ? <div className={styles.state}><h3>No published on-chain markets</h3><p>There are no verified published markets to inspect. No sample positions or prices are shown.</p><Link className="button button-secondary" href="/chain">View market directory</Link></div>
        : <div className={styles.markets}>{data.items.map(item => <MarketCard key={item.marketAddress} item={item} />)}</div>}
      {error && <StateAction kind={error} retry={onRetry} />}
      <div className={styles.pagination}>
        <span role="status">{data.items.length ? `${data.items.length} ${data.items.length === 1 ? "market" : "markets"} shown` : ""}</span>
        {data.nextCursor && !capped && <button type="button" className="button button-secondary" disabled={loadingMore} onClick={onLoadMore}>{loadingMore ? "Loading more…" : "Load more markets"}</button>}
      </div>
      {capped && <p className={styles.cap} role="status">Showing the first {data.items.length} published markets. Open the market directory to browse the rest.</p>}
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

  return <SolanaPortfolioView data={data} loading={loading} loadingMore={loadingMore} error={error} capped={capped} onRetry={retry} onLoadMore={loadMore} />;
}
