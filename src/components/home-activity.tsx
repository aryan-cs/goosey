import Link from "next/link";
import type { PublicTradeActivity } from "@/lib/public-trade-activity";
import { formatFeathers } from "@/lib/view-models";
import { FeatherIcon } from "./brand";
import { RelativeLocalTime } from "./local-time";
import styles from "./home-activity.module.css";
import { UserProfileLink } from "./user-profile-link";

export function HomeActivity({ trades, now = new Date() }: { trades: PublicTradeActivity[]; now?: Date }) {
  return <ul className={styles.list}>{trades.map(trade => <li key={trade.id} className={styles.item}>
    <RelativeLocalTime className={styles.time} value={trade.createdAt} now={now} />
    <Link className={styles.market} href={`/markets/${trade.market.slug}`}>{trade.market.shortTitle}</Link>
    <UserProfileLink className={styles.user} username={trade.user.username} title={`View @${trade.user.username}'s profile`}>@{trade.user.username}</UserProfileLink>
    <div className={styles.trade}>
      <span><strong className={trade.action === "BUY" ? styles.yes : styles.no}>{trade.action === "BUY" ? "Bought" : "Sold"}</strong>{" "}{trade.quantity.toLocaleString("en-CA")}{" "}<strong className={trade.side === "YES" ? styles.yes : trade.side === "NO" ? styles.no : undefined}>{trade.side}</strong>{" "}{trade.quantity === 1 ? "share" : "shares"}</span>
      <span className={styles.amount} title="Total trade volume, excluding fees"><FeatherIcon />{formatFeathers(trade.amountMilli)}<span className="sr-only"> feathers total volume</span></span>
    </div>
  </li>)}</ul>;
}
