import type { PrismaClient } from "@prisma/client";
import { DEVELOPMENT_PARTICIPANTS } from "./development-profiles";

type EquityTarget = { email: string; targetMilli: string };
type EquityResidual = EquityTarget & {
  userId: string;
  username: string;
  actualMilli: string;
  residualMilli: string;
  absoluteResidualMilli: string;
  withinTolerance: boolean;
};

type ValidationOptions = {
  asOf: Date;
  /** Optional planner targets. Keys are stable fictional login emails. */
  targetEquityMilliByEmail?: Readonly<Record<string, bigint>>;
  /** One feather by default; integral contracts cannot reach every milli-feather target. */
  targetEquityToleranceMilli?: bigint;
};

const BASIS_POINTS = 10_000n;
const ROUNDING_RESERVE_MILLI = 0.25;

function conservativeLmsrCostMilli(market: {
  yesShares: number; noShares: number; liquidityParameter: number; payoutMilli: bigint;
}) {
  const maximum = Math.max(market.yesShares, market.noShares);
  const spread = Math.abs(market.yesShares - market.noShares) / market.liquidityParameter;
  const value = market.liquidityParameter * Number(market.payoutMilli)
    * (maximum / market.liquidityParameter + Math.log1p(Math.exp(-spread)));
  return BigInt(Math.ceil(value + ROUNDING_RESERVE_MILLI));
}

/** Independently reproduces the executable liquidation value used by leaderboard equity. */
function developmentPositionValueMilli(
  market: {
    status: string; resolution: string | null; yesShares: number; noShares: number;
    liquidityParameter: number; payoutMilli: bigint; feeBps: number;
  },
  position: { yesShares: number; noShares: number },
) {
  const pairs = Math.min(position.yesShares, position.noShares);
  let value = BigInt(pairs) * market.payoutMilli;
  const remainingYes = position.yesShares - pairs;
  const remainingNo = position.noShares - pairs;
  if (market.status === "RESOLVED") {
    if (market.resolution === "YES") value += BigInt(remainingYes) * market.payoutMilli;
    if (market.resolution === "NO") value += BigInt(remainingNo) * market.payoutMilli;
    return value;
  }
  if (market.status === "VOID") {
    return value + BigInt(remainingYes + remainingNo) * market.payoutMilli / 2n;
  }
  const liquidate = (side: "YES" | "NO", quantity: number) => {
    if (!quantity) return 0n;
    const after = {
      ...market,
      yesShares: market.yesShares - (side === "YES" ? quantity : 0),
      noShares: market.noShares - (side === "NO" ? quantity : 0),
    };
    const gross = conservativeLmsrCostMilli(market) - conservativeLmsrCostMilli(after);
    const fee = (gross * BigInt(market.feeBps) + BASIS_POINTS - 1n) / BASIS_POINTS;
    return gross - fee;
  };
  return value + liquidate("YES", remainingYes) + liquidate("NO", remainingNo);
}

/** Read-only checks deliberately independent of the trading arithmetic helpers. */
export async function validateDevelopmentData(client: Pick<PrismaClient, "market" | "marketEvent" | "user" | "ledgerAccount" | "journalEntry">, options: ValidationOptions) {
  const errors: string[] = [];
  const cutoff = options.asOf.getTime();
  if (!Number.isFinite(cutoff)) throw new Error("Validation requires a valid asOf date.");
  const targetTolerance = options.targetEquityToleranceMilli ?? 1_000n;
  if (targetTolerance < 0n) throw new Error("Target equity tolerance cannot be negative.");
  const [markets, events, users, accounts, journals] = await Promise.all([
    client.market.findMany({ include: { trades: true, priceHistory: true, positions: true, settlements: true, resolutionProposals: true } }),
    client.marketEvent.findMany(),
    client.user.findMany(),
    client.ledgerAccount.findMany(),
    client.journalEntry.findMany({ include: { postings: true } }),
  ]);
  const checkDate = (label: string, date: Date) => {
    if (!Number.isFinite(date.getTime()) || date.getTime() > cutoff) errors.push(`${label}: invalid or future timestamp`);
  };
  const probability = (label: string, bps: number) => {
    if (!Number.isInteger(bps) || bps < 0 || bps > 10_000) errors.push(`${label}: probability outside 0..10000`);
  };
  const accountSums = new Map<string, bigint>();
  const tradeJournals = new Map<string, typeof journals>();
  for (const journal of journals) {
    checkDate(`journal ${journal.id}`, journal.createdAt);
    if (journal.postedAt) {
      checkDate(`journal ${journal.id} postedAt`, journal.postedAt);
      if (journal.postedAt < journal.createdAt) errors.push(`journal ${journal.id}: posted before creation`);
    }
    if (journal.postings.reduce((sum, posting) => sum + posting.amountMilli, 0n) !== 0n) errors.push(`journal ${journal.id}: unbalanced`);
    if (journal.referenceType === "TRADE") {
      const entries = tradeJournals.get(journal.referenceId) ?? [];
      entries.push(journal);
      tradeJournals.set(journal.referenceId, entries);
    }
    for (const posting of journal.postings) {
      checkDate(`posting ${posting.id}`, posting.createdAt);
      if (posting.createdAt < journal.createdAt) errors.push(`posting ${posting.id}: predates journal`);
      if (journal.status === "POSTED") accountSums.set(posting.ledgerAccountId, (accountSums.get(posting.ledgerAccountId) ?? 0n) + posting.amountMilli);
    }
  }
  for (const account of accounts) {
    checkDate(`account ${account.id}`, account.createdAt);
    if ((accountSums.get(account.id) ?? 0n) !== account.balanceMilli) errors.push(`account ${account.id}: balance differs from posted ledger`);
    if (!account.allowsNegative && account.balanceMilli < 0n) errors.push(`account ${account.id}: negative balance`);
  }
  for (const user of users) {
    checkDate(`user ${user.id}`, user.createdAt);
    if (user.balanceMilli < 0n) errors.push(`user ${user.id}: negative balance`);
    const wallet = accounts.find((account) => account.ownerType === "USER" && account.ownerId === user.id && account.purpose === "USER_FEATHERS");
    if (user.role === "USER" && (!wallet || wallet.balanceMilli !== user.balanceMilli)) errors.push(`user ${user.id}: wallet mismatch`);
  }
  const knownByEmail = new Map(users.map(user => [user.email, user]));
  const tradedMarketsByUser = new Map<string, Set<string>>();
  for (const market of markets) for (const trade of market.trades) {
    const traded = tradedMarketsByUser.get(trade.userId) ?? new Set<string>();
    traded.add(market.id);
    tradedMarketsByUser.set(trade.userId, traded);
  }
  for (const profile of DEVELOPMENT_PARTICIPANTS) {
    const user = knownByEmail.get(profile.email);
    if (!user || user.role !== "USER") {
      errors.push(`participant ${profile.email}: known fictional participant missing`);
      continue;
    }
    const traded = tradedMarketsByUser.get(user.id) ?? new Set<string>();
    if (traded.size === 0) errors.push(`participant ${profile.email}: no executed trades`);
    else if (traded.size < 2) errors.push(`participant ${profile.email}: traded in fewer than two markets`);
    for (const journal of journals) {
      if (journal.referenceType === "USER" && journal.referenceId === user.id
        && (journal.type === "ADMIN_GRANT" || journal.type.startsWith("ADMIN_BALANCE"))) {
        errors.push(`participant ${profile.email}: prohibited ${journal.type} shortcut`);
      }
    }
  }
  for (const event of events) {
    checkDate(`event ${event.id}`, event.createdAt);
    if (event.startsAt >= event.endsAt) errors.push(`event ${event.id}: startsAt must precede endsAt`);
  }
  for (const market of markets) {
    const label = `market ${market.slug}`;
    checkDate(label, market.createdAt);
    if (market.createdAt >= market.closesAt || market.closesAt > market.resolvesAt) errors.push(`${label}: creation/close/resolution dates are out of order`);
    if (market.resolvedAt) {
      checkDate(`${label} resolvedAt`, market.resolvedAt);
      if (market.resolvedAt < market.resolvesAt) errors.push(`${label}: resolved before scheduled resolution`);
    }
    if (["RESOLVED", "VOID"].includes(market.status) && !market.resolvedAt) errors.push(`${label}: terminal market lacks resolution timestamp`);
    if (market.volumeMilli < 0n || market.yesShares < 0 || market.noShares < 0) errors.push(`${label}: negative volume or shares`);
    const yes = market.positions.reduce((sum, position) => sum + position.yesShares, 0);
    const no = market.positions.reduce((sum, position) => sum + position.noShares, 0);
    if (yes !== market.yesShares || no !== market.noShares) errors.push(`${label}: aggregate positions do not match market shares`);
    for (const position of market.positions) {
      checkDate(`position ${position.id}`, position.createdAt);
      if (position.yesShares < 0 || position.noShares < 0 || position.reservedYesShares < 0 || position.reservedNoShares < 0) errors.push(`position ${position.id}: negative shares`);
    }
    if (market.pricingModel !== "LMSR") {
      errors.push(`${label}: development history validation currently supports LMSR only`);
      continue;
    }
    if (market.trades.reduce((sum, trade) => sum + trade.amountMilli, 0n) !== market.volumeMilli) errors.push(`${label}: volume does not equal executed gross trade amounts`);
    if (new Set(market.trades.map((trade) => trade.userId)).size !== market.traderCount) errors.push(`${label}: trader count does not match unique traders`);
    const snapshotKeys = new Set(market.priceHistory.map((point) => `${point.createdAt.getTime()}:${point.yesProbabilityBps}`));
    const tradeKeys = new Set(market.trades.map((trade) => `${trade.createdAt.getTime()}:${trade.priceAfterBps}`));
    for (const trade of market.trades) {
      checkDate(`trade ${trade.id}`, trade.createdAt);
      if (trade.createdAt < market.createdAt || trade.createdAt >= market.closesAt) errors.push(`trade ${trade.id}: outside market trading window`);
      if (trade.quantity <= 0 || trade.amountMilli <= 0n || trade.feeMilli < 0n) errors.push(`trade ${trade.id}: invalid quantity or amounts`);
      probability(`trade ${trade.id} before`, trade.priceBeforeBps);
      probability(`trade ${trade.id} after`, trade.priceAfterBps);
      if (!snapshotKeys.has(`${trade.createdAt.getTime()}:${trade.priceAfterBps}`)) errors.push(`trade ${trade.id}: matching price snapshot missing`);
      const entries = tradeJournals.get(trade.id) ?? [];
      if (entries.length !== 1) errors.push(`trade ${trade.id}: expected one journal entry`);
      else {
        const journalDelay = entries[0].createdAt.getTime() - trade.createdAt.getTime();
        // Historical replay assigns one exact instant. Live service writes retain
        // their real transaction timestamps, which can be a few milliseconds apart.
        if (trade.idempotencyKey.startsWith("simulation-trade-") ? journalDelay !== 0 : journalDelay < 0 || journalDelay > 30_000) {
          errors.push(`trade ${trade.id}: journal time differs from execution`);
        }
      }
    }
    for (const point of market.priceHistory) {
      checkDate(`snapshot ${point.id}`, point.createdAt);
      probability(`snapshot ${point.id}`, point.yesProbabilityBps);
      if (point.createdAt < market.createdAt) errors.push(`snapshot ${point.id}: predates market`);
      const initial = point.createdAt.getTime() === market.createdAt.getTime() && point.yesProbabilityBps === 5_000;
      const terminal = market.resolvedAt?.getTime() === point.createdAt.getTime()
        && point.yesProbabilityBps === (market.resolution === "YES" ? 10_000 : market.resolution === "NO" ? 0 : 5_000);
      if (!initial && !terminal && !tradeKeys.has(`${point.createdAt.getTime()}:${point.yesProbabilityBps}`)) errors.push(`snapshot ${point.id}: no matching execution, initial state, or settlement`);
      if (!terminal && point.createdAt >= market.closesAt) errors.push(`snapshot ${point.id}: trading history at or after market close`);
    }
    for (const settlement of market.settlements) {
      checkDate(`settlement ${settlement.id}`, settlement.createdAt);
      if (settlement.createdAt < market.resolvesAt) errors.push(`settlement ${settlement.id}: before resolution schedule`);
      if (settlement.payoutMilli < 0n) errors.push(`settlement ${settlement.id}: negative payout`);
    }
    for (const proposal of market.resolutionProposals) {
      checkDate(`proposal ${proposal.id}`, proposal.createdAt);
      if (proposal.decidedAt) {
        checkDate(`proposal ${proposal.id} decidedAt`, proposal.decidedAt);
        if (proposal.decidedAt < proposal.createdAt) errors.push(`proposal ${proposal.id}: decision before proposal`);
      }
      if (proposal.status === "APPROVED" && proposal.approverId === proposal.proposerId) errors.push(`proposal ${proposal.id}: proposer approved their own resolution`);
    }
  }
  const equityByUser = new Map(users.map(user => [user.id, user.balanceMilli]));
  for (const market of markets) for (const position of market.pricingModel === "LMSR" ? market.positions : []) {
    equityByUser.set(position.userId, (equityByUser.get(position.userId) ?? 0n) + developmentPositionValueMilli(market, position));
  }
  const targetEquityResiduals: EquityResidual[] = [];
  for (const [email, targetMilli] of Object.entries(options.targetEquityMilliByEmail ?? {})) {
    const user = knownByEmail.get(email);
    if (!user) {
      errors.push(`target equity ${email}: participant missing`);
      continue;
    }
    const actualMilli = equityByUser.get(user.id) ?? user.balanceMilli;
    const residualMilli = actualMilli - targetMilli;
    const absoluteResidualMilli = residualMilli < 0n ? -residualMilli : residualMilli;
    const withinTolerance = absoluteResidualMilli <= targetTolerance;
    targetEquityResiduals.push({
      email, userId: user.id, username: user.username,
      targetMilli: targetMilli.toString(), actualMilli: actualMilli.toString(),
      residualMilli: residualMilli.toString(), absoluteResidualMilli: absoluteResidualMilli.toString(),
      withinTolerance,
    });
    if (!withinTolerance) errors.push(`participant ${email}: target equity residual ${residualMilli} milli-feathers exceeds tolerance ${targetTolerance}`);
  }
  targetEquityResiduals.sort((left, right) => left.email.localeCompare(right.email));
  return {
    errors,
    targetEquityResiduals,
    counts: {
      users: users.length, events: events.length, markets: markets.length,
      trades: markets.reduce((sum, market) => sum + market.trades.length, 0),
      snapshots: markets.reduce((sum, market) => sum + market.priceHistory.length, 0),
      accounts: accounts.length, journals: journals.length,
      settlements: markets.reduce((sum, market) => sum + market.settlements.length, 0),
    },
  };
}
