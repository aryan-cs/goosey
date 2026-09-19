import Link from "next/link";
import styles from "./market-canvas-toolbar.module.css";

export function MarketCanvasToolbar() {
  return <div className={styles.toolbar}>
    <Link className={styles.search} href="/search">Search markets</Link>
    <Link className={styles.browse} href="/markets">Browse all</Link>
  </div>;
}
