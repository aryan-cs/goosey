import type { Prisma } from "@prisma/client";

export interface PublicTradeActivity {
  id: string;
  source: "LMSR" | "ORDER_BOOK";
  action: string;
  side: string;
  quantity: number;
  /** Selected-outcome execution volume, excluding fees. */
  amountMilli: bigint;
  feeMilli: bigint;
  createdAt: Date;
  market: { slug: string; shortTitle: string };
  user: { profilePublic: boolean; username: string };
}

const userSelect = { username: true, profilePublic: true } as const;
const marketSelect = { slug: true, shortTitle: true } as const;

function publicUser(user: { username: string; profilePublic: boolean }): PublicTradeActivity["user"] {
  return { profilePublic: user.profilePublic, username: user.username };
}

/** Call within a read transaction to merge both sources from one snapshot.
 * Each fill appears once, from its taker's perspective, not once per participant.
 */
export async function loadPublicTradeActivity(
  tx: Prisma.TransactionClient,
  limit = 6,
): Promise<PublicTradeActivity[]> {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
    throw new RangeError("Public activity limit must be an integer between 1 and 100.");
  }
  const [trades, fills] = await Promise.all([
    tx.trade.findMany({
      where: { market: { status: { not: "DRAFT" } } },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: limit,
      select: {
        id: true, action: true, side: true, quantity: true, amountMilli: true,
        feeMilli: true, createdAt: true,
        market: { select: marketSelect }, user: { select: userSelect },
      },
    }),
    tx.orderFill.findMany({
      where: { market: { status: { not: "DRAFT" } } },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: limit,
      select: {
        id: true, canonicalYesPriceMilli: true, quantity: true, takerFeeMilli: true, createdAt: true,
        market: { select: { ...marketSelect, payoutMilli: true } },
        takerOrder: { select: { action: true, outcome: true, user: { select: userSelect } } },
      },
    }),
  ]);
  const items: PublicTradeActivity[] = [
    ...trades.map((trade): PublicTradeActivity => ({
      ...trade, id: `lmsr:${trade.id}`, source: "LMSR", user: publicUser(trade.user),
    })),
    ...fills.map((fill): PublicTradeActivity => ({
      id: `orderbook:${fill.id}`, source: "ORDER_BOOK",
      action: fill.takerOrder.action, side: fill.takerOrder.outcome,
      quantity: fill.quantity,
      amountMilli: BigInt(fill.quantity) * (fill.takerOrder.outcome === "YES"
        ? fill.canonicalYesPriceMilli : fill.market.payoutMilli - fill.canonicalYesPriceMilli),
      feeMilli: fill.takerFeeMilli, createdAt: fill.createdAt,
      market: { slug: fill.market.slug, shortTitle: fill.market.shortTitle },
      user: publicUser(fill.takerOrder.user),
    })),
  ];
  return items.sort((a, b) =>
    b.createdAt.getTime() - a.createdAt.getTime() || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0)
  ).slice(0, limit);
}
