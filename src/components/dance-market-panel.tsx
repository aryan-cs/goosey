"use client";

import Link from "next/link";
import { useRef, useState } from "react";
import { usePathname } from "next/navigation";
import { MarketActivityRefresh } from "./market-activity-refresh";
import { TradeTicket } from "./trade-ticket";
import { MarketResolutionNote } from "./market-resolution-note";
import styles from "./dance-market-panel.module.css";
import { probabilityBpsToWholePercent } from "@/lib/probability-format";

export interface DanceMarketOption {
  id: string;
  slug: string;
  label: string;
  title: string;
  rules: string;
  status: string;
  resolution: string | null;
  probabilityYesBps: number | null;
  probabilityStale: boolean;
  closesAt: string;
  payoutMilli: string;
  volumeMilli: string;
  acceptingOrders: boolean;
}

interface DanceMarketPanelProps {
  title: string;
  independent?: boolean;
  markets: DanceMarketOption[];
  signedIn: boolean;
  balanceMilli?: string;
  initialSlug?: string;
  initialAction?: "BUY" | "SELL";
}

export function DanceMarketPanel({ title, independent = false, markets, signedIn, balanceMilli, initialSlug, initialAction = "BUY" }: DanceMarketPanelProps) {
  const pathname = usePathname();
  const [selection, setSelection] = useState({ slug: initialSlug ?? markets[0]?.slug, action: initialAction });
  const ticket = useRef<HTMLDivElement>(null);
  const selected = markets.find((market) => market.slug === selection.slug) ?? markets[0];

  function updateSelection(slug: string, action: "BUY" | "SELL") {
    setSelection({ slug, action });
    window.history.replaceState(null, "", `${pathname}?option=${encodeURIComponent(slug)}&action=${action}`);
  }

  function choose(slug: string, action: "BUY" | "SELL") {
    updateSelection(slug, action);
    if (window.matchMedia("(max-width: 900px)").matches) {
      ticket.current?.scrollIntoView({ behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "instant" : "smooth", block: "start" });
      ticket.current?.focus({ preventScroll: true });
    }
  }

  return <div className={styles.panel}>
    <MarketActivityRefresh />
    <header className={styles.header}>
      <span className="eyebrow">Market options</span>
      <h1>{title}</h1>{independent && <p>Each dance is a separate YES/NO market. More than one can win, and later dances count.</p>}
    </header>
    <div className={styles.layout}>
      <div className={styles.main}>
        <section className={styles.options} aria-labelledby="dance-options-heading">
          <div className={styles.sectionHeading}><h2 id="dance-options-heading">Choose an option</h2></div>
          {markets.map((market) => {
            const active = selected?.slug === market.slug;
            const tradable = market.status === "OPEN" && market.acceptingOrders;
            const settled = market.status === "RESOLVED";
            return <article key={market.id} className={`${styles.option} ${active ? styles.selected : ""}`}>
              <div className={styles.optionIdentity}>
                <div><h3>{market.label}</h3><span className={styles.status}>{market.status === "VOID" ? "Voided · contracts pay 50%" : settled ? market.resolution === "YES" ? "Winning option" : "Did not win" : !tradable ? "Trading closed" : market.probabilityStale ? "Last available forecast" : ""}</span></div>
              </div>
              <div className={styles.actions}>
                {(["BUY", "SELL"] as const).map(action => <button key={action} type="button" className={`button ${action === "BUY" ? styles.buy : styles.sell}`} aria-label={`${action === "BUY" ? "Buy" : "Sell"} ${market.label}`} aria-pressed={active && selection.action === action} onClick={() => choose(market.slug, action)} disabled={!tradable || market.probabilityYesBps === null}>
                  <span>{action === "BUY" ? "Buy" : "Sell"}</span>
                  <strong>{market.probabilityYesBps === null || market.status === "VOID" ? "—" : `${probabilityBpsToWholePercent(market.probabilityYesBps)}%`}</strong>
                </button>)}
              </div>
            </article>;
          })}
          {!markets.length && <p className={styles.empty}>These options are not available for trading yet.</p>}
          <p className={styles.note}>Each option has its own quoted price, so the forecasts may not add up to 100%. Selling requires contracts you already own.</p>
        </section>
        <section className={styles.rules} aria-labelledby="dance-rules-heading">
          <span className="eyebrow">How it is decided</span>
          <h2 id="dance-rules-heading">Resolution rules</h2>
          {selected && <><details className={styles.ruleDetails}><summary>{selected.label}: full resolution rules</summary><p className={styles.ruleText}>{selected.rules}</p></details><Link className={styles.detailLink} href={`/markets/${encodeURIComponent(selected.slug)}?details=1#discussion-heading`}>View {selected.label} history and discussion</Link></>}
          <MarketResolutionNote />
        </section>
      </div>
      {selected && <div ref={ticket} className={styles.ticket} tabIndex={-1} aria-label={`Trade ${selected.label}`}>
        {selected.probabilityYesBps === null ? <section className={styles.rules}><h2>{selected.label}</h2><p>No price is available for this option yet. Trading will be available once a forecast can be quoted.</p></section> : <TradeTicket key={`${selected.slug}-${selection.action}`} marketId={selected.slug} marketTitle={selected.title} outcomeLabel={selected.label} onActionChange={(action) => updateSelection(selected.slug, action)} initialAction={selection.action} initialOutcome="YES" yesProbability={selected.probabilityYesBps / 10_000} signedIn={signedIn} balanceMilli={balanceMilli} disabled={selected.status !== "OPEN" || !selected.acceptingOrders} returnTo={`${pathname}?option=${encodeURIComponent(selected.slug)}&action=${selection.action}`} />}
      </div>}
    </div>
  </div>;
}
