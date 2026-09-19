import Link from "next/link";
import { ArrowLeft, Feather } from "lucide-react";

import { SolanaLeaderboard } from "@/components/solana-leaderboard";

import styles from "./page.module.css";

export const dynamic = "force-dynamic";
export const metadata = { title: "On-chain leaderboard · Goosey" };

export default function ChainLeaderboardPage() {
  return <div className={`page-shell ${styles.page}`}>
    <header className={styles.header}>
      <div>
        <p className={styles.eyebrow}><Feather size={15} aria-hidden="true" /> Goosey on Solana</p>
        <h1>On-chain leaderboard</h1>
        <p>Finalized wallet activity from Goosey&apos;s free-feather order books. This ranking is separate from the app balance leaderboard and never represents cash value.</p>
      </div>
      <Link className="button button-secondary" href="/leaderboard"><ArrowLeft size={17} aria-hidden="true" /> App standings</Link>
    </header>
    <SolanaLeaderboard />
    <p className={styles.disclosure}>Only verified indexed events are counted. Partial or bounded coverage is shown explicitly; Goosey never fills missing history with estimates.</p>
  </div>;
}
