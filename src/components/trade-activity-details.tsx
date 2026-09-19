import { formatFeathers } from "@/lib/view-models";
import { FeatherIcon } from "./brand";
import styles from "./trade-activity-details.module.css";

export function TradeActivityDetails({ trade }: {
  trade: { action: string; side: string; quantity: number; amountMilli: bigint };
}) {
  return <>
    {trade.action === "BUY" ? "bought" : "sold"} {trade.quantity.toLocaleString("en-CA")} {trade.side} {trade.quantity === 1 ? "share" : "shares"}
    {" · "}<span className={styles.amount} title="Total trade volume, excluding fees"><FeatherIcon />{formatFeathers(trade.amountMilli, 3)}<span className="sr-only"> feathers</span></span> total volume
  </>;
}
