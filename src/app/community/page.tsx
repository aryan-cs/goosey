import { LivePageRefresh } from "@/components/live-page-refresh";
import { initials } from "@/lib/initials";
import Link from "next/link";
import { MessageCircle } from "lucide-react";
import { EmptyState } from "@/components/states";
import { getCommunityFeed } from "@/lib/community-feed";
import { ApiError } from "@/lib/market-service";
import { UserProfileLink } from "@/components/user-profile-link";
import { LocalTime } from "@/components/local-time";

export const dynamic = "force-dynamic";

export default async function CommunityPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const params = await searchParams;
  const cursor = typeof params.cursor === "string" ? params.cursor : undefined;
  let feed;
  try {
    if (Array.isArray(params.cursor)) throw new ApiError(400, "INVALID_CURSOR", "Invalid community cursor.");
    feed = await getCommunityFeed(cursor);
  } catch (error) {
    if (!(error instanceof ApiError) || error.code !== "INVALID_CURSOR") throw error;
    return <div className="page-shell community-page"><h1>Community</h1><EmptyState title="This discussion link is no longer valid" description="Return to the latest posts to keep browsing." action={<Link className="button button-primary" href="/community">Latest discussions</Link>} /></div>;
  }
  const comments = feed.items;
  return <div className="page-shell community-page">
    <header className="page-header"><span className="eyebrow">Community</span><h1>What people are saying</h1><p>Public market discussions. Updates every 15 seconds while this page is open.</p><LivePageRefresh showButton={false} /></header>
    {cursor && <p><Link className="button button-secondary" href="/community">Latest discussions</Link></p>}
    {comments.length ? <div className="community-feed">{comments.map((comment) => <article className="community-post" key={comment.id}>
      <header><span className="leader-avatar" aria-hidden="true">{initials(comment.user.displayName)}</span><div><UserProfileLink username={comment.user.username}><strong>{comment.user.displayName}</strong><small>@{comment.user.username}</small></UserProfileLink><small><LocalTime value={comment.createdAt} preset="medium" /></small></div></header>
      <p>{comment.body}</p>
      <footer><MessageCircle aria-hidden="true" /><Link href={`/markets/${encodeURIComponent(comment.market.slug)}?comment=${encodeURIComponent(comment.id)}#discussion-heading`}>{comment.market.shortTitle}</Link></footer>
    </article>)}</div> : <EmptyState title={cursor ? "No older discussions" : "No comments yet"} description={cursor ? "That's all the posts for now." : "Pick a market and tell us what you think."} action={<Link className="button button-primary" href={cursor ? "/community" : "/markets"}>{cursor ? "Latest discussions" : "Browse markets"}</Link>} />}
    {feed.nextCursor && <nav aria-label="Community pagination"><p><Link className="button button-secondary" href={`/community?cursor=${encodeURIComponent(feed.nextCursor)}`}>Older discussions</Link></p></nav>}
  </div>;
}
