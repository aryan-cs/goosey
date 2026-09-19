import { db } from "@/lib/db";
import { loadPositionValuations } from "@/lib/position-valuation";
import { runSerializableTransaction } from "@/lib/serializable-transaction";
import { loadTradingActivity } from "@/lib/trading-activity";

export async function getLeaderboardRows(limit = 50) {
  return runSerializableTransaction(db, async (db) => {
  const users = await db.user.findMany({
      where: { status: "ACTIVE", role: "USER" },
      include: {
        positions: { where: { OR: [{ yesShares: { gt: 0 } }, { noShares: { gt: 0 } }] }, include: { market: true } },
      },
      orderBy: { id: "asc" },
    });
  const userIds = users.map((user) => user.id);
  const valuations = await loadPositionValuations(db, users.flatMap((user) => user.positions));
  const activity = await loadTradingActivity(db, userIds);
  const [wallets, grants, reservations] = userIds.length ? await Promise.all([
    db.ledgerAccount.findMany({ where: { ownerType: "USER", ownerId: { in: userIds }, purpose: "USER_FEATHERS", status: "ACTIVE" }, select: { ownerId: true, balanceMilli: true } }),
    db.journalEntry.findMany({ where: { type: "WELCOME_GRANT", actorUserId: { in: userIds } }, select: { actorUserId: true, metadata: true } }),
    db.orderReservation.findMany({ where: { userId: { in: userIds }, cashAccountId: { not: null } }, select: { userId: true, cashAccount: { select: { balanceMilli: true } } } }),
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
    return { userId: user.id, username: user.username, displayName: user.displayName, equityMilli, reservedCashMilli, pnlMilli: equityMilli - (grantByUser.get(user.id) ?? 0n), realizedPnlMilli: user.realizedPnlMilli, ...activity.get(user.id)! };
  }).sort((left, right) => left.pnlMilli === right.pnlMilli ? left.username.localeCompare(right.username) : left.pnlMilli > right.pnlMilli ? -1 : 1)
    .slice(0, limit).map((row, index) => ({ rank: index + 1, ...row }));
  });
}
