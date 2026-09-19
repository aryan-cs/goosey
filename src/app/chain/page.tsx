import Link from "next/link";
import { ArrowRight, Feather, ShieldCheck, Wallet } from "lucide-react";
import { ApiError } from "@/lib/market-service";
import { parseSolanaCatalogQuery, readSolanaCatalog } from "@/lib/solana/catalog-read";
import { resolveSolanaRuntime } from "@/lib/solana/runtime";
import { EmptyState } from "@/components/states";
import styles from "./page.module.css";

export const dynamic = "force-dynamic";
export const metadata = { title: "On-chain markets · Goosey" };
type Catalog = Awaited<ReturnType<typeof readSolanaCatalog>>;
function feathers(units: bigint) {
  const fraction = (units % 1000n).toString().padStart(3, "0").replace(/0+$/, "");
  return `${(units / 1000n).toLocaleString("en-CA")}${fraction ? `.${fraction}` : ""}`;
}

export default async function ChainDirectory({ searchParams }: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  let catalog: Catalog | undefined, network: "localnet" | "devnet" | undefined;
  let message = "The on-chain directory is not enabled yet. Your wallet and existing markets remain separate.";
  let invalidQuery = false;
  if (process.env.GOOSEY_SOLANA_CATALOG_ENABLED === "true") {
    try {
      const query = parseSolanaCatalogQuery(params);
      const runtime = resolveSolanaRuntime(); network = runtime.cluster;
      catalog = await readSolanaCatalog(runtime, query);
    } catch (error) {
      invalidQuery = error instanceof ApiError && ["INVALID_QUERY", "INVALID_CURSOR"].includes(error.code);
      message = invalidQuery ? "This directory link has an invalid page cursor or filter. Start again from the first page."
        : "The on-chain directory could not be loaded. No cached or database-market substitutes are being shown.";
    }
  }

  return <div className={`page-shell ${styles.page}`}>
    <header className={styles.header}>
      <div><p className={styles.eyebrow}><Feather size={15} aria-hidden="true" /> Goosey on Solana</p>
        <h1>On-chain markets</h1><p className={styles.intro}>Campus questions. Wallet-signed trades. Free feathers, never cash.</p></div>
      <Link className="button button-secondary" href="/wallet"><Wallet size={17} aria-hidden="true" /> Your wallet</Link>
    </header>
    <aside className={styles.notice} aria-label="How on-chain markets work">
      <ShieldCheck size={21} aria-hidden="true" /><p>These markets use their own Solana balances and order books.
        Open a market to verify its rules, current prices and trading status before signing.
        {network && <span className={styles.network}>{network === "localnet" ? "Local network" : "Solana devnet"} · No cash redemption</span>}</p>
    </aside>
    {!catalog ? <EmptyState title={invalidQuery ? "Invalid directory link" : "Directory unavailable"} description={message}
      action={<Link className="button button-secondary" href="/chain">Reload directory</Link>} />
      : catalog.items.length === 0 ? <EmptyState title="No published on-chain markets" description="Reviewed markets will appear here once published. No sample markets or synthetic prices are shown."
        action={<Link className="button button-secondary" href="/markets">Browse existing markets</Link>} />
        : <section className={styles.grid} aria-label="Published on-chain markets">{catalog.items.map(item => <article className={styles.card} key={`${item.chain.genesisHash}:${item.chain.marketAddress}`}>
          <div className={styles.category}><span>{item.category}</span><span>On-chain</span></div>
          <h2><Link href={item.href}>{item.title}</Link></h2>
          <p className={styles.description}>{item.description}</p>
          <dl className={styles.details}><div><dt>Winning contract payout</dt><dd>{feathers(item.payoutMilli)} 🪶</dd></div>
            <div><dt>Scheduled close</dt><dd><time dateTime={item.closesAt.toISOString()}>{item.closesAt.toLocaleString("en-CA", { timeZone: "America/Toronto", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })} ET</time></dd></div></dl>
          <Link className={styles.marketLink} href={item.href}>View verified market <ArrowRight size={16} aria-hidden="true" /></Link>
        </article>)}</section>}
    <nav className={styles.pagination} aria-label="Directory pages">
      {params.cursor && <Link href="/chain">First page</Link>}
      {catalog?.nextCursor && <Link className="button button-secondary" href={`/chain?cursor=${encodeURIComponent(catalog.nextCursor)}`}>More markets <ArrowRight size={16} aria-hidden="true" /></Link>}
    </nav>
    <p className={styles.footer}>Feathers are free play tokens. Transfers, trades and outcome payouts do not provide money or cash redemption.</p>
  </div>;
}
