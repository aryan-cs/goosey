import { getServerUser } from "@/lib/server-session";
import { formatFeathers } from "@/lib/view-models";
import styles from "./leaderboard.module.css";
import Link from "next/link";
import { LivePageRefresh } from "@/components/live-page-refresh";
import { LeaderboardPodium, LeaderboardRow } from "@/components/data-primitives";
import { EmptyState } from "@/components/states";
import { PageNavigation } from "@/components/page-navigation";
import { getLeaderboardPage } from "@/lib/leaderboard";
import { LeaderboardFocus } from "./leaderboard-focus";
import { LeaderboardSearch } from "./leaderboard-search";

export const dynamic = "force-dynamic";

export default async function LeaderboardPage({ searchParams }: { searchParams: Promise<{ page?: string | string[]; focus?: string | string[] }> }) {
  const [query, sessionUser] = await Promise.all([searchParams, getServerUser()]);
  const requested = typeof query.page === "string" && /^[1-9]\d{0,5}$/.test(query.page) ? Number(query.page) : 1;
  const { rows, page, totalPages, total, viewer } = await getLeaderboardPage(requested, 50, sessionUser?.id);
  const ranked = rows.map((row) => ({ id: row.userId, username: row.username, displayName: row.displayName, profilePublic: row.profilePublic, score: Number(row.equityMilli) / 1_000, availableBalance: Number(row.cashMilli) / 1_000, marketsTraded: row.marketsTraded, rank: row.rank }));
  const listed = page === 1 ? ranked.filter((user) => user.rank > 3) : ranked;
  const viewerHref = viewer ? `/leaderboard?page=${Math.ceil(viewer.rank / 50)}&focus=${encodeURIComponent(viewer.userId)}#player-${encodeURIComponent(viewer.userId)}` : "";
  return <div className="page-shell leaderboard-page">
    <LeaderboardFocus focusKey={typeof query.focus === "string" ? query.focus : ""} />
    <header className="page-header"><span className="eyebrow">Hackathon standings</span><h1>Leaderboard</h1><p>Total balance includes your available feathers, reserved feathers and open positions. Available is what you can spend now. Rank is based on total portfolio value, highest first, including welcome feathers.</p><LivePageRefresh showButton={false} /></header>
    <div className={viewer ? styles.layout : undefined}>
    {viewer && <aside className={styles.yourRank} aria-labelledby="your-ranking-heading">
      <Link className={styles.yourRankLink} href={viewerHref} aria-label={`Your ranking: ${viewer.rank.toLocaleString()} of ${total.toLocaleString()}. Jump to your position in the leaderboard.`} data-leaderboard-locate>
        <h2 id="your-ranking-heading">Your ranking</h2>
        <p className={styles.rank}>#{viewer.rank.toLocaleString()} <span>of {total.toLocaleString()}</span></p>
        <p className={styles.username}>@{viewer.username}</p>
        <dl><div><dt>Total balance</dt><dd>{formatFeathers(viewer.equityMilli)} feathers</dd></div><div><dt>Available</dt><dd>{formatFeathers(viewer.cashMilli)} feathers</dd></div></dl>
      </Link>
      <LeaderboardSearch />
    </aside>}
    <div className={styles.standings}>
    {ranked.length ? <>
      {page === 1 && <LeaderboardPodium users={ranked.slice(0, 3)} />}
      {listed.length > 0 && <section className="leaderboard-table" aria-label="Leaderboard standings">{listed.map((user) => <div id={`player-${user.id}`} className={styles.player} tabIndex={-1} key={user.id}><LeaderboardRow user={user} /></div>)}</section>}
      <PageNavigation page={page} totalPages={totalPages} totalResults={total} pageSize={50} visibleResults={ranked.length} href={number => `/leaderboard?page=${number}`} label="Leaderboard pages" />
    </> : <EmptyState title="No rankings yet" description="Active players appear here automatically." action={<Link className="button button-primary" href="/signup">Join Goosey</Link>} />}
    </div></div>
  </div>;
}
