import Link from "next/link";
import { FeatherIcon } from "@/components/brand";
import { formatFeathers } from "@/lib/view-models";
import type { loadTradeHistory } from "@/lib/trade-history";
import styles from "./trade-history.module.css";

export function TradeHistory({ history, olderPage, invalidCursor }: {
  history: Awaited<ReturnType<typeof loadTradeHistory>>;
  olderPage: boolean;
  invalidCursor: boolean;
}) {
  return <div id="trade-history" className={styles.root}>
    {invalidCursor ? <p role="alert">This history link is invalid. <Link href="/portfolio#trade-history">View latest trades</Link>.</p> : <>
      {history.items.length ? <ol className={styles.list} aria-label="Trade history">{history.items.map((trade) => <li className={styles.row} key={trade.id}>
        <div className={styles.market}><Link href={`/markets/${trade.market.slug}`}>{trade.market.shortTitle}</Link><small>{trade.source === "ORDER_BOOK" ? "Order-book fill" : "Market-maker trade"}</small></div>
        <div className={styles.contract}><span className={`side-badge ${trade.side.toLowerCase()}`}>{trade.side}</span><span>{trade.action === "BUY" ? "Bought" : "Sold"} {trade.quantity} contract{trade.quantity === 1 ? "" : "s"}</span></div>
        <div className={styles.amount}><span><FeatherIcon /> {formatFeathers(trade.amountMilli, 3)}</span><small>Gross · fee {formatFeathers(trade.feeMilli, 3)} feathers</small></div>
        <time dateTime={trade.createdAt.toISOString()}>{trade.createdAt.toLocaleString("en-CA", { dateStyle: "medium", timeStyle: "short", timeZone: "America/Toronto" })} ET</time>
      </li>)}</ol> : <p className="muted-copy">{olderPage ? "No older trades." : "No trades yet."}</p>}
      <nav className={styles.navigation} aria-label="Trade history pages">
        {olderPage && <Link className="button button-secondary" href="/portfolio#trade-history">Latest trades</Link>}
        {history.nextCursor && <Link className="button button-secondary" href={`/portfolio?historyCursor=${encodeURIComponent(history.nextCursor)}#trade-history`}>Older trades</Link>}
      </nav>
    </>}
  </div>;
}
