import { DATABASE_MARKET_FILTER } from "./market-backend";
import { db } from "@/lib/db";
import { loadPositionValuations } from "@/lib/position-valuation";
import { runSerializableTransaction } from "@/lib/serializable-transaction";
import { loadTradingActivity } from "@/lib/trading-activity";

async function loadRankedPlayers() {
  return runSerializableTransaction(db, async (db) => {
  const users = await db.user.findMany({
      where: { status: "ACTIVE", role: "USER" },
      include: {
        positions: { where: { market: DATABASE_MARKET_FILTER, OR: [{ yesShares: { gt: 0 } }, { noShares: { gt: 0 } }] }, include: { market: true } },
      },
      orderBy: { id: "asc" },
    });
  const userIds = users.map((user) => user.id);
  const valuations = await loadPositionValuations(db, users.flatMap((user) => user.positions));
  const activity = await loadTradingActivity(db, userIds);
  const [wallets, grants, reservations] = userIds.length ? await Promise.all([
    db.ledgerAccount.findMany({ where: { ownerType: "USER", ownerId: { in: userIds }, purpose: "USER_FEATHERS", status: "ACTIVE" }, select: { ownerId: true, balanceMilli: true } }),
    db.journalEntry.findMany({ where: { type: "WELCOME_GRANT", actorUserId: { in: userIds } }, select: { actorUserId: true, metadata: true } }),
    db.orderReservation.findMany({ where: { market: DATABASE_MARKET_FILTER, userId: { in: userIds }, cashAccountId: { not: null } }, select: { userId: true, cashAccount: { select: { balanceMilli: true } } } }),
  ]) : [[], [], []];
  const reservedByUser = new Map<string, bigint>();
  for (const reservation of reservations) {
    reservedByUser.set(reservation.userId, (reservedByUser.get(reservation.userId) ?? 0n) + (reservation.cashAccount?.balanceMilli ?? 0n));
  }
  const grantByUser = new Map<string, bigint>();
  for (const grant of grants) {
    if (!grant.actorUserId) continue;
    try {
      const amount = BigInt((JSON.parse(grant.metadata) as { amountMilli?: string }).amountMilli ?? "0");
      grantByUser.set(grant.actorUserId, (grantByUser.get(grant.actorUserId) ?? 0n) + amount);
    } catch { /* Reconciliation reports malformed financial metadata separately. */ }
  }
  const walletByUser = new Map(wallets.flatMap((wallet) => wallet.ownerId ? [[wallet.ownerId, wallet.balanceMilli] as const] : []));
  return users.map((user) => {
    const positionValueMilli = user.positions.reduce((sum, position) => sum + valuations.get(position.id)!.valueMilli, 0n);
    const cashMilli = walletByUser.get(user.id) ?? user.balanceMilli;
    const reservedCashMilli = reservedByUser.get(user.id) ?? 0n;
    const equityMilli = cashMilli + reservedCashMilli + positionValueMilli;
    return { userId: user.id, username: user.username, displayName: user.displayName, profilePublic: user.profilePublic, cashMilli, equityMilli, reservedCashMilli, pnlMilli: equityMilli - (grantByUser.get(user.id) ?? 0n), realizedPnlMilli: user.realizedPnlMilli, ...activity.get(user.id)! };
  }).sort((left, right) => left.equityMilli === right.equityMilli ? left.username.localeCompare(right.username) : left.equityMilli > right.equityMilli ? -1 : 1)
    .map((row, index) => ({ rank: index + 1, ...row }));
  });
}


export async function getLeaderboardRows(limit = 50) {
  return (await loadRankedPlayers()).slice(0, limit);
}

/** One consistent valuation snapshot, ranked before slicing across pages. */
export async function getLeaderboardPage(requestedPage = 1, pageSize = 50, viewerId?: string) {
  if (!Number.isSafeInteger(requestedPage) || requestedPage < 1 || !Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 100) {
    throw new RangeError("Invalid leaderboard page.");
  }
  const ranked = await loadRankedPlayers();
  const total = ranked.length;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const page = Math.min(requestedPage, totalPages);
  return { page, pageSize, total, totalPages, viewer: viewerId ? ranked.find(row => row.userId === viewerId) ?? null : null, rows: ranked.slice((page - 1) * pageSize, page * pageSize) };
}
