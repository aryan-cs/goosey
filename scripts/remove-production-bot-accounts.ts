/**
 * One-time, operator-authorized cleanup for the September 19 test-account incident.
 *
 * Preview is read-only. Apply requires the exact production destination and an
 * explicit confirmation. The LMSR history is replayed without the bot trades so
 * legitimate executions and every accounting cache remain mutually consistent.
 */
import { createHash } from "node:crypto";
import { Prisma } from "@prisma/client";
import { db, requireDatabaseStartup } from "../src/lib/db";
import { requiredCollateralMilli } from "../src/lib/market-maker";
import { notificationFeathers } from "../src/lib/order-fill-notification";
import { computeQuote } from "../src/lib/trading";

const MARKET_ID = "cmu8tqf120002gm6k0gw5vxgl";
const MARKET_SLUG = "htn-2026-all-toronto-team-wins";
const PUBLISHER_ID = "goosey-market-publisher-v1";
const APPLY_CONFIRMATION = "2026-09-20-test-and-asdf-bot-replay";
const EXPECTED_ACTIVE = new Map([
  ["test1", "cmu8wfl20000lic040xxx0dfm"],
  ["test11", "cmu8wrrxa000blb044szi94ys"],
  ["test12", "cmu8wtzsh002tjs04uk8vg2rh"],
  ["test13", "cmu8wudi3001jla04g3fbsukp"],
  ["test14", "cmu8wumg5000ul004vla4vs3s"],
  ["test15", "cmu8wuves002ylj04issdlei0"],
  ["test16", "cmu918w5e0000l404j96rh1ls"],
  ["test17", "cmu91alg3000jjo044ffxfe0h"],
  ["test18", "cmu91awly000sl404tp1v71mw"],
  ["test19", "cmu91b31b000wjp04ctis8wuk"],
  ["test20", "cmu91b8ri0017jp04v2peulaj"],
  ["asdf11", "cmu8x1uqv0029kz048b1mx28n"],
  ["asdf12", "cmu8x55c30000k104gs9krc7o"],
  ["asdf13", "cmu8x6qu50002l304cegd4xe6"],
  ["asdf14", "cmu8x71o4000dl304tyziwvhl"],
  ["asdf15", "cmu8x7yqb0027k104zn2kxwxa"],
  ["asdf16", "cmu91uay30000kx04jul0y5gf"],
  ["asdf17", "cmu91xtsb0000l504ny7nc28q"],
]);
const INCIDENT_NAMES = new Set(EXPECTED_ACTIVE.keys());

type PositionState = {
  yesShares: number; noShares: number; netCostMilli: bigint;
  yesCostBasisMilli: bigint; noCostBasisMilli: bigint; realizedPnlMilli: bigint;
};
type ReplayTrade = Awaited<ReturnType<typeof loadIncident>>["trades"][number] & {
  version: number;
  journal: Awaited<ReturnType<typeof loadIncident>>["journals"][number];
};

const zeroPosition = (): PositionState => ({
  yesShares: 0, noShares: 0, netCostMilli: 0n,
  yesCostBasisMilli: 0n, noCostBasisMilli: 0n, realizedPnlMilli: 0n,
});

function fail(message: string): never { throw new Error(`Bot cleanup refused: ${message}`); }
function json(value: unknown) {
  return JSON.stringify(value, (_, item) => typeof item === "bigint" ? item.toString() : item, 2);
}
function parseVersion(metadata: string): number {
  let value: unknown;
  try { value = JSON.parse(metadata); } catch { fail("trade journal metadata is not JSON"); }
  const version = value && typeof value === "object" && "marketVersion" in value
    ? (value as { marketVersion?: unknown }).marketVersion : undefined;
  if (!Number.isSafeInteger(version) || Number(version) < 0) fail("trade journal lacks a valid marketVersion");
  return Number(version);
}
function formerUsername(metadata: string): string | null {
  try {
    const value = JSON.parse(metadata) as { formerUsername?: unknown };
    return typeof value.formerUsername === "string" ? value.formerUsername : null;
  } catch { return null; }
}
function applyPosition(state: PositionState, trade: Pick<ReplayTrade, "side" | "action" | "quantity">, quote: ReturnType<typeof computeQuote>) {
  const side = trade.side as "YES" | "NO";
  const action = trade.action as "BUY" | "SELL";
  const held = side === "YES" ? state.yesShares : state.noShares;
  const sideBasis = side === "YES" ? state.yesCostBasisMilli : state.noCostBasisMilli;
  if (action === "SELL" && held < trade.quantity) fail(`trade attempts to sell unavailable ${side} shares`);
  const basisRemoved = action === "SELL" && held > 0 ? sideBasis * BigInt(trade.quantity) / BigInt(held) : 0n;
  const costDelta = action === "BUY" ? quote.totalDebitMilli! : -basisRemoved;
  const realizedDelta = action === "SELL" ? quote.netCreditMilli! - basisRemoved : 0n;
  state.yesShares += side === "YES" ? (action === "BUY" ? trade.quantity : -trade.quantity) : 0;
  state.noShares += side === "NO" ? (action === "BUY" ? trade.quantity : -trade.quantity) : 0;
  state.netCostMilli += costDelta;
  if (side === "YES") state.yesCostBasisMilli += costDelta;
  else state.noCostBasisMilli += costDelta;
  state.realizedPnlMilli += realizedDelta;
  return realizedDelta;
}

async function loadIncident(tx: typeof db) {
  const [market, users, audits, trades, journals, positions, snapshots] = await Promise.all([
    tx.market.findUnique({ where: { id: MARKET_ID }, include: { collateralAccount: true } }),
    tx.user.findMany({ where: { OR: [
      { username: { in: [...INCIDENT_NAMES] } },
      { id: { in: [...EXPECTED_ACTIVE.values()] } },
    ] } }),
    tx.auditLog.findMany({ where: { entityType: "USER", action: "TEST_ACCOUNT_REMOVED" } }),
    tx.trade.findMany({ where: { marketId: MARKET_ID } }),
    tx.journalEntry.findMany({
      where: { referenceType: "TRADE", referenceId: { not: "" } },
      include: { postings: { include: { ledgerAccount: true } } },
    }),
    tx.position.findMany({ where: { marketId: MARKET_ID } }),
    tx.marketPriceSnapshot.findMany({ where: { marketId: MARKET_ID } }),
  ]);
  if (!market || market.slug !== MARKET_SLUG || market.pricingModel !== "LMSR" || market.executionBackend !== "DATABASE") fail("reviewed market identity changed");
  const auditedTargetIds = audits.map(audit => ({ id: audit.entityId, name: formerUsername(audit.metadata) })).filter(item => item.name && INCIDENT_NAMES.has(item.name));
  const loadedUserIds = new Set(users.map(user => user.id));
  const auditedUsers = auditedTargetIds.length ? await tx.user.findMany({ where: { id: { in: auditedTargetIds.map(item => item.id).filter(id => !loadedUserIds.has(id)) } } }) : [];
  users.push(...auditedUsers);
  const tradeIds = new Set(trades.map(trade => trade.id));
  const tradeUsers = [...new Set(trades.map(trade => trade.userId))];
  const [requests, notifications] = await Promise.all([
    tx.idempotencyRequest.findMany({ where: { route: `/api/markets/${MARKET_ID}/trades`, userId: { in: tradeUsers } } }),
    tx.notification.findMany({ where: { userId: { in: tradeUsers }, type: "TRADE_CONFIRMED", href: `/markets/${MARKET_SLUG}` } }),
  ]);
  const marketUsers = await tx.user.findMany({
    where: { id: { in: tradeUsers } },
    select: { id: true, username: true, displayName: true, role: true, status: true, createdAt: true },
  });
  return { market, users, marketUsers, audits, trades, journals: journals.filter(journal => tradeIds.has(journal.referenceId)), positions, snapshots, requests, notifications };
}

export function buildReplay(input: Awaited<ReturnType<typeof loadIncident>>) {
  const nameById = new Map<string, string>();
  for (const user of input.users) if (INCIDENT_NAMES.has(user.username)) nameById.set(user.id, user.username);
  for (const audit of input.audits) {
    const name = formerUsername(audit.metadata);
    if (name && INCIDENT_NAMES.has(name)) nameById.set(audit.entityId, name);
  }
  for (const [name, id] of EXPECTED_ACTIVE) {
    const user = input.users.find(candidate => candidate.id === id);
    if (!user || user.username !== name || user.role !== "USER" || user.status !== "ACTIVE") fail(`expected active identity ${name}/${id} changed`);
  }
  const duplicateNames = [...nameById.values()].filter((name, index, all) => all.indexOf(name) !== index);
  if (duplicateNames.length) fail(`duplicate incident identities: ${duplicateNames.join(", ")}`);
  const targetIds = new Set(nameById.keys());
  const discoveredNames = new Set(nameById.values());
  if (targetIds.size !== INCIDENT_NAMES.size || discoveredNames.size !== INCIDENT_NAMES.size || [...INCIDENT_NAMES].some(name => !discoveredNames.has(name))) fail("preview did not discover exactly the reviewed test/asdf bot identities");
  if ([...targetIds].some(id => !input.users.some(user => user.id === id && user.role === "USER"))) fail("a reviewed incident identity is missing or is no longer an ordinary user");

  const journalByTrade = new Map<string, typeof input.journals[number]>();
  for (const journal of input.journals) {
    if (journalByTrade.has(journal.referenceId)) fail(`multiple journals reference trade ${journal.referenceId}`);
    if (journal.status !== "POSTED") fail(`trade journal ${journal.id} is not posted`);
    journalByTrade.set(journal.referenceId, journal);
  }
  const ordered: ReplayTrade[] = input.trades.map(trade => {
    const journal = journalByTrade.get(trade.id);
    if (!journal) fail(`trade ${trade.id} has no journal`);
    return { ...trade, journal, version: parseVersion(journal.metadata) };
  }).sort((left, right) => left.version - right.version);
  if (ordered.length !== input.trades.length || ordered.some((trade, index) => trade.version !== index)) fail("marketVersion chain is not a complete zero-based sequence");
  if (input.market.version !== ordered.length) fail(`market version ${input.market.version} does not match ${ordered.length} executions`);

  const existingPositions = new Map<string, PositionState>();
  const originalQuoteByTrade = new Map<string, ReturnType<typeof computeQuote>>();
  let state = { yesShares: 0, noShares: 0 };
  let oldVolume = 0n;
  for (const trade of ordered) {
    const quote = computeQuote({ ...input.market, ...state }, trade.side as "YES" | "NO", trade.action as "BUY" | "SELL", trade.quantity);
    originalQuoteByTrade.set(trade.id, quote);
    if (quote.grossMilli !== trade.amountMilli || quote.feeMilli !== trade.feeMilli ||
        quote.probabilityYesBeforeBps !== trade.priceBeforeBps || quote.probabilityYesAfterBps !== trade.priceAfterBps) {
      fail(`stored execution ${trade.id} does not reproduce at version ${trade.version}: ${json({
        state,
        stored: { grossMilli: trade.amountMilli, feeMilli: trade.feeMilli, before: trade.priceBeforeBps, after: trade.priceAfterBps },
        replayed: { grossMilli: quote.grossMilli, feeMilli: quote.feeMilli, before: quote.probabilityYesBeforeBps, after: quote.probabilityYesAfterBps },
      })}`);
    }
    const userPosting = trade.journal.postings.filter(posting => posting.ledgerAccount.ownerType === "USER" && posting.ledgerAccount.ownerId === trade.userId);
    const collateralPosting = trade.journal.postings.filter(posting => posting.ledgerAccountId === input.market.collateralAccountId);
    const revenuePosting = trade.journal.postings.filter(posting => posting.ledgerAccount.purpose === "PROTOCOL_REVENUE");
    const expectedUser = trade.action === "BUY" ? -quote.totalDebitMilli! : quote.netCreditMilli!;
    const expectedCollateral = trade.action === "BUY" ? quote.grossMilli : -quote.grossMilli;
    if (userPosting.length !== 1 || userPosting[0].amountMilli !== expectedUser || collateralPosting.length !== 1 || collateralPosting[0].amountMilli !== expectedCollateral ||
        (quote.feeMilli === 0n ? revenuePosting.length !== 0 : revenuePosting.length !== 1 || revenuePosting[0].amountMilli !== quote.feeMilli) ||
        trade.journal.postings.reduce((sum, posting) => sum + posting.amountMilli, 0n) !== 0n) fail(`trade journal ${trade.journal.id} does not reproduce`);
    const position = existingPositions.get(trade.userId) ?? zeroPosition();
    applyPosition(position, trade, quote); existingPositions.set(trade.userId, position);
    state = { yesShares: quote.yesSharesAfter, noShares: quote.noSharesAfter };
    oldVolume += quote.grossMilli;
  }
  if (state.yesShares !== input.market.yesShares || state.noShares !== input.market.noShares || oldVolume !== input.market.volumeMilli) fail("market aggregate does not reproduce from its executions");
  for (const [userId, expected] of existingPositions) {
    const actual = input.positions.find(position => position.userId === userId);
    if (!actual || actual.yesShares !== expected.yesShares || actual.noShares !== expected.noShares ||
        actual.netCostMilli !== expected.netCostMilli || actual.yesCostBasisMilli !== expected.yesCostBasisMilli ||
        actual.noCostBasisMilli !== expected.noCostBasisMilli || actual.realizedPnlMilli !== expected.realizedPnlMilli ||
        actual.reservedYesShares !== 0 || actual.reservedNoShares !== 0) fail(`position ${userId} does not reproduce`);
  }

  const surviving = ordered.filter(trade => !targetIds.has(trade.userId));
  const replayPositions = new Map<string, PositionState>();
  const replay = [] as Array<{ trade: ReplayTrade; quote: ReturnType<typeof computeQuote>; realizedDelta: bigint; version: number }>;
  state = { yesShares: 0, noShares: 0 };
  let volumeMilli = 0n;
  for (const [version, trade] of surviving.entries()) {
    const quote = computeQuote({ ...input.market, ...state }, trade.side as "YES" | "NO", trade.action as "BUY" | "SELL", trade.quantity);
    const position = replayPositions.get(trade.userId) ?? zeroPosition();
    const realizedDelta = applyPosition(position, trade, quote); replayPositions.set(trade.userId, position);
    replay.push({ trade, quote, realizedDelta, version });
    state = { yesShares: quote.yesSharesAfter, noShares: quote.noSharesAfter };
    volumeMilli += quote.grossMilli;
  }
  if (input.requests.some(request => request.status === "PROCESSING" && ordered.some(trade => trade.userId === request.userId && trade.idempotencyKey === request.key))) fail("an incident-market idempotency request is still processing");
  const notificationByTrade = new Map<string, typeof input.notifications[number]>();
  for (const trade of surviving) {
    const originalQuote = originalQuoteByTrade.get(trade.id)!;
    const title = `${trade.action === "BUY" ? "Bought" : "Sold"} ${trade.quantity} ${trade.side}`;
    const average = notificationFeathers(originalQuote.averagePriceMilli);
    const matches = input.notifications.filter(notification => notification.userId === trade.userId && notification.title === title && notification.body.includes(average) && ![...notificationByTrade.values()].some(used => used.id === notification.id));
    if (matches.length !== 1) fail(`surviving trade ${trade.id} does not have one unambiguous notification`);
    notificationByTrade.set(trade.id, matches[0]);
  }
  const snapshotByTrade = new Map<string, typeof input.snapshots[number]>();
  const usedSnapshots = new Set<string>();
  for (const trade of ordered) {
    const matches = input.snapshots.filter(snapshot => snapshot.createdAt.getTime() === trade.createdAt.getTime() && snapshot.yesProbabilityBps === trade.priceAfterBps && !usedSnapshots.has(snapshot.id));
    if (matches.length !== 1) fail(`trade ${trade.id} does not have one unambiguous timestamp-and-price snapshot`);
    snapshotByTrade.set(trade.id, matches[0]); usedSnapshots.add(matches[0].id);
  }
  const openingSnapshots = input.snapshots.filter(snapshot => !usedSnapshots.has(snapshot.id));
  if (openingSnapshots.length !== 1 || openingSnapshots[0].yesProbabilityBps !== 5_000) fail("market must retain exactly one 50% opening snapshot outside executions");
  const digest = createHash("sha256").update(json({ marketId: MARKET_ID, targetIds: [...targetIds].sort(), trades: ordered.map(t => [t.id, t.userId, t.version]), currentVersion: input.market.version })).digest("hex");
  const expectedPositionIds = new Set(existingPositions.keys());
  if (input.positions.length !== expectedPositionIds.size || input.positions.some(position => !expectedPositionIds.has(position.userId))) fail("market contains a position not represented by its trade replay");
  return { nameById, targetIds, ordered, existingPositions, originalQuoteByTrade, surviving, replayPositions, replay, snapshotByTrade, notificationByTrade, digest, state, volumeMilli };
}

async function assertTransactionReconciles(tx: Parameters<Parameters<typeof db.$transaction>[0]>[0], marketId: string) {
  const [journals, accounts, users, market] = await Promise.all([
    tx.journalEntry.findMany({ where: { status: "POSTED" }, include: { postings: true } }),
    tx.ledgerAccount.findMany({ include: { postings: { include: { journalEntry: { select: { status: true } } } } } }),
    tx.user.findMany({ where: { role: "USER" }, select: { id: true, balanceMilli: true } }),
    tx.market.findUnique({ where: { id: marketId }, include: { positions: true, collateralAccount: true } }),
  ]);
  for (const journal of journals) if (journal.postings.reduce((sum, posting) => sum + posting.amountMilli, 0n) !== 0n) fail(`post-cleanup journal ${journal.id} is unbalanced`);
  const accountByOwner = new Map<string, typeof accounts[number]>();
  for (const account of accounts) {
    const posted = account.postings.filter(posting => posting.journalEntry.status === "POSTED").reduce((sum, posting) => sum + posting.amountMilli, 0n);
    if (posted !== account.balanceMilli) fail(`post-cleanup ledger account ${account.id} cache differs from postings`);
    if (!account.allowsNegative && account.balanceMilli < 0n) fail(`post-cleanup ledger account ${account.id} is negative`);
    if (account.ownerType === "USER" && account.ownerId && account.purpose === "USER_FEATHERS") accountByOwner.set(account.ownerId, account);
  }
  for (const user of users) if (accountByOwner.get(user.id)?.balanceMilli !== user.balanceMilli) fail(`post-cleanup user ${user.id} differs from wallet`);
  if (!market || !market.collateralAccount) fail("post-cleanup market/collateral is missing");
  if (market.positions.reduce((sum, position) => sum + position.yesShares, 0) !== market.yesShares || market.positions.reduce((sum, position) => sum + position.noShares, 0) !== market.noShares) fail("post-cleanup position shares differ from market totals");
  const required = requiredCollateralMilli({ yesQuantity: market.yesShares, noQuantity: market.noShares, liquidity: market.liquidityParameter, payoutMilli: market.payoutMilli });
  if (market.collateralAccount.balanceMilli < required) fail("post-cleanup market is undercollateralized");
}

async function assertTargetDependencies(tx: typeof db, targetIds: string[]) {
  const [orders, orderEvents, comments, createdMarkets, createdEvents, eventRequests, suggestions, suggestionsReviewed, proposals, approvals, runs, settlements, invites, claims, auditActors, reports, reportResolutions, reservations, commands, fills, walletChallenges, walletLinks, custodyIdentities] = await Promise.all([
    tx.marketOrder.count({ where: { userId: { in: targetIds } } }), tx.orderEvent.count({ where: { userId: { in: targetIds } } }),
    tx.comment.count({ where: { userId: { in: targetIds } } }),
    tx.market.count({ where: { createdById: { in: targetIds } } }), tx.marketEvent.count({ where: { createdById: { in: targetIds } } }),
    tx.marketEventCreationRequest.count({ where: { actorUserId: { in: targetIds } } }), tx.marketSuggestion.count({ where: { userId: { in: targetIds } } }), tx.marketSuggestion.count({ where: { reviewedById: { in: targetIds } } }),
    tx.marketResolutionProposal.count({ where: { proposerId: { in: targetIds } } }), tx.marketResolutionProposal.count({ where: { approverId: { in: targetIds } } }),
    tx.marketSettlementRun.count({ where: { approvedById: { in: targetIds } } }), tx.positionSettlement.count({ where: { userId: { in: targetIds } } }), tx.registrationInvite.count({ where: { createdById: { in: targetIds } } }),
    tx.registrationInviteClaim.count({ where: { userId: { in: targetIds } } }), tx.auditLog.count({ where: { actorUserId: { in: targetIds } } }),
    tx.commentReport.count({ where: { reporterId: { in: targetIds } } }), tx.commentReport.count({ where: { resolvedById: { in: targetIds } } }),
    tx.orderReservation.count({ where: { userId: { in: targetIds } } }), tx.orderCommand.count({ where: { actorUserId: { in: targetIds } } }),
    tx.orderFill.count({ where: { OR: [{ makerOrder: { userId: { in: targetIds } } }, { takerOrder: { userId: { in: targetIds } } }] } }),
    tx.solanaWalletLinkChallenge.count({ where: { userId: { in: targetIds } } }), tx.solanaWalletLink.count({ where: { userId: { in: targetIds } } }), tx.solanaCustodyIdentity.count({ where: { userId: { in: targetIds } } }),
  ]);
  const counts = { orders, orderEvents, comments, createdMarkets, createdEvents, eventRequests, suggestions, suggestionsReviewed, proposals, approvals, runs, settlements, invites, claims, auditActors, reports, reportResolutions, reservations, commands, fills, walletChallenges, walletLinks, custodyIdentities };
  const nonzero = Object.entries(counts).filter(([, count]) => count !== 0);
  if (nonzero.length) fail(`unexpected target dependencies: ${json(Object.fromEntries(nonzero))}`);
  const outsideTrades = await tx.trade.count({ where: { userId: { in: targetIds }, marketId: { not: MARKET_ID } } });
  const outsidePositions = await tx.position.count({ where: { userId: { in: targetIds }, marketId: { not: MARKET_ID } } });
  if (outsideTrades || outsidePositions) fail("a target account has financial activity outside the reviewed market");
}

async function applyCleanup() {
  return db.$transaction(async tx => {
    await tx.$queryRawUnsafe(`SELECT id FROM "Market" WHERE id = '${MARKET_ID}' FOR UPDATE`);
    const input = await loadIncident(tx as typeof db);
    const plan = buildReplay(input);
    const targetIds = [...plan.targetIds];
    await assertTargetDependencies(tx as typeof db, targetIds);
    const marketRoute = `/api/markets/${MARKET_ID}/trades`;
    const suppliedDigest = process.env.GOOSEY_BOT_CLEANUP_DIGEST;
    if (!suppliedDigest || suppliedDigest !== plan.digest) fail(`preview digest mismatch; expected ${plan.digest}`);
    const publisher = await tx.user.findUnique({ where: { id: PUBLISHER_ID } });
    if (!publisher || publisher.role !== "ADMIN" || publisher.status !== "ACTIVE") fail("audit publisher is unavailable");

    const userWallet = new Map((await tx.ledgerAccount.findMany({ where: { ownerType: "USER", ownerId: { in: [...new Set(plan.ordered.map(t => t.userId))] }, purpose: "USER_FEATHERS" } })).map(account => [account.ownerId!, account]));
    const revenue = await tx.ledgerAccount.findUnique({ where: { ownerType_ownerId_purpose: { ownerType: "SYSTEM", ownerId: "GOOSEY", purpose: "PROTOCOL_REVENUE" } } });
    const oldUserCash = new Map<string, bigint>();
    let oldRevenue = 0n;
    for (const trade of plan.ordered) for (const posting of trade.journal.postings) {
      if (posting.ledgerAccount.ownerType === "USER") oldUserCash.set(trade.userId, (oldUserCash.get(trade.userId) ?? 0n) + posting.amountMilli);
      if (posting.ledgerAccount.purpose === "PROTOCOL_REVENUE") oldRevenue += posting.amountMilli;
    }
    const newUserCash = new Map<string, bigint>(); let newRevenue = 0n;
    for (const item of plan.replay) {
      const delta = item.trade.action === "BUY" ? -item.quote.totalDebitMilli! : item.quote.netCreditMilli!;
      newUserCash.set(item.trade.userId, (newUserCash.get(item.trade.userId) ?? 0n) + delta); newRevenue += item.quote.feeMilli;
    }
    for (const userId of new Set([...oldUserCash.keys(), ...newUserCash.keys()])) {
      if (plan.targetIds.has(userId)) continue;
      const delta = (newUserCash.get(userId) ?? 0n) - (oldUserCash.get(userId) ?? 0n);
      const oldRealized = plan.existingPositions.get(userId)?.realizedPnlMilli ?? 0n;
      const newRealized = plan.replayPositions.get(userId)?.realizedPnlMilli ?? 0n;
      const wallet = userWallet.get(userId); if (!wallet) fail(`surviving user ${userId} lacks a wallet`);
      await tx.user.update({ where: { id: userId }, data: { balanceMilli: { increment: delta }, realizedPnlMilli: { increment: newRealized - oldRealized } } });
      await tx.ledgerAccount.update({ where: { id: wallet.id }, data: { balanceMilli: { increment: delta } } });
    }
    if ((oldRevenue !== 0n || newRevenue !== 0n) && !revenue) fail("protocol revenue account is missing");
    if (revenue) await tx.ledgerAccount.update({ where: { id: revenue.id }, data: { balanceMilli: { increment: newRevenue - oldRevenue } } });

    const oldCollateralDelta = plan.ordered.reduce((sum, trade) => sum + trade.journal.postings.filter(p => p.ledgerAccountId === input.market.collateralAccountId).reduce((s, p) => s + p.amountMilli, 0n), 0n);
    const newCollateralDelta = plan.replay.reduce((sum, item) => sum + (item.trade.action === "BUY" ? item.quote.grossMilli : -item.quote.grossMilli), 0n);
    await tx.ledgerAccount.update({ where: { id: input.market.collateralAccountId! }, data: { balanceMilli: input.market.collateralAccount!.balanceMilli - oldCollateralDelta + newCollateralDelta } });
    // Keep the concurrency token monotonic. Reusing an old version creates an
    // ABA window in which a pre-cleanup quote could become valid again.
    await tx.market.update({ where: { id: MARKET_ID }, data: { yesShares: plan.state.yesShares, noShares: plan.state.noShares, volumeMilli: plan.volumeMilli, traderCount: new Set(plan.surviving.map(t => t.userId)).size, version: input.market.version + 1 } });

    for (const item of plan.replay) {
      const wallet = userWallet.get(item.trade.userId)!;
      await tx.trade.update({ where: { id: item.trade.id }, data: { amountMilli: item.quote.grossMilli, feeMilli: item.quote.feeMilli, priceBeforeBps: item.quote.probabilityYesBeforeBps, priceAfterBps: item.quote.probabilityYesAfterBps } });
      await tx.ledgerPosting.deleteMany({ where: { journalEntryId: item.trade.journal.id } });
      const postings = [
        { journalEntryId: item.trade.journal.id, ledgerAccountId: wallet.id, amountMilli: item.trade.action === "BUY" ? -item.quote.totalDebitMilli! : item.quote.netCreditMilli!, createdAt: item.trade.journal.createdAt },
        { journalEntryId: item.trade.journal.id, ledgerAccountId: input.market.collateralAccountId!, amountMilli: item.trade.action === "BUY" ? item.quote.grossMilli : -item.quote.grossMilli, createdAt: item.trade.journal.createdAt },
        ...(item.quote.feeMilli > 0n ? [{ journalEntryId: item.trade.journal.id, ledgerAccountId: revenue!.id, amountMilli: item.quote.feeMilli, createdAt: item.trade.journal.createdAt }] : []),
      ];
      await tx.ledgerPosting.createMany({ data: postings });
      const metadata = JSON.parse(item.trade.journal.metadata) as Record<string, unknown>; metadata.marketVersion = item.version;
      await tx.journalEntry.update({ where: { id: item.trade.journal.id }, data: { metadata: JSON.stringify(metadata) } });
      await tx.marketPriceSnapshot.update({ where: { id: plan.snapshotByTrade.get(item.trade.id)!.id }, data: { yesProbabilityBps: item.quote.probabilityYesAfterBps } });
      await tx.notification.update({ where: { id: plan.notificationByTrade.get(item.trade.id)!.id }, data: { body: `Your ${input.market.shortTitle} trade was confirmed at an average of ${notificationFeathers(item.quote.averagePriceMilli)} feathers per contract.` } });
    }

    const targetTrades = plan.ordered.filter(trade => plan.targetIds.has(trade.userId));
    await tx.marketPriceSnapshot.deleteMany({ where: { id: { in: targetTrades.map(trade => plan.snapshotByTrade.get(trade.id)!.id) } } });
    await tx.ledgerPosting.deleteMany({ where: { journalEntryId: { in: targetTrades.map(trade => trade.journal.id) } } });
    await tx.journalEntry.deleteMany({ where: { id: { in: targetTrades.map(trade => trade.journal.id) } } });
    await tx.trade.deleteMany({ where: { id: { in: targetTrades.map(trade => trade.id) } } });
    await tx.tradeQuote.deleteMany({ where: { userId: { in: targetIds } } });
    await tx.idempotencyRequest.deleteMany({ where: { OR: plan.ordered.map(trade => ({ userId: trade.userId, route: marketRoute, key: trade.idempotencyKey })) } });
    await tx.idempotencyRequest.deleteMany({ where: { userId: { in: targetIds } } });

    for (const [userId, state] of plan.replayPositions) await tx.position.update({ where: { userId_marketId: { userId, marketId: MARKET_ID } }, data: state });
    await tx.position.deleteMany({ where: { userId: { in: targetIds } } });
    const grants = await tx.journalEntry.findMany({ where: { actorUserId: { in: targetIds }, type: "WELCOME_GRANT", referenceType: "USER" }, include: { postings: { include: { ledgerAccount: true } } } });
    if (grants.length !== targetIds.length || new Set(grants.map(grant => grant.actorUserId)).size !== targetIds.length) fail("each target must have exactly one welcome grant");
    for (const grant of grants) {
      const issuancePosting = grant.postings.find(posting => posting.ledgerAccount.purpose === "ISSUANCE");
      if (!issuancePosting || issuancePosting.amountMilli >= 0n) fail(`welcome grant ${grant.id} lacks its issuance debit`);
      await tx.ledgerAccount.update({ where: { id: issuancePosting.ledgerAccountId }, data: { balanceMilli: { decrement: issuancePosting.amountMilli } } });
    }
    await tx.ledgerPosting.deleteMany({ where: { journalEntryId: { in: grants.map(grant => grant.id) } } });
    await tx.journalEntry.deleteMany({ where: { id: { in: grants.map(grant => grant.id) } } });
    const remainingJournals = await tx.journalEntry.count({ where: { actorUserId: { in: targetIds } } });
    if (remainingJournals) fail("target journal activity remains after reviewed removal");
    await tx.ledgerAccount.deleteMany({ where: { ownerType: "USER", ownerId: { in: targetIds } } });
    const deviceRows = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`SELECT id FROM "RegistrationDevice" WHERE "userId" IN (${Prisma.join(targetIds)})`);
    const deviceIds = deviceRows.map(device => device.id);
    await tx.auditLog.create({ data: { actorUserId: publisher.id, action: "BOT_INCIDENT_REMOVED", entityType: "MARKET", entityId: MARKET_ID, metadata: json({ digest: plan.digest, removedAccounts: [...plan.nameById.entries()], removedTradeIds: targetTrades.map(t => t.id), replayedTradeIds: plan.surviving.map(t => t.id), retainedDeviceTombstones: deviceIds }) } });
    const deleted = await tx.user.deleteMany({ where: { id: { in: targetIds } } });
    if (deleted.count !== targetIds.length) fail("not every reviewed target account was deleted");
    if (deviceIds.length) {
      const linked = await tx.$queryRaw<Array<{ count: bigint }>>(Prisma.sql`SELECT COUNT(*)::bigint AS count FROM "RegistrationDevice" WHERE id IN (${Prisma.join(deviceIds)}) AND "userId" IS NOT NULL`);
      if (linked[0]?.count !== 0n) fail("a registration-device tombstone still references a deleted account");
    }
    await assertTransactionReconciles(tx, MARKET_ID);
    return { digest: plan.digest, removedAccounts: targetIds.length, removedTrades: targetTrades.length, replayedTrades: plan.surviving.length, retainedDeviceTombstones: deviceIds.length, market: { yesShares: plan.state.yesShares, noShares: plan.state.noShares, volumeMilli: plan.volumeMilli, version: input.market.version + 1 } };
  }, { isolationLevel: "Serializable", timeout: 60_000 });
}

async function main() {
  const mode = process.argv.includes("--apply") ? "apply" : "preview";
  if (process.env.VERCEL_ENV !== "production" || process.env.APP_URL !== "https://getgoosey.vercel.app" || process.env.DATABASE_PROVIDER !== "postgresql" || process.env.NEON_PROJECT_ID !== "round-mud-98593510") fail("destination identity mismatch");
  if (mode === "apply" && process.env.GOOSEY_BOT_CLEANUP_CONFIRM !== APPLY_CONFIRMATION) fail("apply confirmation mismatch");
  await requireDatabaseStartup();
  const registrationDeviceTable = await db.$queryRaw<Array<{ table_name: string | null }>>(Prisma.sql`SELECT to_regclass('"RegistrationDevice"')::text AS table_name`);
  if (!registrationDeviceTable[0]?.table_name) fail("RegistrationDevice migration is not deployed; deploy and verify the additive device-limit migration in an earlier release before previewing cleanup");
  if (mode === "apply") console.log(json({ mode, result: await applyCleanup() }));
  else {
    const input = await db.$transaction(async tx => { await tx.$executeRawUnsafe("SET TRANSACTION READ ONLY"); return loadIncident(tx as typeof db); }, { isolationLevel: "Serializable" });
    console.log(json({
      mode: "preview-diagnostics",
      market: MARKET_SLUG,
      marketUsers: input.marketUsers,
      trades: input.trades.map(trade => ({
        id: trade.id,
        userId: trade.userId,
        side: trade.side,
        action: trade.action,
        quantity: trade.quantity,
        createdAt: trade.createdAt,
      })),
    }));
    const plan = buildReplay(input);
    console.log(json({ mode, digest: plan.digest, market: MARKET_SLUG, discoveredAccounts: [...plan.nameById.entries()], removedTradeIds: plan.ordered.filter(t => plan.targetIds.has(t.userId)).map(t => t.id), survivingTradeIds: plan.surviving.map(t => t.id), projected: { yesShares: plan.state.yesShares, noShares: plan.state.noShares, volumeMilli: plan.volumeMilli, traderCount: new Set(plan.surviving.map(t => t.userId)).size }, next: `Set GOOSEY_BOT_CLEANUP_DIGEST=${plan.digest} and the exact apply confirmation only after reviewing this preview and a verified backup.` }));
  }
}

if (import.meta.url === `file://${process.argv[1]}`) main().finally(() => db.$disconnect());
