"use client";

import Link from "next/link";
import { useState, type CSSProperties, type MouseEvent, type ReactNode } from "react";
import styles from "./portfolio.module.css";

export type PortfolioView = "positions" | "orders" | "history";

const views: Array<{ id: PortfolioView; label: string }> = [
  { id: "positions", label: "Positions" },
  { id: "orders", label: "Orders" },
  { id: "history", label: "History" },
];

export function portfolioViewDirection(from: PortfolioView, to: PortfolioView) {
  return Math.sign(views.findIndex((item) => item.id === to) - views.findIndex((item) => item.id === from));
}

export function PortfolioSwitcher({ view, children }: { view: PortfolioView; children: ReactNode }) {
  const [pendingView, setPendingView] = useState<{ from: PortfolioView; to: PortfolioView } | null>(null);
  const visualView = pendingView?.from === view ? pendingView.to : view;
  const direction = pendingView?.to === view ? portfolioViewDirection(pendingView.from, view) : 0;

  const activeIndex = views.findIndex((item) => item.id === visualView);
  const tabStyle = {
    "--portfolio-tab-count": views.length,
    "--portfolio-tab-index": activeIndex,
  } as CSSProperties;

  const selectView = (event: MouseEvent<HTMLAnchorElement>, nextView: PortfolioView) => {
    if (event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey) {
      setPendingView({ from: view, to: nextView });
    }
  };

  return <>
    <nav className={styles.tabs} style={tabStyle} aria-label="Portfolio views">
      <span className={styles.tabIndicator} aria-hidden="true" />
      {views.map((item) => <Link key={item.id} href={`/portfolio?view=${item.id}`} scroll={false} aria-current={view === item.id ? "page" : undefined} onClick={(event) => selectView(event, item.id)}>{item.label}</Link>)}
    </nav>
    <div className={styles.viewViewport}>
      <div key={view} className={`${styles.viewPanel} ${direction > 0 ? styles.viewPanelForward : direction < 0 ? styles.viewPanelBackward : ""}`}>
        {children}
      </div>
    </div>
  </>;
}
