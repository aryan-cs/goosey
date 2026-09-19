import styles from "./market-resolution-note.module.css";

export const MARKET_RESOLUTION_NOTE = "Trading stops at the listed close time. Completed trades made before close remain valid and settle under these rules. Orders or trade attempts submitted after close are not accepted; any unfilled order-book reservations are released. If the market is voided, each YES and NO contract pays 50% of the listed winner payout, which may differ from its purchase price.";

export function MarketResolutionNote() {
  return <aside className={styles.note} aria-label="Trading after resolution">
    <strong>After resolution</strong>
    {MARKET_RESOLUTION_NOTE}
  </aside>;
}
