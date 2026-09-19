import Link from "next/link";
import { ChevronLeft, ChevronRight } from "lucide-react";
import styles from "./page-navigation.module.css";

export function PageNavigation({ page, totalPages, totalResults, pageSize, visibleResults, href, label }: {
  page: number;
  totalPages: number;
  totalResults: number;
  pageSize: number;
  visibleResults: number;
  href: (page: number) => string;
  label: string;
}) {
  if (totalResults <= 0 || visibleResults <= 0) return null;
  const firstResult = (page - 1) * pageSize + 1;
  const lastResult = firstResult + visibleResults - 1;
  return <nav className={styles.navigation} aria-label={label}>
    {page > 1
      ? <Link className={styles.arrow} href={href(page - 1)} rel="prev" aria-label="Previous page"><ChevronLeft aria-hidden="true" /></Link>
      : <button className={styles.arrow} type="button" disabled aria-label="Previous page"><ChevronLeft aria-hidden="true" /></button>}
    <span className={styles.status} aria-live="polite">
      <strong>{firstResult.toLocaleString()}–{lastResult.toLocaleString()}</strong> of {totalResults.toLocaleString()}
      <small>Page {page.toLocaleString()} of {totalPages.toLocaleString()}</small>
    </span>
    {page < totalPages
      ? <Link className={styles.arrow} href={href(page + 1)} rel="next" aria-label="Next page"><ChevronRight aria-hidden="true" /></Link>
      : <button className={styles.arrow} type="button" disabled aria-label="Next page"><ChevronRight aria-hidden="true" /></button>}
  </nav>;
}
