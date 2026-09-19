"use client";

import { Award, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useId, useReducer, useRef } from "react";

import styles from "./solana-leaderboard.module.css";

const U64_MAX = (1n << 64n) - 1n;
const MAX_EVENT_WINDOW = 50_000;
const REQUESTED_ROWS = 50;
const BASE58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

export type SolanaLeaderboardCoverage = "unavailable" | "partial" | "bounded_complete";

export type SolanaLeaderboardData = Readonly<{
  metric: "taker_filled_contracts";
  rows: readonly Readonly<{
    rank: number;
    walletAddress: string;
    filledContracts: string;
    filledOrderCommands: string;
    orderCommands: string;
    marketsTraded: number;
  }>[];
  participantCount: number;
  observedOrderEvents: number;
  eventWindow: Readonly<{
    limit: number;
    truncated: boolean;
    semantics: "latest_finalized_order_events";
  }>;
  coverage: Readonly<{
    status: SolanaLeaderboardCoverage;
    coverageStartSignature: string | null;
    headSignature: string | null;
    backfillComplete: boolean;
    revision: number | null;
    updatedAt: string | null;
    fullHistory: false;
  }>;
}>;

export type SolanaLeaderboardState = Readonly<{
  requestId: number;
  loading: boolean;
  data: SolanaLeaderboardData | null;
  error: string | null;
}>;

export type SolanaLeaderboardAction =
  | Readonly<{ type: "start"; requestId: number }>
  | Readonly<{ type: "success"; requestId: number; data: SolanaLeaderboardData }>
  | Readonly<{ type: "failure"; requestId: number; error: string }>;

export class SolanaLeaderboardReadError extends Error {
  constructor(message: string, readonly kind: "unavailable" | "rate-limited" | "invalid" | "failed" = "failed") {
    super(message);
    this.name = "SolanaLeaderboardReadError";
  }
}

function record(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]) {
  const actual = Object.keys(value);
  return actual.length === keys.length && actual.every(key => keys.includes(key));
}

function safeNonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function canonicalU64(value: unknown, positive = false): value is string {
  if (typeof value !== "string" || !/^(0|[1-9][0-9]{0,19})$/.test(value)) return false;
  const parsed = BigInt(value);
  return parsed <= U64_MAX && (!positive || parsed > 0n);
}

function decodedBase58Length(value: unknown): number | null {
  if (typeof value !== "string" || value.length === 0 || value.length > 128) return null;
  const bytes: number[] = [0];
  for (const character of value) {
    const digit = BASE58.indexOf(character);
    if (digit < 0) return null;
    let carry = digit;
    for (let index = 0; index < bytes.length; index += 1) {
      carry += bytes[index]! * 58;
      bytes[index] = carry & 0xff;
      carry >>= 8;
    }
    while (carry > 0) {
      bytes.push(carry & 0xff);
      carry >>= 8;
    }
  }
  let leadingZeroes = 0;
  while (leadingZeroes < value.length && value[leadingZeroes] === "1") leadingZeroes += 1;
  const significantBytes = bytes.length === 1 && bytes[0] === 0 ? 0 : bytes.length;
  return leadingZeroes + significantBytes;
}

function walletAddress(value: unknown): value is string {
  return decodedBase58Length(value) === 32;
}

function transactionSignature(value: unknown): value is string {
  return decodedBase58Length(value) === 64;
}

function canonicalTimestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value;
}

function invalidResponse(): never {
  throw new SolanaLeaderboardReadError("The finalized-chain leaderboard response could not be verified.", "invalid");
}

export function parseSolanaLeaderboard(value: unknown): SolanaLeaderboardData {
  if (!record(value) || !exactKeys(value, ["metric", "rows", "participantCount", "observedOrderEvents", "eventWindow", "coverage"])
    || value.metric !== "taker_filled_contracts" || !Array.isArray(value.rows) || value.rows.length > REQUESTED_ROWS
    || !safeNonNegativeInteger(value.participantCount) || value.participantCount < value.rows.length
    || (value.participantCount === 0) !== (value.rows.length === 0)
    || !safeNonNegativeInteger(value.observedOrderEvents) || !record(value.eventWindow)
    || !exactKeys(value.eventWindow, ["limit", "truncated", "semantics"])
    || !Number.isSafeInteger(value.eventWindow.limit) || (value.eventWindow.limit as number) < 1
    || (value.eventWindow.limit as number) > MAX_EVENT_WINDOW || typeof value.eventWindow.truncated !== "boolean"
    || value.eventWindow.semantics !== "latest_finalized_order_events"
    || value.observedOrderEvents > (value.eventWindow.limit as number)
    || (value.eventWindow.truncated && value.observedOrderEvents !== value.eventWindow.limit)) invalidResponse();

  const seenWallets = new Set<string>();
  let previous: { filled: bigint; wallet: string } | null = null;
  let representedOrderCommands = 0n;
  for (let index = 0; index < value.rows.length; index += 1) {
    const row = value.rows[index];
    if (!record(row) || !exactKeys(row, ["rank", "walletAddress", "filledContracts", "filledOrderCommands", "orderCommands", "marketsTraded"])
      || row.rank !== index + 1 || !walletAddress(row.walletAddress) || seenWallets.has(row.walletAddress)
      || !canonicalU64(row.filledContracts, true) || !canonicalU64(row.filledOrderCommands, true)
      || !canonicalU64(row.orderCommands, true) || BigInt(row.filledOrderCommands) > BigInt(row.orderCommands)
      || !Number.isSafeInteger(row.marketsTraded) || (row.marketsTraded as number) < 1
      || (row.marketsTraded as number) > Number(BigInt(row.filledOrderCommands))) invalidResponse();
    const current = { filled: BigInt(row.filledContracts), wallet: row.walletAddress };
    if (previous && (current.filled > previous.filled
      || (current.filled === previous.filled && current.wallet < previous.wallet))) invalidResponse();
    previous = current;
    seenWallets.add(row.walletAddress);
    representedOrderCommands += BigInt(row.orderCommands);
  }
  if (representedOrderCommands > BigInt(value.observedOrderEvents)) invalidResponse();

  const coverage = value.coverage;
  if (!record(coverage) || !exactKeys(coverage, ["status", "coverageStartSignature", "headSignature", "backfillComplete", "revision", "updatedAt", "fullHistory"])
    || !["unavailable", "partial", "bounded_complete"].includes(String(coverage.status))
    || coverage.fullHistory !== false || typeof coverage.backfillComplete !== "boolean") invalidResponse();
  if (coverage.status === "unavailable") {
    if (coverage.coverageStartSignature !== null || coverage.headSignature !== null || coverage.backfillComplete
      || coverage.revision !== null || coverage.updatedAt !== null || value.rows.length !== 0
      || value.participantCount !== 0 || value.observedOrderEvents !== 0 || value.eventWindow.truncated) invalidResponse();
  } else {
    if (!transactionSignature(coverage.coverageStartSignature)
      || !(coverage.headSignature === null || transactionSignature(coverage.headSignature))
      || !safeNonNegativeInteger(coverage.revision) || !canonicalTimestamp(coverage.updatedAt)
      || coverage.backfillComplete !== (coverage.status === "bounded_complete")
      || (coverage.status === "bounded_complete" && coverage.headSignature === null)) invalidResponse();
  }
  return value as SolanaLeaderboardData;
}

function hasNoStore(response: Response) {
  return (response.headers.get("cache-control") ?? "").split(",")
    .some(directive => directive.trim().toLowerCase() === "no-store");
}

export async function fetchSolanaLeaderboard(
  signal: AbortSignal,
  fetcher: typeof fetch = fetch,
): Promise<SolanaLeaderboardData> {
  const response = await fetcher(`/api/solana/leaderboard?limit=${REQUESTED_ROWS}`, {
    method: "GET",
    credentials: "same-origin",
    cache: "no-store",
    headers: { Accept: "application/json" },
    signal,
  });
  if (!hasNoStore(response)) {
    throw new SolanaLeaderboardReadError("The leaderboard response allowed caching.", "invalid");
  }
  if (!response.ok) {
    if (response.status === 429) throw new SolanaLeaderboardReadError("Leaderboard refreshes are temporarily rate limited.", "rate-limited");
    if (response.status === 503) throw new SolanaLeaderboardReadError("The finalized-chain leaderboard is unavailable.", "unavailable");
    throw new SolanaLeaderboardReadError("The finalized-chain leaderboard could not be loaded.");
  }
  const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
  if (!contentType.startsWith("application/json")) {
    throw new SolanaLeaderboardReadError("The leaderboard response was not JSON.", "invalid");
  }
  try {
    return parseSolanaLeaderboard(await response.json());
  } catch (error) {
    if (error instanceof SolanaLeaderboardReadError) throw error;
    throw new SolanaLeaderboardReadError("The finalized-chain leaderboard response could not be verified.", "invalid");
  }
}

export function solanaLeaderboardReducer(
  state: SolanaLeaderboardState,
  action: SolanaLeaderboardAction,
): SolanaLeaderboardState {
  if (action.type === "start") return {
    requestId: action.requestId,
    loading: true,
    data: state.error ? null : state.data,
    error: null,
  };
  if (action.requestId !== state.requestId) return state;
  if (action.type === "success") return { requestId: state.requestId, loading: false, data: action.data, error: null };
  return { requestId: state.requestId, loading: false, data: null, error: action.error };
}

export function abbreviateWallet(value: string) {
  if (!walletAddress(value)) throw new Error("Invalid wallet address");
  return `${value.slice(0, 4)}…${value.slice(-4)}`;
}

function CoverageNotice({ data }: Readonly<{ data: SolanaLeaderboardData }>) {
  const copy = data.coverage.status === "unavailable"
    ? "Coverage unavailable. No finalized indexed window is available."
    : data.coverage.status === "partial"
      ? "Partial indexed coverage. Backfill is still in progress, so older finalized activity may be omitted."
      : "Bounded indexed window complete. The retained window is indexed, but this is not full chain history.";
  return <div className={`${styles.coverage} ${styles[data.coverage.status]}`} role="status">
    <strong>{data.coverage.status === "bounded_complete" ? "Bounded coverage" : data.coverage.status === "partial" ? "Partial coverage" : "Coverage unavailable"}</strong>
    <span>{copy}</span>
    {data.eventWindow.truncated ? <span className={styles.truncated}>Truncated to the latest {data.eventWindow.limit.toLocaleString("en-CA")} finalized order events.</span> : null}
  </div>;
}

function WalletLabel({ value }: Readonly<{ value: string }>) {
  return <code className={styles.wallet} title={value}>
    <span aria-hidden="true">{abbreviateWallet(value)}</span>
    <span className={styles.srOnly}>{value}</span>
  </code>;
}

export function SolanaLeaderboardView({
  state,
  onRetry,
}: Readonly<{ state: SolanaLeaderboardState; onRetry: () => void }>) {
  const headingId = useId();
  return <section className={styles.card} aria-labelledby={headingId} aria-busy={state.loading}>
    <header className={styles.header}>
      <div>
        <span className={styles.eyebrow}>Finalized Solana activity</span>
        <h2 id={headingId}>Taker filled contracts</h2>
        <p>Wallets ranked by contracts filled by their submitted orders in the observed finalized event window.</p>
      </div>
      <Award className={styles.mark} size={26} aria-hidden="true" />
    </header>

    {state.loading && state.data === null ? <div className={styles.loading} role="status">
      <span className={styles.spinner} aria-hidden="true" /> Loading finalized activity…
    </div> : null}

    {state.error ? <div className={styles.error} role="alert">
      <div><strong>Could not verify finalized activity</strong><p>{state.error}</p></div>
      <button type="button" onClick={onRetry} disabled={state.loading}>Retry leaderboard</button>
    </div> : null}

    {state.data ? <>
      <CoverageNotice data={state.data} />
      {state.data.rows.length > 0 ? <div className={styles.tableFrame}>
        <table>
          <caption className={styles.srOnly}>Wallets ranked by observed taker filled contracts</caption>
          <thead><tr><th scope="col">Rank</th><th scope="col">Wallet</th><th scope="col">Filled contracts</th><th scope="col">Filled orders</th><th scope="col">Markets</th></tr></thead>
          <tbody>{state.data.rows.map(row => <tr key={row.walletAddress}>
            <td data-label="Rank"><span className={styles.rank}>{row.rank}</span></td>
            <td data-label="Wallet"><WalletLabel value={row.walletAddress} /></td>
            <td data-label="Filled contracts" className={styles.primaryMetric}>{BigInt(row.filledContracts).toLocaleString("en-CA")}</td>
            <td data-label="Filled orders">{BigInt(row.filledOrderCommands).toLocaleString("en-CA")}</td>
            <td data-label="Markets">{row.marketsTraded.toLocaleString("en-CA")}</td>
          </tr>)}</tbody>
        </table>
      </div> : <div className={styles.empty} role="status">
        <strong>No observed taker fills</strong>
        <p>No wallet has a taker fill in the currently indexed finalized window.</p>
      </div>}
      <footer className={styles.footer}>
        <p>{state.data.observedOrderEvents.toLocaleString("en-CA")} finalized order events observed · {state.data.participantCount.toLocaleString("en-CA")} qualifying wallets · fullHistory: false</p>
        <button type="button" onClick={onRetry} disabled={state.loading}>
          <RefreshCw size={14} aria-hidden="true" /> {state.loading ? "Refreshing…" : "Refresh"}
        </button>
      </footer>
    </> : null}
  </section>;
}

export function SolanaLeaderboard() {
  const [state, dispatch] = useReducer(solanaLeaderboardReducer, {
    requestId: 0,
    loading: true,
    data: null,
    error: null,
  });
  const active = useRef<{ requestId: number; controller: AbortController } | null>(null);
  const nextRequestId = useRef(0);

  const load = useCallback(() => {
    active.current?.controller.abort();
    const requestId = ++nextRequestId.current;
    const controller = new AbortController();
    active.current = { requestId, controller };
    dispatch({ type: "start", requestId });
    void fetchSolanaLeaderboard(controller.signal).then(
      data => dispatch({ type: "success", requestId, data }),
      (error: unknown) => {
        if (controller.signal.aborted) return;
        const message = error instanceof SolanaLeaderboardReadError
          ? error.message
          : "The finalized-chain leaderboard could not be loaded.";
        dispatch({ type: "failure", requestId, error: message });
      },
    );
  }, []);

  useEffect(() => {
    load();
    return () => active.current?.controller.abort();
  }, [load]);

  return <SolanaLeaderboardView state={state} onRetry={load} />;
}
