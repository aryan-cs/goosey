import Link from "next/link";
import { SearchLauncher } from "./search-launcher";
import styles from "./market-canvas-toolbar.module.css";

export function MarketCanvasToolbar() {
  return <div className={styles.toolbar}>
    <SearchLauncher className={styles.search}>Search markets</SearchLauncher>
    <Link className={styles.browse} href="/markets">Browse all</Link>
  </div>;
}
