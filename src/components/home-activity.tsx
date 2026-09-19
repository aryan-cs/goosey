import Link from "next/link";
import { formatFeathers } from "@/lib/view-models";
import { FeatherIcon } from "./brand";
import styles from "./home-activity.module.css";

export function HomeActivity({ trades }: { trades: Array<{
  id: string;
  action: string;
  side: string;
  quantity: number;
  amountMilli: bigint;
  user: { username: string | null; profilePublic: boolean };
  market: { slug: string; shortTitle: string };
}> }) {
  return <ul className={styles.list}>{trades.map(trade => <li key={trade.id} className={styles.item}>
    <Link className={styles.market} href={`/markets/${trade.market.slug}`}>{trade.market.shortTitle}</Link>
    <span className={styles.user} title={trade.user.profilePublic && trade.user.username ? `@${trade.user.username}` : undefined}>{trade.user.profilePublic && trade.user.username ? `@${trade.user.username}` : "Someone"}</span>
    <div className={styles.trade}>
      <span><strong className={trade.action === "BUY" ? styles.yes : styles.no}>{trade.action === "BUY" ? "Bought" : "Sold"}</strong>{" "}{trade.quantity.toLocaleString("en-CA")}{" "}<strong className={trade.side === "YES" ? styles.yes : trade.side === "NO" ? styles.no : undefined}>{trade.side}</strong>{" "}{trade.quantity === 1 ? "share" : "shares"}</span>
      <span className={styles.amount} title="Total trade volume, excluding fees"><FeatherIcon />{formatFeathers(trade.amountMilli, 3)}<span className="sr-only"> feathers total volume</span></span>
    </div>
  </li>)}</ul>;
}
