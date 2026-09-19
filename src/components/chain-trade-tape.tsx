"use client";

import { useCallback, useEffect, useId, useReducer, useRef } from "react";
import styles from "./chain-trade-tape.module.css";

const U64_MAX = (1n << 64n) - 1n;
const PAGE_SIZE = 25;
const MAX_CURSOR_LENGTH = 512;
const SIGNATURE_PATTERN = /^[1-9A-HJ-NP-Za-km-z]{64,88}$/;
const MARKET_ID_PATTERN = /^(0|[1-9][0-9]{0,19})$/;
const INTEGER_PATTERN = /^(0|[1-9][0-9]{0,19})$/;
const CURSOR_PATTERN = /^[A-Za-z0-9_-]+$/;

export type ChainExplorerCluster = "mainnet-beta" | "devnet" | "testnet";
type CoverageStatus = "partial" | "bounded_complete" | "unavailable";
type TradeSide = "BUY" | "SELL";
type TradeOutcome = "YES" | "NO";

export type ChainTrade = Readonly<{
  signature: string;
  slot: string;
  logIndex: number;
  makerOrderId: string;
  takerOrderId: string;
  makerSeat: string;
  takerSeat: string;
  quantity: string;
  yesPrice: string;
  makerFee: string;
  takerFee: string;
  makerOutcome: TradeOutcome;
  makerAction: TradeSide;
  takerOutcome: TradeOutcome;
  takerAction: TradeSide;
}>;

type Coverage = Readonly<{
  status: CoverageStatus;
  coverageStartSignature: string | null;
  headSignature: string | null;
  backfillComplete: boolean;
  revision: number | null;
  updatedAt: string | null;
  fullHistory: false;
}>;

export type ChainTradePage = Readonly<{
  items: readonly ChainTrade[];
  nextCursor: string | null;
  ordering: Readonly<{
    direction: "desc";
    keys: readonly ["slot", "signature", "logIndex"];
    semantics: "deterministic_journal_display_only";
  }>;
  coverage: Coverage;
}>;

export type ChainTradeTapeState = Readonly<{
  marketKey: string;
  requestId: number;
  status: "loading" | "loading-more" | "ready" | "error";
  items: readonly ChainTrade[];
  nextCursor: string | null;
  coverage: Coverage | null;
  seenCursors: readonly string[];
  failedCursor: string | null;
  error: string | null;
}>;

export type ChainTradeTapeAction =
  | Readonly<{ type: "reset"; marketKey: string; requestId: number }>
  | Readonly<{ type: "start"; marketKey: string; requestId: number; cursor: string | null }>
  | Readonly<{ type: "success"; marketKey: string; requestId: number; cursor: string | null; page: ChainTradePage }>
  | Readonly<{ type: "failure"; marketKey: string; requestId: number; cursor: string | null }>;

const emptyCoverage: Coverage = {
  status: "unavailable",
  coverageStartSignature: null,
  headSignature: null,
  backfillComplete: false,
  revision: null,
  updatedAt: null,
  fullHistory: false,
};

function ownRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]) {
  const actual = Object.keys(value);
  return actual.length === keys.length && actual.every((key) => keys.includes(key));
}

function u64String(value: unknown, positive = false): value is string {
  if (typeof value !== "string" || !INTEGER_PATTERN.test(value)) return false;
  const parsed = BigInt(value);
  return parsed <= U64_MAX && (!positive || parsed > 0n);
}

function parseSignature(value: unknown): string {
  if (typeof value !== "string" || !SIGNATURE_PATTERN.test(value)) throw new Error("Invalid signature");
  return value;
}

function parseTrade(value: unknown, payoutMilli?: bigint): ChainTrade {
  if (!ownRecord(value) || !exactKeys(value, ["signature", "slot", "logIndex", "makerOrderId", "takerOrderId",
    "makerSeat", "takerSeat", "quantity", "yesPrice", "makerFee", "takerFee", "makerOutcome", "makerAction",
    "takerOutcome", "takerAction"])) throw new Error("Invalid trade");
  const positive = ["makerOrderId", "takerOrderId", "quantity", "yesPrice"] as const;
  const nonnegative = ["slot", "makerSeat", "takerSeat", "makerFee", "takerFee"] as const;
  if (positive.some((key) => !u64String(value[key], true)) || nonnegative.some((key) => !u64String(value[key]))) {
    throw new Error("Invalid trade integer");
  }
  if (!Number.isInteger(value.logIndex) || (value.logIndex as number) < 0 || (value.logIndex as number) > 4095
    || !["YES", "NO"].includes(value.makerOutcome as string) || !["YES", "NO"].includes(value.takerOutcome as string)
    || !["BUY", "SELL"].includes(value.makerAction as string) || !["BUY", "SELL"].includes(value.takerAction as string)) {
    throw new Error("Invalid trade fields");
  }
  const yesPrice = BigInt(value.yesPrice as string);
  if (payoutMilli !== undefined && yesPrice > payoutMilli) throw new Error("Trade price exceeds payout");
  return {
    signature: parseSignature(value.signature),
    slot: value.slot as string,
    logIndex: value.logIndex as number,
    makerOrderId: value.makerOrderId as string,
    takerOrderId: value.takerOrderId as string,
    makerSeat: value.makerSeat as string,
    takerSeat: value.takerSeat as string,
    quantity: value.quantity as string,
    yesPrice: value.yesPrice as string,
    makerFee: value.makerFee as string,
    takerFee: value.takerFee as string,
    makerOutcome: value.makerOutcome as TradeOutcome,
    makerAction: value.makerAction as TradeSide,
    takerOutcome: value.takerOutcome as TradeOutcome,
    takerAction: value.takerAction as TradeSide,
  };
}

function parseNullableSignature(value: unknown): string | null {
  return value === null ? null : parseSignature(value);
}

function parseCoverage(value: unknown): Coverage {
  if (!ownRecord(value) || !exactKeys(value, ["status", "coverageStartSignature", "headSignature", "backfillComplete",
    "revision", "updatedAt", "fullHistory"])) throw new Error("Invalid coverage");
  if (!(["partial", "bounded_complete", "unavailable"] as const).includes(value.status as CoverageStatus)
    || typeof value.backfillComplete !== "boolean" || value.fullHistory !== false) throw new Error("Invalid coverage state");
  const status = value.status as CoverageStatus;
  if (status === "unavailable") {
    if (value.coverageStartSignature !== null || value.headSignature !== null || value.backfillComplete !== false
      || value.revision !== null || value.updatedAt !== null) throw new Error("Invalid unavailable coverage");
    return emptyCoverage;
  }
  const coverageStartSignature = parseNullableSignature(value.coverageStartSignature);
  const headSignature = parseNullableSignature(value.headSignature);
  if (coverageStartSignature === null || (status === "bounded_complete" && headSignature === null) || !Number.isInteger(value.revision)
    || !Number.isSafeInteger(value.revision) || (value.revision as number) < 0 || (value.revision as number) > 2_147_483_647
    || typeof value.updatedAt !== "string"
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value.updatedAt)
    || !Number.isFinite(Date.parse(value.updatedAt)) || new Date(value.updatedAt).toISOString() !== value.updatedAt) {
    throw new Error("Invalid indexed coverage");
  }
  if ((status === "bounded_complete") !== value.backfillComplete) throw new Error("Contradictory coverage");
  return { status, coverageStartSignature, headSignature, backfillComplete: value.backfillComplete,
    revision: value.revision as number, updatedAt: value.updatedAt, fullHistory: false };
}

export function parseChainTradePage(value: unknown, payoutMilli?: string): ChainTradePage {
  const payout = payoutMilli === undefined ? undefined : parsePayout(payoutMilli);
  if (!ownRecord(value) || !exactKeys(value, ["items", "nextCursor", "ordering", "coverage"])
    || !Array.isArray(value.items) || value.items.length > PAGE_SIZE || !ownRecord(value.ordering)
    || !exactKeys(value.ordering, ["direction", "keys", "semantics"])
    || value.ordering.direction !== "desc" || value.ordering.semantics !== "deterministic_journal_display_only"
    || !Array.isArray(value.ordering.keys) || value.ordering.keys.length !== 3
    || value.ordering.keys[0] !== "slot" || value.ordering.keys[1] !== "signature" || value.ordering.keys[2] !== "logIndex") {
    throw new Error("Invalid trade page");
  }
  if (value.nextCursor !== null && (typeof value.nextCursor !== "string" || value.nextCursor.length === 0
    || value.nextCursor.length > MAX_CURSOR_LENGTH || !CURSOR_PATTERN.test(value.nextCursor))) throw new Error("Invalid cursor");
  const items = mergeChainTrades([], value.items.map((item) => parseTrade(item, payout)));
  if (value.nextCursor !== null && value.items.length !== PAGE_SIZE) throw new Error("Invalid paginated trade page");
  return {
    items,
    nextCursor: value.nextCursor as string | null,
    ordering: { direction: "desc", keys: ["slot", "signature", "logIndex"], semantics: "deterministic_journal_display_only" },
    coverage: parseCoverage(value.coverage),
  };
}

function parsePayout(value: string): bigint {
  if (!u64String(value, true)) throw new Error("Invalid payout");
  return BigInt(value);
}

export function canonicalChainMarketId(value: string): boolean {
  return MARKET_ID_PATTERN.test(value) && BigInt(value) <= U64_MAX;
}

export function tradeKey(trade: Pick<ChainTrade, "signature" | "logIndex">) {
  return `${trade.signature}:${trade.logIndex}`;
}

export function mergeChainTrades(current: readonly ChainTrade[], incoming: readonly ChainTrade[]) {
  const result = [...current];
  const seen = new Map(current.map((trade) => [tradeKey(trade), trade]));
  for (const trade of incoming) {
    const key = tradeKey(trade);
    const existing = seen.get(key);
    if (existing) {
      if (!sameTrade(existing, trade)) throw new Error("Conflicting duplicate trade");
      continue;
    }
    seen.set(key, trade);
    result.push(trade);
  }
  return result;
}

function sameTrade(left: ChainTrade, right: ChainTrade) {
  return (Object.keys(left) as (keyof ChainTrade)[]).every((key) => left[key] === right[key]);
}

export function chainTradeTapeReducer(state: ChainTradeTapeState, action: ChainTradeTapeAction): ChainTradeTapeState {
  if (action.type === "reset") return {
    marketKey: action.marketKey, requestId: action.requestId, status: "loading", items: [], nextCursor: null,
    coverage: null, seenCursors: [], failedCursor: null, error: null,
  };
  if (action.marketKey !== state.marketKey) return state;
  if (action.type === "start") return { ...state, requestId: action.requestId,
    status: action.cursor === null ? "loading" : "loading-more", failedCursor: null, error: null };
  if (action.requestId !== state.requestId) return state;
  if (action.type === "failure") return { ...state, status: "error", failedCursor: action.cursor,
    error: "Verified trade activity could not be loaded." };
  try {
    if (action.page.nextCursor !== null
      && (action.page.nextCursor === action.cursor || state.seenCursors.includes(action.page.nextCursor))) {
      throw new Error("Cursor did not advance");
    }
    const items = action.cursor === null ? action.page.items : mergeChainTrades(state.items, action.page.items);
    if (action.cursor !== null && items.length === state.items.length && action.page.nextCursor !== null) {
      throw new Error("Paginated trade page made no progress");
    }
    return { ...state, status: "ready", items, nextCursor: action.page.nextCursor,
      coverage: action.page.coverage, seenCursors: action.cursor === null ? [] : [...state.seenCursors, action.cursor],
      failedCursor: null, error: null };
  } catch {
    return { ...state, status: "error", failedCursor: action.cursor,
      error: "Verified trade activity could not be loaded." };
  }
}

export async function fetchChainTradePage(marketId: string, cursor: string | null, payoutMilli: string | undefined,
  signal: AbortSignal, fetcher: typeof fetch = fetch): Promise<ChainTradePage> {
  if (!canonicalChainMarketId(marketId)) throw new Error("Invalid market ID");
  if (payoutMilli !== undefined) parsePayout(payoutMilli);
  const query = new URLSearchParams({ limit: PAGE_SIZE.toString() });
  if (cursor !== null) {
    if (cursor.length === 0 || cursor.length > MAX_CURSOR_LENGTH || !CURSOR_PATTERN.test(cursor)) throw new Error("Invalid cursor");
    query.set("cursor", cursor);
  }
  const response = await fetcher(`/api/solana/markets/${marketId}/trades?${query.toString()}`, {
    method: "GET", cache: "no-store", credentials: "same-origin", headers: { Accept: "application/json" }, signal,
  });
  if (!response.ok) throw new Error("Trade endpoint unavailable");
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().startsWith("application/json")) throw new Error("Invalid trade response type");
  const cacheControl = response.headers.get("cache-control")?.toLowerCase() ?? "";
  if (!cacheControl.split(",").some((directive) => directive.trim() === "no-store")) {
    throw new Error("Unsafe trade response caching");
  }
  return parseChainTradePage(await response.json(), payoutMilli);
}

export function formatImpliedProbability(yesPrice: string, payoutMilli: string) {
  if (!u64String(yesPrice)) throw new Error("Invalid price");
  const price = BigInt(yesPrice);
  const payout = parsePayout(payoutMilli);
  if (price > payout) throw new Error("Price exceeds payout");
  // Hundredths of one percent, rounded half-up with integer arithmetic only.
  const hundredths = (price * 10_000n + payout / 2n) / payout;
  return `${hundredths / 100n}.${(hundredths % 100n).toString().padStart(2, "0")}%`;
}

function chartBasisPoints(yesPrice: string, payoutMilli: string) {
  const payout = parsePayout(payoutMilli);
  return (BigInt(yesPrice) * 10_000n + payout / 2n) / payout;
}

function formatFeathers(value: string) {
  const amount = BigInt(value);
  const fraction = (amount % 1000n).toString().padStart(3, "0").replace(/0+$/, "");
  return `${(amount / 1000n).toLocaleString("en-CA")}${fraction ? `.${fraction}` : ""}`;
}

function shortenSignature(value: string) {
  return `${value.slice(0, 6)}…${value.slice(-6)}`;
}

function explorerUrl(signature: string, cluster: ChainExplorerCluster) {
  const query = cluster === "mainnet-beta" ? "" : `?cluster=${cluster}`;
  return `https://explorer.solana.com/tx/${encodeURIComponent(signature)}${query}`;
}

function isExplorerCluster(value: unknown): value is ChainExplorerCluster {
  return value === "mainnet-beta" || value === "devnet" || value === "testnet";
}

function coverageCopy(coverage: Coverage) {
  if (coverage.status === "bounded_complete") {
    return "Bounded window complete: the configured start-to-head scan is complete, but this is not full market history.";
  }
  if (coverage.status === "partial") {
    return "Partial coverage: the verified index has not completed its configured bounded scan window.";
  }
  return "Coverage unavailable: the verified index has not established a scan window.";
}

export function ChainTradeTapeView({ state, payoutMilli, explorerCluster, onLoadMore, onRetry }: {
  state: ChainTradeTapeState;
  payoutMilli?: string;
  explorerCluster?: ChainExplorerCluster;
  onLoadMore: () => void;
  onRetry: () => void;
}) {
  const titleId = useId();
  const chartTitleId = useId();
  const coverage = state.coverage ?? emptyCoverage;
  const probabilityAvailable = payoutMilli !== undefined;
  const chartTrades = probabilityAvailable ? [...state.items].reverse() : [];
  return <section className={styles.panel} aria-labelledby={titleId}>
    <header className={styles.header}>
      <div><p className={styles.eyebrow}>Verified finalized activity</p><h2 id={titleId}>On-chain trade tape</h2></div>
      <span className={`${styles.coverageBadge} ${styles[coverage.status]}`}>{coverage.status.replace("_", " ")}</span>
    </header>
    <div className={styles.coverage} role="note">
      <strong>{coverageCopy(coverage)}</strong>
      <span><code>fullHistory: false</code> · Trades have no inferred timestamps.</span>
    </div>
    {probabilityAvailable && chartTrades.length > 0 && <figure className={styles.chart}>
      <figcaption id={chartTitleId}>YES implied probability from actual execution prices · rounded to 0.01% · dots only, no interpolation</figcaption>
      <svg viewBox="0 0 600 180" role="img" aria-labelledby={chartTitleId} preserveAspectRatio="none">
        <line x1="42" y1="10" x2="42" y2="150" className={styles.axis} />
        <line x1="42" y1="150" x2="590" y2="150" className={styles.axis} />
        <text x="4" y="16" className={styles.axisLabel}>100%</text><text x="18" y="154" className={styles.axisLabel}>0%</text>
        {chartTrades.map((trade, index) => {
          const x = chartTrades.length === 1 ? 316 : 42 + (548 * index) / (chartTrades.length - 1);
          const basisPoints = chartBasisPoints(trade.yesPrice, payoutMilli);
          const y = 150 - Number(basisPoints) * 0.014;
          return <circle key={tradeKey(trade)} cx={x} cy={y} r="5" className={styles.point}>
            <title>{`${formatImpliedProbability(trade.yesPrice, payoutMilli)} YES · ${trade.yesPrice}/${payoutMilli} payout units · slot ${trade.slot}`}</title>
          </circle>;
        })}
      </svg>
      <p>Ascending deterministic journal key → descending deterministic journal key. This is not a wall-clock timeline.</p>
    </figure>}
    {!probabilityAvailable && state.items.length > 0 && <p className={styles.muted}>Probability unavailable because the canonical payout was not supplied.</p>}
    {state.status === "loading" && state.items.length === 0 && <p role="status" className={styles.state}>Loading verified finalized trades…</p>}
    {state.error && <div className={styles.error} role="alert"><p>{state.error} Existing verified rows, if any, remain visible.</p><button type="button" className="button button-secondary" onClick={onRetry}>Retry</button></div>}
    {state.items.length === 0 && state.status !== "loading" && !state.error && <p className={styles.state}>No verified finalized trades are present in the available indexed window. This does not prove that no trades occurred.</p>}
    {state.items.length > 0 && <div className={styles.tableWrap} tabIndex={0} aria-label="Scrollable verified trade activity">
      <table className={styles.table}>
        <caption>{state.items.length} verified finalized {state.items.length === 1 ? "trade" : "trades"} loaded</caption>
        <thead><tr><th scope="col">YES price</th><th scope="col">Implied YES</th><th scope="col">Quantity</th><th scope="col">Maker</th><th scope="col">Taker</th><th scope="col">Slot</th><th scope="col">Transaction</th></tr></thead>
        <tbody>{state.items.map((trade) => <tr key={tradeKey(trade)}>
          <td>{formatFeathers(trade.yesPrice)} 🪶</td>
          <td>{payoutMilli === undefined ? "Unavailable" : formatImpliedProbability(trade.yesPrice, payoutMilli)}</td>
          <td>{BigInt(trade.quantity).toLocaleString("en-CA")}</td>
          <td><strong>{trade.makerAction} {trade.makerOutcome}</strong><small>Seat {trade.makerSeat} · order {trade.makerOrderId}</small></td>
          <td><strong>{trade.takerAction} {trade.takerOutcome}</strong><small>Seat {trade.takerSeat} · order {trade.takerOrderId}</small></td>
          <td>{trade.slot}</td>
          <td>{isExplorerCluster(explorerCluster) ? <a href={explorerUrl(trade.signature, explorerCluster)} target="_blank" rel="noopener noreferrer" title={trade.signature}>{shortenSignature(trade.signature)}<span className="sr-only"> on Solana Explorer</span></a> : <span title={trade.signature}>{shortenSignature(trade.signature)}</span>}</td>
        </tr>)}</tbody>
      </table>
    </div>}
    {state.nextCursor && !state.error && <button type="button" className={`button button-secondary ${styles.more}`} onClick={onLoadMore} disabled={state.status === "loading-more"}>{state.status === "loading-more" ? "Loading more…" : "Load more verified trades"}</button>}
  </section>;
}

export function ChainTradeTape({ marketId, payoutMilli, explorerCluster }: {
  marketId: string;
  payoutMilli?: string;
  explorerCluster?: ChainExplorerCluster;
}) {
  const marketKey = `${marketId}:${payoutMilli ?? ""}`;
  const initial: ChainTradeTapeState = { marketKey, requestId: 0, status: "loading", items: [], nextCursor: null,
    coverage: null, seenCursors: [], failedCursor: null, error: null };
  const [state, dispatch] = useReducer(chainTradeTapeReducer, initial);
  const request = useRef<{ id: number; controller: AbortController } | null>(null);
  const sequence = useRef(0);
  const valid = canonicalChainMarketId(marketId) && (payoutMilli === undefined || (() => {
    try { parsePayout(payoutMilli); return true; } catch { return false; }
  })());

  const load = useCallback((cursor: string | null, reset = false) => {
    request.current?.controller.abort();
    const id = ++sequence.current;
    const controller = new AbortController();
    request.current = { id, controller };
    if (reset) dispatch({ type: "reset", marketKey, requestId: id });
    dispatch({ type: "start", marketKey, requestId: id, cursor });
    void fetchChainTradePage(marketId, cursor, payoutMilli, controller.signal).then(
      (page) => { if (!controller.signal.aborted) dispatch({ type: "success", marketKey, requestId: id, cursor, page }); },
      () => { if (!controller.signal.aborted) dispatch({ type: "failure", marketKey, requestId: id, cursor }); },
    );
  }, [marketId, marketKey, payoutMilli]);

  useEffect(() => {
    if (!valid) return () => undefined;
    load(null, true);
    return () => request.current?.controller.abort();
  }, [load, valid]);

  if (!valid) return <section className={styles.panel}><h2>On-chain trade tape</h2><p role="alert">Trade activity is unavailable because the canonical market inputs are invalid.</p></section>;
  const displayed = state.marketKey === marketKey ? state : initial;
  return <ChainTradeTapeView state={displayed} payoutMilli={payoutMilli} explorerCluster={explorerCluster}
    onLoadMore={() => displayed.nextCursor && load(displayed.nextCursor)}
    onRetry={() => load(displayed.failedCursor, displayed.failedCursor === null)} />;
}
