import { initials } from "@/lib/initials";
import Link from "next/link";
import type { ReactNode } from "react";
import { ArrowDownRight, ArrowUpRight, ChevronRight, Crown, Trophy } from "lucide-react";
import { FeatherIcon } from "./brand";

export function MetricCard({ label, value, detail, trend, icon }: { label: string; value: ReactNode; detail?: string; trend?: number; icon?: ReactNode }) {
  return <article className="metric-card"><div className="metric-label">{icon && <span>{icon}</span>}{label}</div><strong>{value}</strong><div className="metric-detail">{trend !== undefined && <span className={trend >= 0 ? "movement-up" : "movement-down"}>{trend >= 0 ? <ArrowUpRight /> : <ArrowDownRight />}{Math.round(Math.abs(trend))}%</span>}{detail && <span>{detail}</span>}</div></article>;
}

export interface PositionRowProps { marketSlug: string; title: string; side: "YES" | "NO"; quantity: number; reservedQuantity?: number; status?: string; averagePrice: number; probability: number | null; value: string; pnl: string; pnlPositive: boolean }
export function PositionRow(props: PositionRowProps) {
  const neutralPnl = /^0(?:[.,]0+)?$/.test(props.pnl);
  const pnlLabel = neutralPnl ? "No change" : `${props.pnlPositive ? "Profit" : "Loss"} ${props.pnl} feathers`;
  return <Link className="position-row" href={`/markets/${encodeURIComponent(props.marketSlug)}?outcome=${props.side}`}><span className="position-market"><span className={`side-badge ${props.side.toLowerCase()}`}>{props.side}</span><span className="position-title"><strong>{props.title}</strong>{props.status && <small>{props.status === "OPEN" ? "Open" : props.status === "CLOSED" ? "Trading closed" : props.status === "RESOLVING" ? "Awaiting payout" : props.status.toLowerCase().replaceAll("_", " ")}</small>}</span></span><dl><div><dt>Contracts</dt><dd>{props.quantity.toLocaleString()}{Boolean(props.reservedQuantity) && <small>{props.reservedQuantity} reserved</small>}</dd></div><div><dt>Avg. entry</dt><dd>{Math.round(props.averagePrice)}%</dd></div><div><dt>Forecast</dt><dd>{props.probability === null ? "No price" : `${Math.round(props.probability)}%`}</dd></div><div><dt>Est. exit value</dt><dd><FeatherIcon /> {props.value}</dd></div><div><dt>P/L</dt><dd className={neutralPnl ? undefined : props.pnlPositive ? "movement-up" : "movement-down"} aria-label={pnlLabel}><span aria-hidden="true">{neutralPnl ? "" : props.pnlPositive ? "+" : "−"}<FeatherIcon /> {props.pnl}</span></dd></div></dl><ChevronRight /></Link>;
}

export interface LeaderboardUser { id: string; username: string; rank: number; displayName: string; score: number; profilePublic?: boolean; availableBalance?: number; movement?: number; marketsTraded?: number; badge?: string }
function LeaderboardIdentity({ user, className, label, id, children }: { user: LeaderboardUser; className: string; label: string; id?: string; children: ReactNode }) {
  return user.profilePublic
    ? <Link id={id} className={className} href={`/users/${encodeURIComponent(user.username)}`} aria-label={`View ${user.displayName}'s profile. ${label}`}>{children}</Link>
    : <div id={id} className={className} aria-label={label} tabIndex={id ? -1 : undefined}>{children}</div>;
}

export function LeaderboardRow({ user, current = false }: { user: LeaderboardUser; current?: boolean }) {
  const movementLabel = user.movement === undefined ? null : user.movement === 0 ? "No rank change" : `${user.movement > 0 ? "Up" : "Down"} ${Math.abs(user.movement)} ${Math.abs(user.movement) === 1 ? "place" : "places"}`;
  return <LeaderboardIdentity user={user} className={`leaderboard-row${current ? " current-user" : ""}`} label={`${user.displayName}, rank ${user.rank}, ${user.score.toLocaleString(undefined, { maximumFractionDigits: 0 })} feathers total${current ? ", your position" : ""}`}><span className="rank" aria-label={`Rank ${user.rank}`}>{user.rank === 1 ? <span aria-hidden="true"><Crown /></span> : user.rank}</span><span className="leader-avatar" aria-hidden="true">{initials(user.displayName)}</span><span className="leader-name"><strong>{user.displayName}</strong><small>{user.availableBalance !== undefined ? `${user.availableBalance.toLocaleString(undefined, { maximumFractionDigits: 0 })} available` : user.badge ?? `${user.marketsTraded ?? 0} markets`}</small></span>{movementLabel && <span className={user.movement! >= 0 ? "rank-up" : "rank-down"} aria-label={movementLabel}><span aria-hidden="true">{user.movement! > 0 ? "↑" : user.movement! < 0 ? "↓" : "0"} {Math.abs(user.movement!)}</span></span>}<span className="leader-score"><FeatherIcon /> <strong>{user.score.toLocaleString(undefined, { maximumFractionDigits: 0 })}<span className="sr-only"> feathers total</span></strong></span></LeaderboardIdentity>;
}

export function LeaderboardPodium({ users }: { users: LeaderboardUser[] }) {
  return <div className="leaderboard-podium" aria-label="Top forecasters">{users.map((user) => <LeaderboardIdentity id={`player-${user.id}`} user={user} className={`podium-place podium-${user.rank}`} label={`${user.displayName}, rank ${user.rank}, ${user.score.toLocaleString(undefined, { maximumFractionDigits: 0 })} feathers total`} key={user.id}><span className="podium-icon" aria-hidden="true">{user.rank === 1 ? <Trophy /> : <span className="rank">{user.rank}</span>}</span><div className="leader-avatar" aria-hidden="true">{initials(user.displayName)}</div><strong>{user.displayName}</strong><span aria-hidden="true">Total · <FeatherIcon /> {user.score.toLocaleString(undefined, { maximumFractionDigits: 0 })}</span></LeaderboardIdentity>)}</div>;
}

export function SectionHeader({ eyebrow, title, description, href, linkLabel = "View all" }: { eyebrow?: string; title: string; description?: string; href?: string; linkLabel?: string }) {
  return <div className="section-heading"><div>{eyebrow && <span className="eyebrow">{eyebrow}</span>}<h2>{title}</h2>{description && <p>{description}</p>}</div>{href && <Link className="section-link" href={href}>{linkLabel}</Link>}</div>;
}
