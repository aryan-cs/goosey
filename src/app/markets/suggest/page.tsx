import Link from "next/link";
import { redirect } from "next/navigation";
import { SuggestionForm } from "@/components/suggestion-form";
import { EmptyState } from "@/components/states";
import { getServerUser } from "@/lib/server-session";
import { db } from "@/lib/db";
import { requiresEmailVerification } from "@/lib/auth";

export const dynamic = "force-dynamic";

export default async function SuggestMarketPage() {
  const user = await getServerUser();
  if (!user) return <div className="page-shell centered-state"><EmptyState title="Sign in to suggest a market" description="Sign in so we can follow up on your suggestion." action={<Link href="/login?next=%2Fmarkets%2Fsuggest" className="button button-primary">Sign in</Link>} /></div>;
  if (requiresEmailVerification(user)) redirect("/verify-email?next=%2Fmarkets%2Fsuggest");
  const suggestions = await db.marketSuggestion.findMany({ where: { userId: user.id }, orderBy: { createdAt: "desc" }, take: 50, include: { market: { select: { slug: true, shortTitle: true } } } });
  return <div className="page-shell narrow-page"><header className="page-header"><span className="eyebrow">Your idea</span><h1>Suggest a market</h1><p>Got a good question? Tell us what counts as YES and how we can check it.</p></header><SuggestionForm /><section className="moderation-panel" aria-labelledby="suggestion-history-heading"><div className="section-heading"><div><span className="eyebrow">Your suggestions</span><h2 id="suggestion-history-heading">Past suggestions</h2></div><span>{suggestions.length} total</span></div>{suggestions.length ? <div className="report-list">{suggestions.map((suggestion) => <article className="report-item" key={suggestion.id}><header><strong>{suggestion.title}</strong><span>{suggestion.status.toLowerCase()}</span></header><p>{suggestion.description}</p>{suggestion.reviewNote && <small>Organizer note: {suggestion.reviewNote}</small>}<footer><span>{suggestion.category} · sent {suggestion.createdAt.toLocaleDateString("en-CA", { dateStyle: "medium" })}</span>{suggestion.market && <Link href={`/markets/${suggestion.market.slug}`}>View {suggestion.market.shortTitle}</Link>}</footer></article>)}</div> : <p className="muted-copy">Your market ideas will show up here.</p>}</section></div>;
}
