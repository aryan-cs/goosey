import Link from "next/link";
import { MarketTradeLink } from "./market-trading-panel";
import styles from "./forecast-choices.module.css";

export function ForecastChoices({ yesBps, orderHrefs, description }: {
  yesBps: number | null;
  orderHrefs?: { YES: string; NO: string };
  description?: string;
}) {
  return <section className={styles.panel} aria-label="Choose a side">
    <h2>Choose a side</h2>
    <div className={styles.choices}>
      {(["YES", "NO"] as const).map((outcome) => {
        const probability = yesBps === null ? null : Math.round((outcome === "YES" ? yesBps : 10_000 - yesBps) / 100);
        const content = <><span>{outcome === "YES" ? "Yes" : "No"}</span><strong className={probability === null ? styles.unpriced : undefined}>{probability === null ? "No price" : `${probability}%`}</strong></>;
        const className = `${styles.choice} ${outcome === "YES" ? styles.yes : styles.no}`;
        return orderHrefs ? <Link key={outcome} className={className} href={orderHrefs[outcome]} aria-label={`Trade ${outcome}`}>{content}</Link>
          : probability !== null ? <MarketTradeLink key={outcome} className={className} outcome={outcome} probability={probability}>{content}</MarketTradeLink>
          : <span key={outcome} className={className}>{content}</span>;
      })}
    </div>
    {description && <p>{description}</p>}
  </section>;
}
