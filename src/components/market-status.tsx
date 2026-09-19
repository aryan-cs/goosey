import styles from "./market-status.module.css";

/** Market states use text color only, without badge fills or decorative icons. */
export function MarketStatusLabel({ status }: { status: string }) {
  const state = status.toLowerCase();
  return <span className={styles.label} data-market-status={state}>{state}</span>;
}
