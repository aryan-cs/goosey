import Link from "next/link";
import { MessageCircle } from "lucide-react";
import { db } from "@/lib/db";
import { EmptyState } from "@/components/states";

export const dynamic = "force-dynamic";

export default async function CommunityPage() {
  const comments = await db.comment.findMany({ where: { status: "VISIBLE", user: { profilePublic: true }, market: { status: { not: "DRAFT" } } }, include: { user: { select: { username: true, displayName: true } }, market: { select: { slug: true, shortTitle: true } } }, orderBy: { createdAt: "desc" }, take: 50 });
  return <div className="page-shell community-page"><header className="page-header"><span className="eyebrow">Community</span><h1>What people are saying</h1><p>See what people think about current markets and why.</p></header>{comments.length ? <div className="community-feed">{comments.map((comment) => <article className="community-post" key={comment.id}><header><span className="leader-avatar" aria-hidden="true">{comment.user.displayName.slice(0, 2).toUpperCase()}</span><div><strong><Link href={`/users/${encodeURIComponent(comment.user.username)}`}>{comment.user.displayName}</Link></strong><small>@{comment.user.username} · <time dateTime={comment.createdAt.toISOString()}>{comment.createdAt.toLocaleString("en-CA", { dateStyle: "medium", timeStyle: "short", timeZone: "America/Toronto" })}</time></small></div></header><p>{comment.body}</p><footer><MessageCircle aria-hidden="true" /><Link href={`/markets/${comment.market.slug}`}>{comment.market.shortTitle}</Link></footer></article>)}</div> : <EmptyState title="No comments yet" description="Join a market discussion to get things started." action={<Link className="button button-primary" href="/markets">Browse markets</Link>} />}</div>;
}
