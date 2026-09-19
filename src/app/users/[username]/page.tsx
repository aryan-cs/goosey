import { initials } from "@/lib/initials";
import { notFound } from "next/navigation";
import Link from "next/link";
import { FeatherIcon } from "@/components/brand";
import { db } from "@/lib/db";
import { MetricCard } from "@/components/data-primitives";
import { EmptyState } from "@/components/states";
import { formatFeathers } from "@/lib/view-models";

export const dynamic = "force-dynamic";

export default async function UserProfilePage({ params }: { params: Promise<{ username: string }> }) {
  const { username } = await params;
  const user = await db.user.findUnique({ where: { username: username.toLowerCase() }, include: { _count: { select: { trades: true, comments: { where: { status: "VISIBLE", market: { status: { not: "DRAFT" } } } }, positions: true } }, comments: { where: { status: "VISIBLE", market: { status: { not: "DRAFT" } } }, include: { market: { select: { slug: true, shortTitle: true } } }, orderBy: { createdAt: "desc" }, take: 10 } } });
  if (!user || user.role !== "USER" || !user.profilePublic) notFound();
  return <div className="page-shell profile-page"><header className="profile-header"><div className="profile-avatar" aria-hidden="true">{initials(user.displayName)}</div><div><span className="eyebrow">Public profile</span><h1>{user.displayName}</h1><p className="profile-meta">@{user.username} · Joined <time dateTime={user.createdAt.toISOString()}>{user.createdAt.toLocaleDateString("en-CA", { month: "long", year: "numeric", timeZone: "America/Toronto" })}</time></p>{user.bio && <p className="profile-bio">{user.bio}</p>}</div></header><section className="metric-grid"><MetricCard label="Markets held" value={user._count.positions} /><MetricCard label="Trades" value={user._count.trades} /><MetricCard label="Comments" value={user._count.comments} /><MetricCard label="Profit/loss" value={<><FeatherIcon /> {formatFeathers(user.realizedPnlMilli, 2)}</>} /></section><section><div className="section-heading"><h2>Recent comments</h2></div>{user.comments.length ? <div className="community-feed">{user.comments.map((comment) => <article className="community-post" key={comment.id}><p>{comment.body}</p><footer><Link href={`/markets/${comment.market.slug}`}>{comment.market.shortTitle}</Link><time dateTime={comment.createdAt.toISOString()}>{comment.createdAt.toLocaleDateString("en-CA", { dateStyle: "medium", timeZone: "America/Toronto" })}</time></footer></article>)}</div> : <EmptyState title="No public comments" description="This user has not commented yet." />}</section></div>;
}
