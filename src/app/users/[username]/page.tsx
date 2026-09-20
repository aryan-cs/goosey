import { notFound } from "next/navigation";
import type { Metadata } from "next";

import { LivePageRefresh } from "@/components/live-page-refresh";
import { PublicProfileDashboard } from "@/components/public-profile-dashboard";
import { db } from "@/lib/db";
import { loadPublicProfile } from "@/lib/public-profile";
import { runSerializableTransaction } from "@/lib/serializable-transaction";
import { formatFeathers } from "@/lib/view-models";

export const dynamic = "force-dynamic";

export async function generateMetadata({ params }: { params: Promise<{ username: string }> }): Promise<Metadata> {
  const { username } = await params;
  return { title: `@${username} · Goosey` };
}

export default async function UserProfilePage({ params }: { params: Promise<{ username: string }> }) {
  const { username } = await params;
  const profile = await runSerializableTransaction(db, (tx) => loadPublicProfile(tx, username));
  if (!profile) notFound();

  return <main className="page-shell profile-page"><LivePageRefresh showButton={false} /><PublicProfileDashboard
    identity={{ ...profile.identity, joinedAt: profile.identity.joinedAt.toISOString() }}
    summary={{
      equity: formatFeathers(profile.summary.equityMilli, 2),
      pnl: formatFeathers(profile.summary.pnlMilli < 0n ? -profile.summary.pnlMilli : profile.summary.pnlMilli, 2),
      pnlPositive: profile.summary.pnlMilli >= 0n,
      volume: formatFeathers(profile.summary.volumeMilli, 2),
      trades: profile.summary.trades,
      marketsTraded: profile.summary.marketsTraded,
      availableCash: formatFeathers(profile.summary.availableCashMilli, 2),
      reservedCash: formatFeathers(profile.summary.reservedCashMilli, 2),
      positionValue: formatFeathers(profile.summary.positionValueMilli, 2),
    }}
    positions={profile.positions.map((position) => ({ ...position, value: formatFeathers(position.valueMilli, 2), pnl: formatFeathers(position.pnlMilli < 0n ? -position.pnlMilli : position.pnlMilli, 2), pnlPositive: position.pnlMilli >= 0n, valueMilli: undefined, pnlMilli: undefined }))}
    recentTrades={profile.recentTrades.map((trade) => ({ id: trade.id, marketSlug: trade.market.slug, marketTitle: trade.market.shortTitle, side: trade.side, action: trade.action, quantity: trade.quantity, amount: formatFeathers(trade.amountMilli, 2), fee: formatFeathers(trade.feeMilli, 2), createdAt: trade.createdAt.toISOString(), source: trade.source }))}
    balanceSeries={profile.balanceSeries}
    volumeSeries={profile.volumeSeries}
  /></main>;
}
