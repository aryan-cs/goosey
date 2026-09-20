import Link from "next/link";
import { AdminConsole } from "@/components/admin-console";
import { EmptyState } from "@/components/states";
import { db } from "@/lib/db";
import { getServerUser } from "@/lib/server-session";
import { ModerationQueue } from "@/components/moderation-queue";
import { SuggestionQueue } from "@/components/suggestion-queue";
import { ResolutionQueue } from "@/components/resolution-queue";
import { InviteConsole } from "@/components/invite-console";
import { BalanceAdjustmentConsole } from "@/components/balance-adjustment-console";

export const dynamic = "force-dynamic";

export default async function AdminPage() {
  const user = await getServerUser();
  if (!user || user.role !== "ADMIN") return <div className="page-shell centered-state"><EmptyState title="Administrator access required" description="Market creation and settlement are restricted and fully audited." action={<Link href="/" className="button button-secondary">Return home</Link>} /></div>;
  const [markets, reports, suggestions, proposals, settlementRuns, invites] = await Promise.all([
    db.market.findMany({ orderBy: { createdAt: "desc" }, take: 100, select: { id: true, title: true, status: true, resolution: true, version: true } }),
    db.commentReport.findMany({ where: { status: "PENDING" }, orderBy: { createdAt: "asc" }, take: 100, include: { reporter: { select: { username: true } }, comment: { include: { user: { select: { username: true, displayName: true } }, market: { select: { slug: true, shortTitle: true } } } } } }),
    db.marketSuggestion.findMany({ where: { status: "PENDING" }, orderBy: { createdAt: "asc" }, take: 100, include: { user: { select: { username: true, displayName: true } } } }),
    db.marketResolutionProposal.findMany({ where: { status: "PENDING" }, orderBy: { createdAt: "asc" }, take: 100, include: { proposer: { select: { username: true, displayName: true } }, market: { select: { title: true, slug: true, status: true } } } }),
    db.marketSettlementRun.findMany({ orderBy: { createdAt: "desc" }, take: 100, include: { market: { select: { title: true, slug: true } } } }),
    db.registrationInvite.findMany({ orderBy: { createdAt: "desc" }, take: 100, select: { id: true, label: true, status: true, maxUses: true, useCount: true, expiresAt: true } }),
  ]);
  return <div className="page-shell"><header className="page-header"><span className="eyebrow">Audited operations</span><h1>Market desk</h1><p>Create, pause, close, and settle Goosey markets. Resolution requires a proposal and approval from two distinct, conflict-free administrators who did not create the market.</p></header><BalanceAdjustmentConsole /><AdminConsole markets={markets} /><InviteConsole initialInvites={invites} /><ResolutionQueue initialProposals={proposals} initialRuns={settlementRuns} viewerId={user.id} proposerIds={Object.fromEntries(proposals.map((proposal) => [proposal.id, proposal.proposerId]))} /><SuggestionQueue initialSuggestions={suggestions} /><ModerationQueue initialReports={reports} /></div>;
}
