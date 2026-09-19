import Link from "next/link";
import { ArrowLeft, ArrowRight } from "lucide-react";
import styles from "./page-navigation.module.css";

export function PageNavigation({ page, totalPages, href, label }: {
  page: number;
  totalPages: number;
  href: (page: number) => string;
  label: string;
}) {
  if (totalPages <= 1) return null;
  return <nav className={styles.navigation} aria-label={label}>
    {page > 1
      ? <Link className={`button button-secondary ${styles.arrow}`} href={href(page - 1)} rel="prev" aria-label="Previous page"><ArrowLeft aria-hidden="true" /></Link>
      : <button className={`button button-secondary ${styles.arrow}`} type="button" disabled aria-label="Previous page"><ArrowLeft aria-hidden="true" /></button>}
    {page < totalPages
      ? <Link className={`button button-secondary ${styles.arrow}`} href={href(page + 1)} rel="next" aria-label="Next page"><ArrowRight aria-hidden="true" /></Link>
      : <button className={`button button-secondary ${styles.arrow}`} type="button" disabled aria-label="Next page"><ArrowRight aria-hidden="true" /></button>}
  </nav>;
}
