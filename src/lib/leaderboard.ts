import { db } from "@/lib/db";
import { executablePositionValue } from "@/lib/trading";

export async function getLeaderboardRows(limit = 50) {
  const users = await db.user.findMany({
      where: { status: "ACTIVE", role: "USER", leaderboardVisible: true },
      include: {
        positions: { where: { OR: [{ yesShares: { gt: 0 } }, { noShares: { gt: 0 } }] }, include: { market: true } },
        _count: { select: { trades: true } },
      },
      orderBy: { id: "asc" },
    });
  const userIds = users.map((user) => user.id);
  const [wallets, grants, tradedMarkets] = userIds.length ? await Promise.all([
    db.ledgerAccount.findMany({ where: { ownerType: "USER", ownerId: { in: userIds }, purpose: "USER_FEATHERS", status: "ACTIVE" }, select: { ownerId: true, balanceMilli: true } }),
    db.journalEntry.findMany({ where: { type: "WELCOME_GRANT", actorUserId: { in: userIds } }, select: { actorUserId: true, metadata: true } }),
    db.trade.findMany({ where: { userId: { in: userIds } }, distinct: ["userId", "marketId"], select: { userId: true, marketId: true } }),
  ]) : [[], [], []];
  const grantByUser = new Map<string, bigint>();
  for (const grant of grants) {
    if (!grant.actorUserId) continue;
    try {
      const amount = BigInt((JSON.parse(grant.metadata) as { amountMilli?: string }).amountMilli ?? "0");
      grantByUser.set(grant.actorUserId, (grantByUser.get(grant.actorUserId) ?? 0n) + amount);
    } catch { /* Reconciliation reports malformed financial metadata separately. */ }
  }
  const marketsByUser = new Map<string, number>();
  for (const trade of tradedMarkets) marketsByUser.set(trade.userId, (marketsByUser.get(trade.userId) ?? 0) + 1);
  const walletByUser = new Map(wallets.flatMap((wallet) => wallet.ownerId ? [[wallet.ownerId, wallet.balanceMilli] as const] : []));
  return users.map((user) => {
    const positionValueMilli = user.positions.reduce((sum, position) => sum + executablePositionValue(position.market, position), 0n);
    const cashMilli = walletByUser.get(user.id) ?? user.balanceMilli;
    const equityMilli = cashMilli + positionValueMilli;
    return { userId: user.id, username: user.username, displayName: user.displayName, equityMilli, pnlMilli: equityMilli - (grantByUser.get(user.id) ?? 0n), realizedPnlMilli: user.realizedPnlMilli, marketsTraded: marketsByUser.get(user.id) ?? 0, trades: user._count.trades };
  }).sort((left, right) => left.pnlMilli === right.pnlMilli ? left.username.localeCompare(right.username) : left.pnlMilli > right.pnlMilli ? -1 : 1)
    .slice(0, limit).map((row, index) => ({ rank: index + 1, ...row }));
}
