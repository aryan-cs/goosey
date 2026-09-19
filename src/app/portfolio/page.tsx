import { Fragment } from "react";
import { LivePageRefresh } from "@/components/live-page-refresh";
import { PortfolioActivity } from "@/components/portfolio-activity";
import styles from "./portfolio.module.css";
import Link from "next/link";
import { redirect } from "next/navigation";
import { FeatherIcon } from "@/components/brand";
import { MetricCard, PositionRow, SectionHeader } from "@/components/data-primitives";
import { EmptyState } from "@/components/states";
import { RedemptionForm } from "@/components/redemption-form";
import { db } from "@/lib/db";
import { DATABASE_MARKET_FILTER } from "@/lib/market-backend";
import { loadPositionValuations } from "@/lib/position-valuation";
import { getServerUser } from "@/lib/server-session";
import { formatFeathers } from "@/lib/view-models";
import { requiresEmailVerification } from "@/lib/auth";
import { runSerializableTransaction } from "@/lib/serializable-transaction";
import { loadTradeHistory, parseTradeHistoryCursor, type TradeHistoryCursor } from "@/lib/trade-history";
import { ApiError } from "@/lib/market-service";
import { TradeHistory } from "@/components/trade-history";
import { authDestination, authPageHref } from "@/lib/auth-destination";

export const dynamic = "force-dynamic";

export default async function PortfolioPage({ searchParams }: { searchParams: Promise<{ historyCursor?: string | string[]; view?: string | string[] }> }) {
  const { historyCursor, view: requestedView } = await searchParams;
  const view = requestedView === "orders" ? "orders" : requestedView === "history" || historyCursor !== undefined ? "history" : "positions";
  const destination = authDestination(typeof historyCursor === "string"
    ? `/portfolio?view=history&historyCursor=${encodeURIComponent(historyCursor)}` : `/portfolio?view=${view}`);
  const user = await getServerUser();
  if (!user) return <div className="page-shell centered-state"><EmptyState title="Your picks, all in one place" description="Sign in to see your picks, trades, and feathers." action={<Link className="button button-primary" href={authPageHref("/login", destination)}>Sign in</Link>} /></div>;
  if (requiresEmailVerification(user)) redirect(`/verify-email?next=${encodeURIComponent(destination)}`);
  let cursor: TradeHistoryCursor | undefined;
  let invalidCursor = false;
  try {
    if (Array.isArray(historyCursor)) throw new ApiError(400, "INVALID_CURSOR", "Invalid history cursor.");
    cursor = parseTradeHistoryCursor(historyCursor);
  } catch (error) {
    if (!(error instanceof ApiError)) throw error;
    invalidCursor = true;
  }
  const [positions, history, cashRecord, wallet, reservations, valuations] = await runSerializableTransaction(db, async (db) => {
    const result = await Promise.all([
    db.position.findMany({ where: { market: DATABASE_MARKET_FILTER, userId: user.id, OR: [{ yesShares: { gt: 0 } }, { noShares: { gt: 0 } }] }, include: { market: true }, orderBy: { updatedAt: "desc" } }),
    view !== "history" || invalidCursor ? Promise.resolve({ items: [], nextCursor: null }) : loadTradeHistory(db, user.id, { limit: 30, cursor }),
    db.user.findUniqueOrThrow({ where: { id: user.id }, select: { balanceMilli: true } }),
    db.ledgerAccount.findUnique({ where: { ownerType_ownerId_purpose: { ownerType: "USER", ownerId: user.id, purpose: "USER_FEATHERS" } }, select: { balanceMilli: true } }),
    db.orderReservation.findMany({ where: { market: DATABASE_MARKET_FILTER, userId: user.id, cashAccountId: { not: null } }, select: { cashAccount: { select: { balanceMilli: true } } } }),
    ]);
    return [...result, await loadPositionValuations(db, result[0])] as const;
  });
  const availableCash = wallet?.balanceMilli ?? cashRecord.balanceMilli;
  const reservedCash = reservations.reduce((sum, reservation) => sum + (reservation.cashAccount?.balanceMilli ?? 0n), 0n);
  const values = positions.map((position) => ({ position, value: valuations.get(position.id)!.valueMilli }));
  const positionValue = values.reduce((total, item) => total + item.value, 0n);
  const cost = positions.reduce((total, position) => total + position.netCostMilli, 0n);
  const unrealized = positionValue - cost;
  const totalValue = availableCash + reservedCash + positionValue;

  return <div className="page-shell portfolio-page">
    <header className="page-header"><h1>Portfolio</h1><div className={styles.links}><Link className="section-link" href="/wallet">Wallet</Link><Link className="section-link" href="/watchlist">Watchlist</Link></div><LivePageRefresh showButton={false} /></header>
    <section className="metric-grid" aria-label="Account balance"><MetricCard label="Total value" value={<><FeatherIcon /> {formatFeathers(totalValue)}</>} /><MetricCard label="Available" value={<><FeatherIcon /> {formatFeathers(availableCash)}</>} detail={reservedCash > 0n ? `${formatFeathers(reservedCash)} reserved in orders` : undefined} /><MetricCard label="Estimated exit value" value={<><FeatherIcon /> {formatFeathers(positionValue)}</>} /><MetricCard label="Unrealized return" value={<><FeatherIcon /> {formatFeathers(unrealized)}</>} trend={cost > 0n ? Number(unrealized * 10_000n / cost) / 100 : undefined} /></section>
    <nav className={styles.tabs} aria-label="Portfolio views">{(["positions", "orders", "history"] as const).map(item => <Link key={item} href={`/portfolio?view=${item}`} aria-current={view === item ? "page" : undefined}>{item === "positions" ? "Positions" : item === "orders" ? "Orders" : "History"}</Link>)}</nav>
    {view === "orders" && <PortfolioActivity ordersOnly />}
    {view === "positions" && <>
    <section><SectionHeader title="Your positions" />{values.length ? <div className="position-list">{values.map(({ position }) => {
      const sideValues = valuations.get(position.id)!;
      const probability = sideValues.probabilityYesBps === null ? null : sideValues.probabilityYesBps / 100;
      const completeSets = Math.min(position.yesShares - position.reservedYesShares, position.noShares - position.reservedNoShares);
      const sides = ([position.yesShares > 0 ? "YES" : null, position.noShares > 0 ? "NO" : null] as const).filter((side): side is "YES" | "NO" => Boolean(side)).map((side) => {
        const quantity = side === "YES" ? position.yesShares : position.noShares;
        const sideCost = side === "YES" ? position.yesCostBasisMilli : position.noCostBasisMilli;
        const sideValue = side === "YES" ? sideValues.yes : sideValues.no;
        const sidePnl = sideValue - sideCost;
        const averagePrice = quantity ? Number(sideCost * 10_000n / (BigInt(quantity) * position.market.payoutMilli)) / 100 : 0;
        return <PositionRow key={`${position.id}-${side}`} marketSlug={position.market.slug} title={position.market.shortTitle} side={side} quantity={quantity} reservedQuantity={side === "YES" ? position.reservedYesShares : position.reservedNoShares} status={position.market.status} averagePrice={averagePrice} probability={probability === null ? null : side === "YES" ? probability : 100 - probability} value={formatFeathers(sideValue)} pnl={formatFeathers(sidePnl < 0n ? -sidePnl : sidePnl)} pnlPositive={sidePnl >= 0n} />;
      });
      const redeemable = completeSets > 0 && position.market.resolution === null && (position.market.status === "OPEN" || position.market.status === "CLOSED");
      const unfilled = sideValues.unfilledYes + sideValues.unfilledNo;
      return <Fragment key={position.id}>{sides}{unfilled > 0 && <p className="muted-copy">{position.market.shortTitle}: {unfilled} contract{unfilled === 1 ? " has" : "s have"} no available buyer and {unfilled === 1 ? "is" : "are"} excluded from the exit estimate.</p>}{redeemable ? <RedemptionForm marketSlug={position.market.slug} marketVersion={position.market.version} maxQuantity={completeSets} payoutMilli={position.market.payoutMilli.toString()} /> : null}</Fragment>;
    })}</div> : <EmptyState title="No open positions" action={<Link className="button button-primary" href="/markets">Find a market</Link>} />}</section>
    <details className={styles.valuation}><summary>How values are calculated</summary><p>Total value includes available feathers, reserved feathers and estimated position value. Exit estimates include fees and available liquidity, assuming your resting orders are canceled. Actual proceeds can change.</p></details>
    </>}
    {view === "history" && <section><SectionHeader title="Trade history" /><TradeHistory history={history} olderPage={Boolean(cursor)} invalidCursor={invalidCursor} /></section>}
  </div>;
}
