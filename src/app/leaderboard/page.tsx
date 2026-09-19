import Link from "next/link";
import { LivePageRefresh } from "@/components/live-page-refresh";
import { LeaderboardPodium, LeaderboardRow } from "@/components/data-primitives";
import { EmptyState } from "@/components/states";
import { getLeaderboardRows } from "@/lib/leaderboard";

export const dynamic = "force-dynamic";

export default async function LeaderboardPage() {
  const rows = await getLeaderboardRows(100);
  const ranked = rows.map((row) => ({ id: row.userId, username: row.username, displayName: row.displayName, score: Number(row.pnlMilli / 1_000n), marketsTraded: row.marketsTraded, rank: row.rank }));
  return <div className="page-shell leaderboard-page"><header className="page-header"><span className="eyebrow">Hackathon standings</span><h1>Leaderboard</h1><p>Your rank uses your balance and what your open positions are worth. Starter feathers do not count. Rankings are opt-in and refresh every 15 seconds.</p><LivePageRefresh /></header>{ranked.length ? <><LeaderboardPodium users={ranked.slice(0, 3)} /><section className="leaderboard-table" aria-label="Leaderboard standings">{ranked.map((user) => <LeaderboardRow user={user} key={user.id} />)}</section></> : <EmptyState title="No rankings yet" description="Rankings include players who enable leaderboard visibility in Privacy settings." action={<Link className="button button-primary" href="/settings/privacy">Leaderboard privacy settings</Link>} />}</div>;
}
