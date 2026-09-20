import type { Market, Position, Prisma } from "@prisma/client";

import { DATABASE_MARKET_FILTER } from "@/lib/market-backend";
import { contributedCapitalDelta } from "@/lib/admin-balance-adjustment";
import { loadPositionValuations } from "@/lib/position-valuation";
import { loadTradeHistory, type TradeHistoryItem } from "@/lib/trade-history";
import { loadTradingActivity } from "@/lib/trading-activity";

type Holding = Position & { market: Market };
const PUBLIC_MARKET_FILTER = { ...DATABASE_MARKET_FILTER, status: { not: "DRAFT" as const } };

export interface PublicProfilePoint {
  timestamp: string;
  value: number;
}

export interface PublicProfilePosition {
  id: string;
  marketSlug: string;
  marketTitle: string;
  marketStatus: string;
  side: "YES" | "NO";
  quantity: number;
  averagePrice: number;
  probability: number | null;
  valueMilli: bigint;
  pnlMilli: bigint;
}

export interface PublicProfileData {
  identity: {
    username: string;
    displayName: string;
    bio: string | null;
    joinedAt: Date;
  };
  summary: {
    availableCashMilli: bigint;
    reservedCashMilli: bigint;
    positionValueMilli: bigint;
    equityMilli: bigint;
    pnlMilli: bigint;
    volumeMilli: bigint;
    trades: number;
    marketsTraded: number;
  };
  positions: PublicProfilePosition[];
  recentTrades: TradeHistoryItem[];
  balanceSeries: PublicProfilePoint[];
  volumeSeries: PublicProfilePoint[];
}

function chartPoint(timestamp: Date, milli: bigint): PublicProfilePoint {
  return { timestamp: timestamp.toISOString(), value: Number(milli) / 1_000 };
}

function compactSeries(points: PublicProfilePoint[], maximum = 600): PublicProfilePoint[] {
  if (points.length <= maximum) return points;
  const result: PublicProfilePoint[] = [points[0]];
  const step = (points.length - 2) / (maximum - 2);
  for (let index = 1; index < maximum - 1; index += 1) {
    result.push(points[Math.max(1, Math.min(points.length - 2, Math.round(index * step)))]);
  }
  result.push(points.at(-1)!);
  return result.filter((point, index, values) => index === 0 || point.timestamp !== values[index - 1].timestamp || point.value !== values[index - 1].value);
}

function positionRows(positions: Holding[], valuations: Awaited<ReturnType<typeof loadPositionValuations>>): PublicProfilePosition[] {
  return positions.flatMap((position) => {
    const valuation = valuations.get(position.id)!;
    const yesProbability = valuation.probabilityYesBps === null ? null : valuation.probabilityYesBps / 100;
    return (["YES", "NO"] as const).flatMap((side) => {
      const quantity = side === "YES" ? position.yesShares : position.noShares;
      if (quantity <= 0) return [];
      const cost = side === "YES" ? position.yesCostBasisMilli : position.noCostBasisMilli;
      const value = side === "YES" ? valuation.yes : valuation.no;
      return [{
        id: `${position.id}:${side}`,
        marketSlug: position.market.slug,
        marketTitle: position.market.shortTitle,
        marketStatus: position.market.status,
        side,
        quantity,
        averagePrice: Number(cost * 10_000n / (BigInt(quantity) * position.market.payoutMilli)) / 100,
        probability: yesProbability === null ? null : side === "YES" ? yesProbability : 100 - yesProbability,
        valueMilli: value,
        pnlMilli: value - cost,
      }];
    });
  }).sort((left, right) => left.valueMilli === right.valueMilli ? left.marketTitle.localeCompare(right.marketTitle) : left.valueMilli > right.valueMilli ? -1 : 1);
}

/** Public trading data only. Never return contact, auth, order, wallet-link, or audit fields. */
export async function loadPublicProfile(
  tx: Prisma.TransactionClient,
  username: string,
): Promise<PublicProfileData | null> {
  const user = await tx.user.findFirst({
    where: { username: username.toLowerCase(), role: { in: ["USER", "ADMIN"] }, status: "ACTIVE" },
    select: {
      id: true,
      username: true,
      displayName: true,
      bio: true,
      profilePublic: true,
      createdAt: true,
      balanceMilli: true,
      positions: {
        where: { market: PUBLIC_MARKET_FILTER, OR: [{ yesShares: { gt: 0 } }, { noShares: { gt: 0 } }] },
        include: { market: true },
        orderBy: { updatedAt: "desc" },
      },
    },
  });
  if (!user) return null;

  const [wallet, reservations, activity, history, legacyVolume, fillVolume] = await Promise.all([
    tx.ledgerAccount.findUnique({
      where: { ownerType_ownerId_purpose: { ownerType: "USER", ownerId: user.id, purpose: "USER_FEATHERS" } },
      select: {
        balanceMilli: true,
        postings: {
          where: { journalEntry: { status: "POSTED" } },
          select: { amountMilli: true, createdAt: true, id: true, journalEntry: { select: { type: true, metadata: true } } },
          orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        },
      },
    }),
    tx.orderReservation.findMany({
      where: { market: PUBLIC_MARKET_FILTER, userId: user.id, cashAccountId: { not: null } },
      select: { cashAccount: { select: { balanceMilli: true } } },
    }),
    loadTradingActivity(tx, [user.id], PUBLIC_MARKET_FILTER),
    loadTradeHistory(tx, user.id, { limit: 50, marketWhere: PUBLIC_MARKET_FILTER }),
    tx.trade.findMany({
      where: { userId: user.id, market: PUBLIC_MARKET_FILTER },
      select: { id: true, amountMilli: true, createdAt: true },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    }),
    tx.orderFill.findMany({
      where: { market: PUBLIC_MARKET_FILTER, OR: [{ makerOrder: { userId: user.id } }, { takerOrder: { userId: user.id } }] },
      select: {
        id: true,
        canonicalYesPriceMilli: true,
        quantity: true,
        createdAt: true,
        market: { select: { payoutMilli: true } },
        makerOrder: { select: { userId: true, outcome: true } },
        takerOrder: { select: { userId: true, outcome: true } },
      },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    }),
  ]);
  const valuations = await loadPositionValuations(tx, user.positions);
  const availableCashMilli = wallet?.balanceMilli ?? user.balanceMilli;
  const reservedCashMilli = reservations.reduce((sum, reservation) => sum + (reservation.cashAccount?.balanceMilli ?? 0n), 0n);
  const positionValueMilli = user.positions.reduce((sum, position) => sum + valuations.get(position.id)!.valueMilli, 0n);
  const equityMilli = availableCashMilli + reservedCashMilli + positionValueMilli;
  const contributedMilli = (wallet?.postings ?? []).reduce(
    (sum, posting) => sum + contributedCapitalDelta(posting.journalEntry.type, posting.amountMilli, posting.journalEntry.metadata),
    0n,
  );

  let balance = 0n;
  const balanceSeries = compactSeries((wallet?.postings ?? []).map((posting) => {
    balance += posting.amountMilli;
    return chartPoint(posting.createdAt, balance);
  }));

  const volumeEvents = [
    ...legacyVolume.map((trade) => ({ id: `l:${trade.id}`, createdAt: trade.createdAt, amountMilli: trade.amountMilli })),
    ...fillVolume.map((fill) => {
      const order = fill.makerOrder.userId === user.id ? fill.makerOrder : fill.takerOrder;
      const price = order.outcome === "YES" ? fill.canonicalYesPriceMilli : fill.market.payoutMilli - fill.canonicalYesPriceMilli;
      return { id: `o:${fill.id}`, createdAt: fill.createdAt, amountMilli: price * BigInt(fill.quantity) };
    }),
  ].sort((left, right) => left.createdAt.getTime() - right.createdAt.getTime() || left.id.localeCompare(right.id));
  let volume = 0n;
  const volumeSeries = compactSeries(volumeEvents.map((event) => {
    volume += event.amountMilli;
    return chartPoint(event.createdAt, volume);
  }));
  const trading = activity.get(user.id) ?? { trades: 0, marketsTraded: 0 };

  return {
    identity: {
      username: user.username,
      displayName: user.displayName,
      bio: user.profilePublic && user.bio ? user.bio : null,
      joinedAt: user.createdAt,
    },
    summary: {
      availableCashMilli,
      reservedCashMilli,
      positionValueMilli,
      equityMilli,
      pnlMilli: equityMilli - contributedMilli,
      volumeMilli: volume,
      trades: trading.trades,
      marketsTraded: trading.marketsTraded,
    },
    positions: positionRows(user.positions, valuations),
    recentTrades: history.items,
    balanceSeries,
    volumeSeries,
  };
}
