"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import styles from "./settings.module.css";

const sections = ["Profile", "Appearance", "Notifications", "Privacy", "Security"];
export function SettingsNav() {
  const pathname = usePathname();
  const router = useRouter();
  return <nav className={styles.nav} aria-label="Settings">{sections.map((name) => {
    const href = `/settings/${name.toLowerCase()}`;
    return <Link key={name} href={href} aria-current={pathname === href ? "page" : undefined}>{name}</Link>;
  })}<label className={styles.mobileSelect}><span className="sr-only">Settings section</span><select value={pathname} onChange={(event) => router.push(event.target.value)}>{sections.map((name) => <option key={name} value={`/settings/${name.toLowerCase()}`}>{name}</option>)}</select></label></nav>;
}
