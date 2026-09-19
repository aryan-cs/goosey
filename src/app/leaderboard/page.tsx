import Link from "next/link";
import { LivePageRefresh } from "@/components/live-page-refresh";
import { LeaderboardPodium, LeaderboardRow } from "@/components/data-primitives";
import { EmptyState } from "@/components/states";
import { getLeaderboardPage } from "@/lib/leaderboard";

export const dynamic = "force-dynamic";

export default async function LeaderboardPage({ searchParams }: { searchParams: Promise<{ page?: string | string[] }> }) {
  const query = await searchParams;
  const requested = typeof query.page === "string" && /^[1-9]\d{0,5}$/.test(query.page) ? Number(query.page) : 1;
  const { rows, page, totalPages, total } = await getLeaderboardPage(requested, 50);
  const ranked = rows.map((row) => ({ id: row.userId, username: row.username, displayName: row.displayName, score: Number(row.pnlMilli / 1_000n), marketsTraded: row.marketsTraded, rank: row.rank }));
  return <div className="page-shell leaderboard-page">
    <header className="page-header"><span className="eyebrow">Hackathon standings</span><h1>Leaderboard</h1><p>Your rank uses your balance and what your open positions are worth. Starter feathers do not count.</p><LivePageRefresh showButton={false} /></header>
    {ranked.length ? <>
      {page === 1 && <LeaderboardPodium users={ranked.slice(0, 3)} />}
      <section className="leaderboard-table" aria-label="Leaderboard standings">{ranked.map((user) => <LeaderboardRow user={user} key={user.id} />)}</section>
      <nav aria-label="Leaderboard pages" className="pagination">
        {page > 1 && <Link className="button button-secondary" href={`/leaderboard?page=${page - 1}`} rel="prev">Previous</Link>}
        <span>Page {page} of {totalPages} · {total} players</span>
        {page < totalPages && <Link className="button button-secondary" href={`/leaderboard?page=${page + 1}`} rel="next">Next</Link>}
      </nav>
    </> : <EmptyState title="No rankings yet" description="Active players appear here automatically." action={<Link className="button button-primary" href="/signup">Join Goosey</Link>} />}
  </div>;
}
