import Link from "next/link";
import { LivePageRefresh } from "@/components/live-page-refresh";
import { LeaderboardPodium, LeaderboardRow } from "@/components/data-primitives";
import { EmptyState } from "@/components/states";
import { getLeaderboardPage } from "@/lib/leaderboard";

export const dynamic = "force-dynamic";

export default async function LeaderboardPage({ searchParams }: { searchParams: Promise<{ page?: string | string[] }> }) {
  const query = await searchParams;
  const requested = typeof query.page === "string" && /^[1-9]\d{0,5}$/.test(query.page) ? Number(query.page) : 1;
  const { rows, page, totalPages } = await getLeaderboardPage(requested, 50);
  const ranked = rows.map((row) => ({ id: row.userId, username: row.username, displayName: row.displayName, profilePublic: row.profilePublic, score: Number(row.equityMilli) / 1_000, availableBalance: Number(row.cashMilli) / 1_000, marketsTraded: row.marketsTraded, rank: row.rank }));
  return <div className="page-shell leaderboard-page">
    <header className="page-header"><span className="eyebrow">Hackathon standings</span><h1>Leaderboard</h1><p>Total balance includes your available feathers, reserved feathers and open positions. Available is what you can spend now. Rank is based on total portfolio value, highest first, including welcome feathers.</p><LivePageRefresh showButton={false} /></header>
    {ranked.length ? <>
      {page === 1 && <LeaderboardPodium users={ranked.slice(0, 3)} />}
      <section className="leaderboard-table" aria-label="Leaderboard standings">{ranked.map((user) => <LeaderboardRow user={user} key={user.id} />)}</section>
      {totalPages > 1 && <nav aria-label="Leaderboard pages" className="pagination">
        {page > 1 && <Link className="button button-secondary" href={`/leaderboard?page=${page - 1}`} rel="prev">Previous</Link>}
        {page < totalPages && <Link className="button button-secondary" href={`/leaderboard?page=${page + 1}`} rel="next">Next</Link>}
      </nav>}
    </> : <EmptyState title="No rankings yet" description="Active players appear here automatically." action={<Link className="button button-primary" href="/signup">Join Goosey</Link>} />}
  </div>;
}
