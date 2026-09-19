import { randomBytes } from "node:crypto";
import { PrismaClient } from "@goosey/postgresql-client";

import { ApiError } from "../src/lib/market-service";
import { db, databaseRuntime } from "../src/lib/db";
import { cancelOrder, placeOrder } from "../src/lib/order-exchange";
import { grantWelcomeFeathers, registerUser } from "../src/lib/auth";
import { runSerializableTransaction } from "../src/lib/serializable-transaction";

const PAYOUT_MILLI = 100_000n;
const FUNDING_MILLI = 100_000n;
const ORDER_PRICE_MILLI = 60_000n;
const suffix = randomBytes(8).toString("hex");
const fixtureScope = `postgres-exchange-concurrency:${suffix}`;

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function assertIsolatedPostgresRuntime(): void {
  if (databaseRuntime.provider !== "postgresql") {
    throw new Error("PostgreSQL exchange concurrency requires DATABASE_PROVIDER=postgresql.");
  }
  const runtimeUrl = new URL(databaseRuntime.datasourceUrl);
  const schema = runtimeUrl.searchParams.get("schema");
  if (!schema || !/^goosey_test_[0-9a-f]{16}$/.test(schema)) {
    throw new Error("Refusing to run outside an isolated goosey_test_<16 lowercase hex> schema.");
  }
}

type AcceptedPlacement = {
  accepted: true;
  order: { orderId: string };
};

function acceptedPlacement(value: unknown, label: string): AcceptedPlacement {
  if (
    typeof value !== "object" ||
    value === null ||
    !("accepted" in value) ||
    value.accepted !== true ||
    !("order" in value) ||
    typeof value.order !== "object" ||
    value.order === null ||
    !("orderId" in value.order) ||
    typeof value.order.orderId !== "string"
  ) {
    throw new Error(`${label} returned a fulfilled business rejection or malformed response.`);
  }
  return value as AcceptedPlacement;
}

async function createCreator() {
  return db.user.create({
    data: {
      email: `pg-exchange-creator-${suffix}@goosey.test`,
      username: `pg_exchange_creator_${suffix}`,
      displayName: "PostgreSQL exchange fixture creator",
      passwordHash: "postgres-exchange-concurrency-fixture-only",
      emailVerifiedAt: new Date(),
      role: "ADMIN",
      status: "ACTIVE",
    },
  });
}

async function createFundedUser(label: string) {
  return db.$transaction(async (tx) => {
    const user = await tx.user.create({
      data: {
        email: `pg-exchange-${label}-${suffix}@goosey.test`,
        username: `pg_exchange_${label}_${suffix}`,
        displayName: `PostgreSQL ${label} fixture`,
        passwordHash: "postgres-exchange-concurrency-fixture-only",
        emailVerifiedAt: new Date(),
        role: "USER",
        status: "ACTIVE",
        balanceMilli: FUNDING_MILLI,
      },
    });
    const source = await tx.ledgerAccount.create({
      data: {
        ownerType: "SYSTEM",
        ownerId: `${fixtureScope}:${label}`,
        purpose: "FIXTURE_ISSUANCE",
        allowsNegative: true,
      },
    });
    const wallet = await tx.ledgerAccount.create({
      data: {
        ownerType: "USER",
        ownerId: user.id,
        purpose: "USER_FEATHERS",
      },
    });
    await tx.ledgerAccount.update({
      where: { id: source.id },
      data: { balanceMilli: { decrement: FUNDING_MILLI } },
    });
    await tx.ledgerAccount.update({
      where: { id: wallet.id },
      data: { balanceMilli: { increment: FUNDING_MILLI } },
    });
    await tx.journalEntry.create({
      data: {
        type: "FIXTURE_GRANT",
        referenceType: "USER",
        referenceId: user.id,
        idempotencyScope: fixtureScope,
        idempotencyKey: `grant:${label}`,
        actorUserId: user.id,
        metadata: JSON.stringify({ purpose: "postgres-exchange-concurrency" }),
        postings: {
          create: [
            { ledgerAccountId: source.id, amountMilli: -FUNDING_MILLI },
            { ledgerAccountId: wallet.id, amountMilli: FUNDING_MILLI },
          ],
        },
      },
    });
    return { user, source, wallet };
  });
}

async function createMarket(creatorId: string, label: string) {
  const collateral = await db.ledgerAccount.create({
    data: {
      ownerType: "MARKET",
      ownerId: `${fixtureScope}:${label}:pending`,
      purpose: "COLLATERAL",
    },
  });
  const market = await db.market.create({
    data: {
      slug: `pg-exchange-${label}-${suffix}`,
      title: `Will PostgreSQL serialize the ${label} exchange fixture?`,
      shortTitle: `PostgreSQL ${label} fixture`,
      description: "A disposable order-book concurrency fixture in an isolated PostgreSQL schema.",
      rules: "This market exists only for the PostgreSQL exchange concurrency regression.",
      resolutionSource: "Persisted PostgreSQL exchange state",
      category: "Testing",
      status: "OPEN",
      acceptingOrders: true,
      closesAt: new Date(Date.now() + 60 * 60_000),
      resolvesAt: new Date(Date.now() + 2 * 60 * 60_000),
      payoutMilli: PAYOUT_MILLI,
      feeBps: 0,
      pricingModel: "ORDER_BOOK",
      createdById: creatorId,
      collateralAccountId: collateral.id,
    },
  });
  await db.ledgerAccount.update({
    where: { id: collateral.id },
    data: { ownerId: market.id },
  });
  return { market, collateral };
}

function placementInput(userId: string, marketId: string, label: string, key: string) {
  return {
    userId,
    idempotencyKey: key,
    request: {
      marketId,
      clientOrderId: `pg-exchange-${label}-${suffix}`,
      outcome: "YES",
      action: "BUY",
      limitPriceMilli: ORDER_PRICE_MILLI.toString(),
      quantity: 1,
      timeInForce: "GTC",
    },
  };
}

/** Hold market writes until both real commands are demonstrably in flight.
 * A separate client keeps the blocker out of the application's connection pool.
 * Never wait for a command to finish while holding its required row lock.
 */
async function overlappingCommands(
  marketIds: readonly string[],
  commands: readonly [() => Promise<unknown>, () => Promise<unknown>],
): Promise<PromiseSettledResult<unknown>[]> {
  assertIsolatedPostgresRuntime();
  const lockUrl = new URL(databaseRuntime.datasourceUrl);
  lockUrl.searchParams.set("connection_limit", "1");
  const blocker = new PrismaClient({ datasourceUrl: lockUrl.toString() });
  let pending: Promise<PromiseSettledResult<unknown>[]> | undefined;
  try {
    await blocker.$transaction(async (tx) => {
      await tx.$executeRaw`SET LOCAL lock_timeout = '3s'`;
      await tx.$executeRaw`SET LOCAL statement_timeout = '3s'`;
      const [connection] = await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`;
      assert(connection, "Missing blocker connection PID.");
      for (const id of [...new Set(marketIds)].sort()) {
        const rows = await tx.$queryRaw<Array<{ id: string }>>`SELECT id FROM "Market" WHERE id = ${id} FOR UPDATE`;
        assert(rows.length === 1, "Overlap barrier market is missing.");
      }
      // Attach rejection handlers immediately; an early service failure must
      // not become an unhandled rejection while observing the lock graph.
      let completed = 0;
      pending = Promise.allSettled(commands.map((command) =>
        Promise.resolve().then(command).finally(() => { completed += 1; })
      ));
      const deadline = Date.now() + 8_000;
      while (Date.now() < deadline) {
        // The second writer of the same row can wait behind the first writer's
        // tuple lock rather than directly behind us. Follow the entire chain.
        const [observed] = await tx.$queryRaw<Array<{ count: bigint }>>`
          WITH RECURSIVE waiting AS (
            SELECT DISTINCT pid, pg_blocking_pids(pid) AS blockers
            FROM pg_locks WHERE NOT granted AND pid IS NOT NULL
          ), blocked AS (
            SELECT pid FROM waiting WHERE ${connection.pid} = ANY(blockers)
            UNION
            SELECT waiting.pid FROM waiting JOIN blocked ON blocked.pid = ANY(waiting.blockers)
          ) SELECT count(DISTINCT pid) AS count FROM blocked
        `;
        if (observed?.count === 2n) {
          process.stdout.write("Observed both exchange commands blocked concurrently before releasing fixture market locks.\n");
          return;
        }
        assert(completed === 0, "An exchange command completed before the overlap barrier was reached.");
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      throw new Error("Timed out waiting for two overlapping exchange commands; concurrency was not demonstrated.");
    }, { maxWait: 3_000, timeout: 15_000 });
    assert(pending, "Overlap barrier did not start commands.");
    return await pending;
  } finally {
    // $transaction has committed/rolled back before here. Commands can finish
    // or retry without a lock cycle, including on observation timeout/failure.
    if (pending) await pending;
    await blocker.$disconnect();
  }
}

function fulfilledPair(results: PromiseSettledResult<unknown>[]): [unknown, unknown] {
  const values = results.map((result) => {
    if (result.status === "rejected") throw result.reason;
    return result.value;
  });
  assert(values.length === 2, "Expected two overlapping command results.");
  return [values[0], values[1]];
}

async function assertAccountAndJournalIntegrity(accountIds: readonly string[]): Promise<void> {
  const [accounts, postings, journals] = await Promise.all([
    db.ledgerAccount.findMany({
      where: { id: { in: [...accountIds] } },
      select: { id: true, balanceMilli: true },
    }),
    db.ledgerPosting.findMany({
      where: { ledgerAccountId: { in: [...accountIds] } },
      select: { ledgerAccountId: true, amountMilli: true },
    }),
    db.journalEntry.findMany({
      where: { postings: { some: { ledgerAccountId: { in: [...accountIds] } } } },
      select: { id: true, postings: { select: { ledgerAccountId: true, amountMilli: true } } },
    }),
  ]);

  assert(accounts.length === accountIds.length, "A fixture ledger account disappeared.");
  const postingTotals = new Map<string, bigint>();
  for (const posting of postings) {
    postingTotals.set(
      posting.ledgerAccountId,
      (postingTotals.get(posting.ledgerAccountId) ?? 0n) + posting.amountMilli,
    );
  }
  for (const account of accounts) {
    assert(
      account.balanceMilli === (postingTotals.get(account.id) ?? 0n),
      `Fixture account ${account.id} does not equal its independent posting sum.`,
    );
  }
  for (const journal of journals) {
    const total = journal.postings.reduce((sum, posting) => sum + posting.amountMilli, 0n);
    assert(total === 0n, `Fixture journal ${journal.id} is unbalanced.`);
    assert(
      journal.postings.every((posting) => accountIds.includes(posting.ledgerAccountId)),
      `Fixture journal ${journal.id} escaped the fixture account set.`,
    );
  }
  assert(
    accounts.reduce((sum, account) => sum + account.balanceMilli, 0n) === 0n,
    "Fixture ledger accounts do not conserve total feathers.",
  );
}

async function verifyConcurrentRegistrations(): Promise<void> {
  const previousVerification = process.env.REQUIRE_EMAIL_VERIFICATION;
  const previousStartingFeathers = process.env.STARTING_FEATHERS;
  // Isolated test-process settings only; never change deployment policy.
  process.env.REQUIRE_EMAIL_VERIFICATION = "false";
  process.env.STARTING_FEATHERS = "1000";
  try {
    const issuanceKey = { ownerType: "SYSTEM", ownerId: "issuance", purpose: "ISSUANCE" };
    assert(await db.ledgerAccount.findUnique({ where: { ownerType_ownerId_purpose: issuanceKey } }) === null,
      "Registration race must exercise cold issuance-account creation.");
    // Keep contention bounded to two participants and use the unmodified
    // production registerUser retry policy, not the fixture's extended retries.
    const results = await Promise.allSettled(["first", "second"].map((label) => registerUser({
      email: `pg-register-${label}-${suffix}@goosey.test`,
      username: `pg_register_${label}_${suffix}`,
      displayName: `PostgreSQL registration ${label}`,
      password: `Isolated-registration-${suffix}!`,
    })));
    const registered = results.map((result) => {
      if (result.status === "rejected") throw result.reason;
      return result.value;
    });
    assert(new Set(registered.map((result) => result.user.id)).size === 2, "Registrations did not produce two distinct users.");
    const issuance = await db.ledgerAccount.findUniqueOrThrow({ where: { ownerType_ownerId_purpose: issuanceKey } });
    assert(issuance.balanceMilli === -2_000_000n, "Concurrent registration issued an incorrect total grant.");
    const accountIds = [issuance.id];
    for (const { user, session } of registered) {
      const [persistedUser, wallet, grants, sessions] = await Promise.all([
        db.user.findUniqueOrThrow({ where: { id: user.id } }),
        db.ledgerAccount.findUniqueOrThrow({ where: { ownerType_ownerId_purpose: {
          ownerType: "USER", ownerId: user.id, purpose: "USER_FEATHERS",
        } } }),
        db.journalEntry.findMany({ where: { idempotencyScope: "WELCOME_GRANT", idempotencyKey: user.id }, include: { postings: true } }),
        db.session.count({ where: { userId: user.id } }),
      ]);
      accountIds.push(wallet.id);
      assert(persistedUser.balanceMilli === 1_000_000n && wallet.balanceMilli === 1_000_000n, "Registration cash did not match one welcome grant.");
      assert(sessions === 1 && session.token.length > 0, "Registration did not persist exactly one session.");
      assert(grants.length === 1 && grants[0]!.postings.length === 2, "Registration did not persist exactly one two-sided welcome journal.");
      assert(grants[0]!.postings.some((posting) => posting.ledgerAccountId === wallet.id && posting.amountMilli === 1_000_000n), "Welcome journal did not credit the participant wallet exactly once.");
      assert(grants[0]!.postings.some((posting) => posting.ledgerAccountId === issuance.id && posting.amountMilli === -1_000_000n), "Welcome journal did not debit issuance exactly once.");
      assert(await runSerializableTransaction(db, (tx) => grantWelcomeFeathers(tx, user.id)) === false, "An existing welcome grant was issued again.");
    }
    await assertAccountAndJournalIntegrity(accountIds);
    for (const { user } of registered) {
      assert(await db.journalEntry.count({ where: { idempotencyScope: "WELCOME_GRANT", idempotencyKey: user.id } }) === 1, "Welcome-grant replay duplicated a journal.");
      assert((await db.user.findUniqueOrThrow({ where: { id: user.id } })).balanceMilli === 1_000_000n, "Welcome-grant replay changed cached cash.");
    }
    process.stdout.write("Concurrent PostgreSQL registration passed: cold issuance upsert, two accounts/sessions, and exactly-once journal-backed welcome grants.\n");
  } finally {
    if (previousVerification === undefined) delete process.env.REQUIRE_EMAIL_VERIFICATION;
    else process.env.REQUIRE_EMAIL_VERIFICATION = previousVerification;
    if (previousStartingFeathers === undefined) delete process.env.STARTING_FEATHERS;
    else process.env.STARTING_FEATHERS = previousStartingFeathers;
  }
}

async function main(): Promise<void> {
  assertIsolatedPostgresRuntime();
  await verifyConcurrentRegistrations();
  const creator = await createCreator();
  const [scarce, replayUser] = await Promise.all([
    createFundedUser("scarce"),
    createFundedUser("replay"),
  ]);
  const [scarceMarketA, scarceMarketB, replayMarket] = await Promise.all([
    createMarket(creator.id, "scarce-a"),
    createMarket(creator.id, "scarce-b"),
    createMarket(creator.id, "replay"),
  ]);

  const scarceInputs = [
    placementInput(scarce.user.id, scarceMarketA.market.id, "scarce-a", `scarce-a:${suffix}`),
    placementInput(scarce.user.id, scarceMarketB.market.id, "scarce-b", `scarce-b:${suffix}`),
  ] as const;
  const scarceSettled = await overlappingCommands(
    [scarceMarketA.market.id, scarceMarketB.market.id],
    [() => placeOrder(scarceInputs[0]), () => placeOrder(scarceInputs[1])],
  );
  const scarceFulfilled = scarceSettled.filter(
    (result): result is PromiseFulfilledResult<unknown> => result.status === "fulfilled",
  );
  const scarceRejected = scarceSettled.filter(
    (result): result is PromiseRejectedResult => result.status === "rejected",
  );
  assert(scarceFulfilled.length === 1, "Shared cash race did not produce exactly one fulfilled placement.");
  assert(scarceRejected.length === 1, "Shared cash race did not reject exactly one placement.");
  const scarceOrder = acceptedPlacement(scarceFulfilled[0]!.value, "Shared cash race");
  const rejection = scarceRejected[0]!.reason;
  if (!(rejection instanceof ApiError && rejection.code === "INSUFFICIENT_BALANCE")) throw rejection;

  const [scarceUser, scarceWallet, scarceReservations, scarceOrders, scarceCommands] = await Promise.all([
    db.user.findUniqueOrThrow({ where: { id: scarce.user.id } }),
    db.ledgerAccount.findUniqueOrThrow({ where: { id: scarce.wallet.id } }),
    db.orderReservation.findMany({
      where: { userId: scarce.user.id },
      include: { cashAccount: true },
    }),
    db.marketOrder.findMany({ where: { userId: scarce.user.id } }),
    db.orderCommand.findMany({ where: { actorUserId: scarce.user.id, scope: "ORDER_PLACE" } }),
  ]);
  assert(scarceOrders.length === 1 && scarceOrders[0]!.id === scarceOrder.order.orderId, "Failed cash race left an extra order.");
  assert(scarceCommands.length === 1, "Failed cash race left an extra command.");
  assert(scarceReservations.length === 1, "Shared cash race did not leave exactly one reservation.");
  assert(
    scarceReservations[0]!.reservedPrincipalMilli === ORDER_PRICE_MILLI &&
      scarceReservations[0]!.reservedFeeMilli === 0n &&
      scarceReservations[0]!.cashAccount?.balanceMilli === ORDER_PRICE_MILLI,
    "Shared cash race reservation is not exactly 60000 milli-feathers.",
  );
  assert(
    scarceUser.balanceMilli === 40_000n && scarceWallet.balanceMilli === 40_000n,
    "Shared cash race did not leave exactly 40000 milli-feathers available.",
  );

  const replayKey = `replay-place:${suffix}`;
  const replayInput = placementInput(replayUser.user.id, replayMarket.market.id, "replay", replayKey);
  const [replayOneRaw, replayTwoRaw] = fulfilledPair(await overlappingCommands(
    [replayMarket.market.id], [() => placeOrder(replayInput), () => placeOrder(replayInput)],
  ));
  const replayOne = acceptedPlacement(replayOneRaw, "First idempotent placement");
  const replayTwo = acceptedPlacement(replayTwoRaw, "Second idempotent placement");
  assert(replayOne.order.orderId === replayTwo.order.orderId, "Parallel idempotent placement returned different orders.");

  const [replayAfterPlace, replayWalletAfterPlace, replayOrders, replayReservations, replayCommands] = await Promise.all([
    db.user.findUniqueOrThrow({ where: { id: replayUser.user.id } }),
    db.ledgerAccount.findUniqueOrThrow({ where: { id: replayUser.wallet.id } }),
    db.marketOrder.findMany({ where: { userId: replayUser.user.id } }),
    db.orderReservation.findMany({ where: { userId: replayUser.user.id }, include: { cashAccount: true } }),
    db.orderCommand.findMany({ where: { actorUserId: replayUser.user.id, scope: "ORDER_PLACE", idempotencyKey: replayKey } }),
  ]);
  assert(replayOrders.length === 1, "Parallel idempotent placement created more than one order.");
  assert(replayReservations.length === 1, "Parallel idempotent placement created more than one reservation.");
  assert(replayCommands.length === 1, "Parallel idempotent placement created more than one command.");
  assert(
    replayAfterPlace.balanceMilli === 40_000n && replayWalletAfterPlace.balanceMilli === 40_000n,
    "Parallel idempotent placement charged the user more than once.",
  );

  const cancelKey = `replay-cancel:${suffix}`;
  const cancelInput = {
    userId: replayUser.user.id,
    idempotencyKey: cancelKey,
    request: { orderId: replayOne.order.orderId },
  };
  const [cancelOne, cancelTwo] = fulfilledPair(await overlappingCommands(
    [replayMarket.market.id], [() => cancelOrder(cancelInput), () => cancelOrder(cancelInput)],
  ));
  assert(JSON.stringify(cancelOne) === JSON.stringify(cancelTwo), "Parallel idempotent cancellation returned different responses.");

  const [replayAfterCancel, replayWalletAfterCancel, canceledOrder, canceledReservation, cancelCommands] = await Promise.all([
    db.user.findUniqueOrThrow({ where: { id: replayUser.user.id } }),
    db.ledgerAccount.findUniqueOrThrow({ where: { id: replayUser.wallet.id } }),
    db.marketOrder.findUniqueOrThrow({ where: { id: replayOne.order.orderId } }),
    db.orderReservation.findUniqueOrThrow({
      where: { orderId: replayOne.order.orderId },
      include: { cashAccount: true },
    }),
    db.orderCommand.findMany({ where: { actorUserId: replayUser.user.id, scope: "ORDER_CANCEL", idempotencyKey: cancelKey } }),
  ]);
  assert(cancelCommands.length === 1, "Parallel idempotent cancellation created more than one command.");
  assert(canceledOrder.status === "CANCELED" && canceledOrder.remainingQuantity === 0, "Canceled order remained live.");
  assert(
    canceledReservation.reservedPrincipalMilli === 0n &&
      canceledReservation.reservedFeeMilli === 0n &&
      canceledReservation.cashAccount?.balanceMilli === 0n,
    "Parallel cancellation did not release the reservation exactly once.",
  );
  assert(
    replayAfterCancel.balanceMilli === FUNDING_MILLI &&
      replayWalletAfterCancel.balanceMilli === FUNDING_MILLI,
    "Parallel cancellation did not refund exactly once.",
  );

  const fixtureAccountIds = [
    scarce.source.id,
    scarce.wallet.id,
    replayUser.source.id,
    replayUser.wallet.id,
    scarceMarketA.collateral.id,
    scarceMarketB.collateral.id,
    replayMarket.collateral.id,
    ...scarceReservations.flatMap((reservation) => reservation.cashAccountId ? [reservation.cashAccountId] : []),
    ...replayReservations.flatMap((reservation) => reservation.cashAccountId ? [reservation.cashAccountId] : []),
  ];
  assert(new Set(fixtureAccountIds).size === fixtureAccountIds.length, "Fixture account IDs are not unique.");
  await assertAccountAndJournalIntegrity(fixtureAccountIds);

  process.stdout.write("PostgreSQL exchange concurrency passed: scarce-cash serialization, placement replay, cancellation replay, and fixture ledger conservation.\n");
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.stack ?? error.message : error);
    process.exitCode = 1;
  })
  .finally(async () => db.$disconnect());
