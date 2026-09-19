import type { PrismaClient } from "@prisma/client";

/** Read-only checks deliberately independent of the trading arithmetic helpers. */
export async function validateDevelopmentData(client: PrismaClient, options: { asOf: Date }) {
  const errors: string[] = [];
  const cutoff = options.asOf.getTime();
  if (!Number.isFinite(cutoff)) throw new Error("Validation requires a valid asOf date.");
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
      if (trade.quantity <= 0 || trade.amountMilli < 0n || trade.feeMilli < 0n) errors.push(`trade ${trade.id}: invalid quantity or amounts`);
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
  return {
    errors,
    counts: {
      users: users.length, events: events.length, markets: markets.length,
      trades: markets.reduce((sum, market) => sum + market.trades.length, 0),
      snapshots: markets.reduce((sum, market) => sum + market.priceHistory.length, 0),
      accounts: accounts.length, journals: journals.length,
      settlements: markets.reduce((sum, market) => sum + market.settlements.length, 0),
    },
  };
}
