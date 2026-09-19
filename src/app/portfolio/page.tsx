import { Fragment } from "react";
import Link from "next/link";
import { redirect } from "next/navigation";
import { ChartNoAxesCombined, Feather, HandCoins, WalletCards } from "lucide-react";
import { MetricCard, PositionRow, SectionHeader } from "@/components/data-primitives";
import { EmptyState } from "@/components/states";
import { RedemptionForm } from "@/components/redemption-form";
import { db } from "@/lib/db";
import { liquidationValueMilli, sideLiquidationValuesMilli } from "@/lib/portfolio";
import { getServerUser } from "@/lib/server-session";
import { formatFeathers, marketProbabilityBps } from "@/lib/view-models";
import { requiresEmailVerification } from "@/lib/auth";

export const dynamic = "force-dynamic";

export default async function PortfolioPage() {
  const user = await getServerUser();
  if (!user) return <div className="page-shell centered-state"><EmptyState title="Your feathers are waiting" description="Sign in to view positions, trade history, and portfolio value." action={<Link className="button button-primary" href="/login">Sign in</Link>} /></div>;
  if (requiresEmailVerification(user)) redirect("/verify-email?next=%2Fportfolio");
  const [positions, trades] = await Promise.all([
    db.position.findMany({ where: { userId: user.id, OR: [{ yesShares: { gt: 0 } }, { noShares: { gt: 0 } }] }, include: { market: true }, orderBy: { updatedAt: "desc" } }),
    db.trade.findMany({ where: { userId: user.id }, include: { market: { select: { slug: true, shortTitle: true } } }, orderBy: { createdAt: "desc" }, take: 30 }),
  ]);
  const values = positions.map((position) => ({ position, value: liquidationValueMilli(position) }));
  const positionValue = values.reduce((total, item) => total + item.value, 0n);
  const cost = positions.reduce((total, position) => total + position.netCostMilli, 0n);
  const unrealized = positionValue - cost;
  const totalValue = user.balanceMilli + positionValue;

  return <div className="page-shell portfolio-page">
    <header className="page-header"><span className="eyebrow">Your account</span><h1>Portfolio</h1><p>Values show what you could cash out now after price changes and fees.</p></header>
    <section className="metric-grid"><MetricCard label="Total value" value={<>🪶 {formatFeathers(totalValue, 2)}</>} detail="Balance plus open positions" icon={<ChartNoAxesCombined />} /><MetricCard label="Available" value={<>🪶 {formatFeathers(user.balanceMilli, 2)}</>} detail="Ready to trade" icon={<WalletCards />} /><MetricCard label="Position value" value={<>🪶 {formatFeathers(positionValue, 2)}</>} detail={`${positions.length} open market${positions.length === 1 ? "" : "s"}`} icon={<Feather />} /><MetricCard label="Open profit/loss" value={<>🪶 {formatFeathers(unrealized, 2)}</>} trend={cost > 0n ? Number(unrealized * 10_000n / cost) / 100 : 0} icon={<HandCoins />} /></section>
    <section><SectionHeader eyebrow="Open positions" title="Positions" description="These values include price changes and fees." />{values.length ? <div className="position-list">{values.map(({ position }) => {
      const probability = marketProbabilityBps(position.market) / 100;
      const completeSets = Math.min(position.yesShares, position.noShares);
      const sideValues = sideLiquidationValuesMilli(position);
      const sides = ([position.yesShares > 0 ? "YES" : null, position.noShares > 0 ? "NO" : null] as const).filter((side): side is "YES" | "NO" => Boolean(side)).map((side) => {
        const quantity = side === "YES" ? position.yesShares : position.noShares;
        const sideCost = side === "YES" ? position.yesCostBasisMilli : position.noCostBasisMilli;
        const sideValue = side === "YES" ? sideValues.yes : sideValues.no;
        const sidePnl = sideValue - sideCost;
        const averagePrice = quantity ? Number(sideCost * 10_000n / (BigInt(quantity) * position.market.payoutMilli)) / 100 : 0;
        return <PositionRow key={`${position.id}-${side}`} marketSlug={position.market.slug} title={position.market.shortTitle} side={side} quantity={quantity} averagePrice={averagePrice} probability={side === "YES" ? probability : 100 - probability} value={formatFeathers(sideValue, 2)} pnl={formatFeathers(sidePnl < 0n ? -sidePnl : sidePnl, 2)} pnlPositive={sidePnl >= 0n} />;
      });
      const redeemable = completeSets > 0 && position.market.resolution === null && (position.market.status === "OPEN" || position.market.status === "CLOSED");
      return <Fragment key={position.id}>{sides}{redeemable ? <RedemptionForm marketSlug={position.market.slug} marketVersion={position.market.version} maxQuantity={completeSets} payoutMilli={position.market.payoutMilli.toString()} /> : null}</Fragment>;
    })}</div> : <EmptyState title="No open positions" description="Your positions will show up here after your first trade." action={<Link className="button button-primary" href="/markets">Find a market</Link>} />}</section>
    <section><SectionHeader eyebrow="Activity" title="Trade history" />{trades.length ? <div className="history-table" role="table">{trades.map((trade) => <div className="history-row" role="row" key={trade.id}><Link href={`/markets/${trade.market.slug}`}>{trade.market.shortTitle}</Link><span className={`side-badge ${trade.side.toLowerCase()}`}>{trade.side}</span><span>{trade.action} {trade.quantity}</span><span>🪶 {formatFeathers(trade.amountMilli, 2)}</span><time>{trade.createdAt.toLocaleString("en-CA", { dateStyle: "medium", timeStyle: "short" })}</time></div>)}</div> : <p className="muted-copy">No trades yet.</p>}</section>
  </div>;
}
