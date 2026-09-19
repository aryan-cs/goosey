/** Actual compiled-program capacity/work-bound suite. Run only through the
 * isolated validator harness; this file never starts, resets, or deploys one. */
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  address, appendTransactionMessageInstructions, blockhash, createKeyPairSignerFromBytes,
  createTransactionMessage, generateKeyPairSigner, getAddressDecoder,
  getBase64EncodedWireTransaction, getSignatureFromTransaction, pipe,
  setTransactionMessageFeePayerSigner, setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners, type Address, type Instruction,
} from "@solana/kit";
import { getMintDecoder, getTokenDecoder, TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";
import { getTransferSolInstruction } from "@solana-program/system";
import {
  buildAuthorizeEnrollmentInstruction, buildClaimFeathersInstructions,
  buildInitializeInstruction, deriveGooseyProgramAddresses,
} from "../src/lib/solana/program-client";
import {
  buildCreateMarketInstructions, buildDepositInstruction, buildRegisterSeatInstruction,
} from "../src/lib/solana/escrow-client";
import {
  buildBookSetupInstruction, buildCancelOrderInstruction, buildPlaceOrderInstruction,
  deriveGooseyBookAddress, GOOSEY_BOOK_BYTES,
} from "../src/lib/solana/exchange-client";
import { readCanonicalOrderBook, type BookSnapshotAccount } from "../src/lib/solana/order-book-read";
import { buildInitializeResolutionInstruction } from "../src/lib/solana/resolution-client";
import { encodeMarketTerms, hashMarketTerms, type MarketTerms } from "../src/lib/solana/market-terms";
import {
  buildAcceptMarketTermsInstruction, buildInitializeMarketTermsInstruction,
  buildSealMarketTermsInstruction,
} from "../src/lib/solana/market-terms-client";

const PROGRAM = address("CgEGAD3EGLm63YaSx58sRiNPQmmxg8RqvqcxE3xThX8Q");
const LOADER = address("BPFLoaderUpgradeab1e11111111111111111111111");
const CLOCK = address("SysvarC1ock11111111111111111111111111111111");
const CAPACITY = 1_024;
const MAX_TOUCHES = 16;
const PAYOUT = 1_000n;
const FEE_BPS = 1;
const GRANT = 20_000n;
const PARTICIPANT_COUNT = 17;
const FULL_MARKET_ID = 1n;
const TOUCH_MARKET_ID = 2n;
const BATCH_SIZE = 8;
const discriminator = (namespace: string, name: string) =>
  createHash("sha256").update(`${namespace}:${name}`).digest().subarray(0, 8);
const fee = (gross: bigint) => (gross * BigInt(FEE_BPS) + 9_999n) / 10_000n;

type RpcAccount = { data: [string, string]; owner: Address; executable: boolean; lamports: number };
type Context<T> = { context: { slot: number }; value: T };
type Receipt = { slot: number; meta: { err: unknown; computeUnitsConsumed?: number; logMessages: string[] | null } };
type ExpectedError = { code: number; instruction?: number };
type Market = {
  marketId: bigint; market: Address; seats: Address; vault: Address; book: Address;
  terms: Address; resolution: Address; closesAt: bigint; deposits: bigint;
  participantIndexes: readonly number[];
};

async function main() {
  if (process.argv.includes("--help")) {
    console.log(`Actual bounded-capacity RPC suite. Launch through:
GOOSEY_SOLANA_BIN_DIR=/path/to/bin node --import tsx scripts/solana-program-e2e-isolated.ts --suite capacity

Requires a fresh isolated loopback ledger and the current compiled program. It
fills all 1024 canonical order slots using real signed placements, proves atomic
BookFull rejection and exact freed-slot reuse, then executes one FOK against 16
distinct real makers at the maximum work bound with accounting conservation.`);
    return;
  }
  assert.equal(process.argv.length, 2, "Unknown arguments; use --help");
  const endpoint = new URL(process.env.GOOSEY_SOLANA_RPC_URL ?? "");
  assert(["127.0.0.1", "[::1]"].includes(endpoint.hostname));
  assert(["http:", "https:"].includes(endpoint.protocol));
  assert(!endpoint.username && !endpoint.password && !endpoint.hash && !endpoint.search);
  assert(!["18999", "24999", "8080"].includes(endpoint.port), "Shared endpoints prohibited");
  const genesis = process.env.GOOSEY_SOLANA_GENESIS_HASH;
  assert(genesis && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(genesis), "Explicit genesis pin required");
  const adminPath = await realpath(process.env.GOOSEY_SOLANA_TEST_ADMIN_KEYPAIR ?? "");
  const relative = path.relative(await realpath("/tmp"), adminPath).split(path.sep);
  assert(relative.length === 2 && /^goosey-solana-[A-Za-z0-9._-]+$/.test(relative[0])
    && relative[1] === "goosey-admin-keypair.json", "Disposable isolated-runner admin required");

  let rpcId = 0;
  async function rpc<T>(method: string, params: unknown[] = []): Promise<T> {
    const response = await fetch(endpoint, { method: "POST", redirect: "error", signal: AbortSignal.timeout(10_000),
      headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params }) });
    assert(response.ok);
    const body = await response.json() as { result: T; error?: unknown };
    assert(!body.error, `${method}: ${JSON.stringify(body.error)}`);
    return body.result;
  }
  const pin = async () => assert.equal(await rpc("getGenesisHash"), genesis, "Genesis changed; refusing writes");
  const accounts = async (keys: readonly Address[], commitment: "confirmed" | "finalized" = "confirmed") =>
    (await rpc<Context<(RpcAccount | null)[]>>("getMultipleAccounts", [keys, { encoding: "base64", commitment }])).value;
  const bytes = (account: RpcAccount | null | undefined) => {
    assert(account); return Buffer.from(account.data[0], "base64");
  };
  const chainTime = async () => bytes((await accounts([CLOCK]))[0]).readBigInt64LE(32);

  await pin();
  const base = await deriveGooseyProgramAddresses(PROGRAM);
  const [program, programData, config] = await accounts([PROGRAM, base.programData, base.config]);
  assert(program?.executable && program.owner === LOADER && programData?.owner === LOADER);
  assert.equal(bytes(program).readUInt32LE(0), 2);
  assert.equal(getAddressDecoder().decode(bytes(program).subarray(4, 36)), base.programData);
  assert.equal(bytes(programData).readUInt32LE(0), 3);
  assert.equal(bytes(programData)[12], 1);
  assert.equal(config, null, "Existing config refused; capacity proof requires a fresh ledger");
  const raw: unknown = JSON.parse(await readFile(adminPath, "utf8"));
  assert(Array.isArray(raw) && raw.length === 64 && raw.every(value => Number.isInteger(value) && value >= 0 && value <= 255));
  const secret = Uint8Array.from(raw);
  const admin = await createKeyPairSignerFromBytes(secret);
  secret.fill(0); raw.fill(0);
  assert.equal(getAddressDecoder().decode(bytes(programData).subarray(13, 45)), admin.address,
    "Loaded program upgrade authority is not this isolated run's admin");

  const watched = new Set<Address>([base.config, base.featherMint]);
  const receipts: Array<{ name: string; signature: string; slot: number; cu: number; error: unknown }> = [];
  let serial = 0;
  async function execute(name: string, instructions: readonly Instruction[], expected?: ExpectedError) {
    assert(instructions.length > 0);
    await pin();
    const watchedKeys = [...watched];
    const before = expected ? await accounts(watchedKeys) : null;
    const lifetime = (await rpc<Context<{ blockhash: string; lastValidBlockHeight: number }>>(
      "getLatestBlockhash", [{ commitment: "confirmed" }])).value;
    const budgetData = Buffer.alloc(5);
    budgetData[0] = 2;
    budgetData.writeUInt32LE(1_400_000 - ++serial, 1);
    const budget: Instruction = { programAddress: address("ComputeBudget111111111111111111111111111111"), data: budgetData };
    const message = pipe(createTransactionMessage({ version: 0 }),
      tx => setTransactionMessageFeePayerSigner(admin, tx),
      tx => setTransactionMessageLifetimeUsingBlockhash({ blockhash: blockhash(lifetime.blockhash),
        lastValidBlockHeight: BigInt(lifetime.lastValidBlockHeight) }, tx),
      tx => appendTransactionMessageInstructions([budget, ...instructions], tx));
    const signed = await signTransactionMessageWithSigners(message);
    const signature = getSignatureFromTransaction(signed);
    const wire = getBase64EncodedWireTransaction(signed);
    assert(Buffer.from(wire, "base64").length <= 1_232, `${name}: transaction exceeds packet bound`);
    const send = async () => {
      await pin();
      assert.equal(await rpc("sendTransaction", [wire, { encoding: "base64", skipPreflight: true, maxRetries: 5 }]), signature);
    };
    await send();
    const deadline = Date.now() + 60_000;
    let resentAt = Date.now();
    let receipt: Receipt | null = null;
    while (Date.now() < deadline) {
      receipt = await rpc("getTransaction", [signature, { commitment: "confirmed", maxSupportedTransactionVersion: 0 }]);
      if (receipt?.meta) break;
      if (Date.now() - resentAt > 1_000) { await send(); resentAt = Date.now(); }
      await delay(150);
    }
    assert(receipt?.meta, `${name}: unknown transaction outcome`);
    const error = expected
      ? { InstructionError: [(expected.instruction ?? 0) + 1, { Custom: expected.code }] }
      : null;
    assert.deepEqual(receipt.meta.err, error, `${name}: ${(receipt.meta.logMessages ?? []).join("\n")}`);
    if (expected) assert.deepEqual(await accounts(watchedKeys), before, `${name}: failed transaction mutated watched state`);
    assert(Number.isInteger(receipt.meta.computeUnitsConsumed));
    const cu = receipt.meta.computeUnitsConsumed!;
    receipts.push({ name, signature, slot: receipt.slot, cu, error });
    console.log(`PASS ${name}: ${signature} (${cu} CU)`);
    return { signature, receipt, logs: receipt.meta.logMessages ?? [], cu };
  }

  const initialized = await buildInitializeInstruction({ programAddress: PROGRAM, admin, environment: 1,
    genesisDomain: createHash("sha256").update(genesis).digest(), enrollmentAuthority: admin.address,
    perWalletCap: GRANT, campaignCap: BigInt(PARTICIPANT_COUNT) * GRANT + 2n });
  await execute("initialize actual program and SPL mint", [initialized.instruction]);

  const participants = await Promise.all(Array.from({ length: PARTICIPANT_COUNT }, () => generateKeyPairSigner()));
  const reviewers = await Promise.all([generateKeyPairSigner(), generateKeyPairSigner()]);
  assert.equal(new Set([admin.address, ...participants.map(p => p.address), ...reviewers.map(r => r.address)]).size,
    1 + PARTICIPANT_COUNT + reviewers.length);
  await execute("fund disposable participant and reviewer fee payers",
    [...participants, ...reviewers].map(wallet => getTransferSolInstruction({ source: admin,
      destination: wallet.address, amount: 1_000_000_000n })));

  const walletTokens: Address[] = [];
  const enrollments: Address[] = [];
  for (const [index, wallet] of participants.entries()) {
    const authorization = await buildAuthorizeEnrollmentInstruction({ programAddress: PROGRAM,
      enrollmentAuthority: admin, wallet: wallet.address, identityDigest: randomBytes(32), allowance: GRANT,
      expiresAt: (await chainTime()) + 1_800n });
    await execute(`authorize real participant grant ${index}`, [authorization.instruction]);
    const claim = await buildClaimFeathersInstructions({ programAddress: PROGRAM, wallet, payer: admin, createAta: true });
    await execute(`claim real participant feathers ${index}`, claim.instructions);
    walletTokens.push(claim.walletTokens); enrollments.push(claim.enrollment);
    watched.add(claim.walletTokens); watched.add(claim.enrollment); watched.add(authorization.identity);
    assert.equal(getTokenDecoder().decode(bytes((await accounts([claim.walletTokens]))[0])).amount, GRANT);
  }
  const reviewerEnrollments: Address[] = [];
  for (const [index, reviewer] of reviewers.entries()) {
    const authorization = await buildAuthorizeEnrollmentInstruction({ programAddress: PROGRAM,
      enrollmentAuthority: admin, wallet: reviewer.address, identityDigest: randomBytes(32), allowance: 1n,
      expiresAt: (await chainTime()) + 1_800n });
    await execute(`enroll nontrading reviewer ${index}`, [authorization.instruction]);
    reviewerEnrollments.push(authorization.enrollment);
    watched.add(authorization.enrollment); watched.add(authorization.identity);
  }

  async function createMarket(marketId: bigint, deposits: readonly { participant: number; amount: bigint }[]): Promise<Market> {
    const closesAt = (await chainTime()) + 1_200n;
    const created = await buildCreateMarketInstructions({ programAddress: PROGRAM, marketId, admin,
      seats: await generateKeyPairSigner(),
      seatsRentLamports: BigInt(await rpc<number>("getMinimumBalanceForRentExemption", [32_816])),
      payoutMilli: PAYOUT, feeBps: FEE_BPS, closesAt, resolvesAt: closesAt });
    await execute(`create actual market ${marketId}`, created.instructions);
    const { book } = await deriveGooseyBookAddress(PROGRAM, created.market);
    for (const key of [created.market, created.seats, created.vault, book]) watched.add(key);
    for (const entry of deposits) {
      const wallet = participants[entry.participant]!;
      const registration = await buildRegisterSeatInstruction({ programAddress: PROGRAM, marketId,
        wallet, seats: created.seats });
      await execute(`register market${marketId} participant${entry.participant}`, [registration.instruction]);
      watched.add(registration.locator);
      const deposit = await buildDepositInstruction({ programAddress: PROGRAM, marketId, wallet,
        seats: created.seats, amount: entry.amount, expectedNonce: 0n });
      await execute(`deposit market${marketId} participant${entry.participant}`, [deposit.instruction]);
    }
    const setup = async (step: Parameters<typeof buildBookSetupInstruction>[0]["step"]) =>
      (await buildBookSetupInstruction({ programAddress: PROGRAM, marketId, admin, step })).instruction;
    await execute(`create market${marketId} canonical order book`, [await setup({ kind: "create" })]);
    while (bytes((await accounts([book]))[0]).length < GOOSEY_BOOK_BYTES) {
      const observed = bytes((await accounts([book]))[0]).length;
      await execute(`grow market${marketId} book from ${observed}`, [await setup({ kind: "grow", expectedSize: observed })]);
    }
    await execute(`finalize market${marketId} canonical order book`, [await setup({ kind: "finalize" })]);

    const manifest: MarketTerms = {
      version: 1,
      binding: { cluster: "localnet", genesisHash: genesis!, program: PROGRAM, config: base.config,
        market: created.market, marketId: marketId.toString(), creator: admin.address, featherMint: base.featherMint },
      question: `TEST ONLY: Does isolated capacity market ${marketId} satisfy its bounded runtime assertions?`,
      rules: { yes: "YES only when this suite's deterministic bounded-capacity assertions pass on the pinned ledger.",
        no: "NO when any deterministic bounded-capacity assertion fails on the pinned ledger.",
        void: "VOID only if the fresh isolated ledger becomes unavailable before the assertions complete." },
      observation: { startsAt: closesAt.toString(), endsAt: closesAt.toString(), timezone: "UTC" },
      sources: [{ id: "isolated-ledger", uri: "https://solana.com/docs/rpc/http/getmultipleaccounts",
        selection: "Method specification only; evidence is the pinned disposable ledger and actual compiled program receipts.",
        snapshotSha256: null }],
      sourcePolicy: { priority: "array-order-first-authoritative",
        missing: "Retain the isolated runner evidence and wait for the designated reviewers.",
        revisions: "Only this pinned genesis and its finalized transaction history are authoritative." },
      economics: { payoutMilli: PAYOUT.toString(), feeBps: String(FEE_BPS), closesAt: closesAt.toString(),
        resolvesAt: closesAt.toString(), decimals: 3 },
      oracle: { kind: "two-reviewer-no-fallback-v1",
        proposer: { wallet: reviewers[0].address, enrollment: reviewerEnrollments[0] },
        approver: { wallet: reviewers[1].address, enrollment: reviewerEnrollments[1] },
        unavailable: "wait-for-designated-reviewers", replacement: "none", automaticVoid: false },
    };
    const manifestBytes = encodeMarketTerms(manifest);
    const digest = Buffer.from(await hashMarketTerms(manifestBytes), "hex");
    const terms = await buildInitializeMarketTermsInstruction({ programAddress: PROGRAM, marketId,
      seats: created.seats, creator: admin, proposer: reviewers[0].address, approver: reviewers[1].address,
      version: 1, digest, manifestLength: manifestBytes.length });
    await execute(`initialize market${marketId} immutable terms`, [terms.instruction]);
    await execute(`accept market${marketId} terms as proposer`, [(await buildAcceptMarketTermsInstruction({
      programAddress: PROGRAM, marketId, seats: created.seats, reviewer: reviewers[0], expectedDigest: digest })).instruction]);
    await execute(`accept market${marketId} terms as approver`, [(await buildAcceptMarketTermsInstruction({
      programAddress: PROGRAM, marketId, seats: created.seats, reviewer: reviewers[1], expectedDigest: digest })).instruction]);
    await execute(`seal market${marketId} immutable terms`, [(await buildSealMarketTermsInstruction({
      programAddress: PROGRAM, marketId, seats: created.seats, creator: admin, expectedDigest: digest })).instruction]);
    watched.add(terms.terms);
    const resolution = await buildInitializeResolutionInstruction({ programAddress: PROGRAM, marketId,
      seats: created.seats, creator: admin, proposer: reviewers[0].address, approver: reviewers[1].address });
    assert.equal(resolution.terms, terms.terms);
    await execute(`initialize market${marketId} mandatory resolution admission`, [resolution.instruction]);
    watched.add(resolution.resolution);
    return { marketId, market: created.market, seats: created.seats, vault: created.vault, book,
      terms: terms.terms, resolution: resolution.resolution, closesAt,
      deposits: deposits.reduce((sum, entry) => sum + entry.amount, 0n),
      participantIndexes: deposits.map(entry => entry.participant) };
  }

  function snapshot(addressValue: Address, account: RpcAccount | null): BookSnapshotAccount {
    assert(account);
    return { address: addressValue, owner: account.owner, executable: account.executable,
      data: bytes(account) };
  }
  async function marketState(market: Market, commitment: "confirmed" | "finalized" = "confirmed") {
    const raw = await accounts([market.market, market.seats, market.book, market.resolution, market.vault, base.featherMint], commitment);
    const [marketAccount, seatsAccount, bookAccount, resolutionAccount, vaultAccount, mintAccount] = raw;
    for (const account of [marketAccount, seatsAccount, bookAccount, resolutionAccount]) assert.equal(account?.owner, PROGRAM);
    assert.equal(vaultAccount?.owner, TOKEN_PROGRAM_ADDRESS); assert.equal(mintAccount?.owner, TOKEN_PROGRAM_ADDRESS);
    const decoded = await readCanonicalOrderBook({ programAddress: PROGRAM, marketId: market.marketId,
      market: snapshot(market.market, marketAccount), seats: snapshot(market.seats, seatsAccount),
      book: snapshot(market.book, bookAccount), resolution: snapshot(market.resolution, resolutionAccount) });
    const marketBytes = bytes(marketAccount), bookBytes = bytes(bookAccount);
    const vault = getTokenDecoder().decode(bytes(vaultAccount));
    assert.equal(vault.owner, market.market); assert.equal(vault.mint, base.featherMint);
    assert.equal(decoded.reservesReconciled, true);
    const accounted = marketBytes.readBigUInt64LE(168), collateral = marketBytes.readBigUInt64LE(176),
      revenue = marketBytes.readBigUInt64LE(184);
    assert.equal(decoded.seatReserves.reduce((sum, seat) => sum + seat.availableCash + seat.reservedCash, 0n)
      + collateral + revenue, accounted);
    assert.equal(vault.amount, accounted); assert.equal(accounted, market.deposits);
    assert.equal(decoded.orders.length, bookBytes.readUInt16LE(78));
    return { decoded, rows: decoded.seatReserves, accounted, collateral, revenue, vault: vault.amount,
      revision: decoded.revision, nextSequence: decoded.nextSequence, raw };
  }

  const full = await createMarket(FULL_MARKET_ID, [{ participant: 0, amount: 2_050n }]);
  let fullState = await marketState(full);
  assert.equal(fullState.rows[0].nextNonce, 1n);
  for (let offset = 0; offset < CAPACITY; offset += BATCH_SIZE) {
    const instructions = await Promise.all(Array.from({ length: BATCH_SIZE }, async (_, index) => {
      const built = await buildPlaceOrderInstruction({ programAddress: PROGRAM, marketId: full.marketId,
        wallet: participants[0], seats: full.seats, expectedNonce: 1n + BigInt(offset + index),
        price: 1n, quantity: 1n, outcome: "YES", action: "BUY", timeInForce: "GTC",
        selfTrade: "CANCEL_AGGRESSOR", postOnly: true, touches: MAX_TOUCHES });
      assert.equal(built.terms, full.terms); assert.equal(built.resolution, full.resolution);
      return built.instruction;
    }));
    await execute(`fill canonical slots ${offset + 1}-${offset + BATCH_SIZE}`, instructions);
  }
  fullState = await marketState(full);
  assert.equal(fullState.decoded.orders.length, CAPACITY);
  assert.equal(new Set(fullState.decoded.orders.map(order => order.slot)).size, CAPACITY);
  assert.equal(fullState.rows[0].nextNonce, 1n + BigInt(CAPACITY));
  assert.equal(fullState.rows[0].reservedCash, 2n * BigInt(CAPACITY));
  assert.equal(fullState.rows[0].availableCash, 2n);
  const fullBytesBefore = fullState.raw.map(account => account?.data[0] ?? null);
  const overflow = await buildPlaceOrderInstruction({ programAddress: PROGRAM, marketId: full.marketId,
    wallet: participants[0], seats: full.seats, expectedNonce: fullState.rows[0].nextNonce,
    price: 2n, quantity: 1n, outcome: "YES", action: "BUY", timeInForce: "GTC",
    selfTrade: "CANCEL_AGGRESSOR", postOnly: true, touches: MAX_TOUCHES });
  await execute("1025th resting order rejects atomically at actual full capacity", [overflow.instruction], { code: 7014 });
  assert.deepEqual((await marketState(full)).raw.map(account => account?.data[0] ?? null), fullBytesBefore);

  const canceledOrder = fullState.decoded.orders.find(order => order.side === "BID");
  assert(canceledOrder);
  const cancellation = await buildCancelOrderInstruction({ programAddress: PROGRAM, marketId: full.marketId,
    wallet: participants[0], seats: full.seats, expectedNonce: fullState.rows[0].nextNonce,
    target: { orderId: canceledOrder.id, side: canceledOrder.side, heapIndex: canceledOrder.heapIndex } });
  await execute("cancel one owner order from the full canonical book", [cancellation.instruction]);
  const afterCancel = await marketState(full);
  assert.equal(afterCancel.decoded.orders.length, CAPACITY - 1);
  assert.equal(afterCancel.rows[0].reservedCash, 2n * BigInt(CAPACITY - 1));
  assert.equal(afterCancel.rows[0].availableCash, 4n);
  assert.equal(afterCancel.nextSequence, fullState.nextSequence);
  const replacement = await buildPlaceOrderInstruction({ programAddress: PROGRAM, marketId: full.marketId,
    wallet: participants[0], seats: full.seats, expectedNonce: afterCancel.rows[0].nextNonce,
    price: 3n, quantity: 1n, outcome: "YES", action: "BUY", timeInForce: "GTC",
    selfTrade: "CANCEL_AGGRESSOR", postOnly: true, touches: MAX_TOUCHES });
  await execute("reuse the one freed slot with a fresh nonce/order ID", [replacement.instruction]);
  const afterReuse = await marketState(full);
  const reused = afterReuse.decoded.orders.find(order => order.id === afterCancel.nextSequence);
  assert(reused);
  assert.equal(reused.slot, canceledOrder.slot, "The canonical free-list did not reuse the released slab slot");
  assert.equal(afterReuse.decoded.orders.length, CAPACITY);
  assert.equal(afterReuse.rows[0].reservedCash, 2n * BigInt(CAPACITY - 1) + 4n);
  assert.equal(afterReuse.rows[0].availableCash, 0n);

  const touchDeposits = Array.from({ length: MAX_TOUCHES }, (_, participant) => ({ participant, amount: 1_000n }));
  touchDeposits.push({ participant: MAX_TOUCHES, amount: 10_000n });
  const touch = await createMarket(TOUCH_MARKET_ID, touchDeposits);
  for (let maker = 0; maker < MAX_TOUCHES; maker++) {
    const before = await marketState(touch);
    const placement = await buildPlaceOrderInstruction({ programAddress: PROGRAM, marketId: touch.marketId,
      wallet: participants[maker], seats: touch.seats, expectedNonce: before.rows[maker].nextNonce,
      price: 400n, quantity: 1n, outcome: "YES", action: "BUY", timeInForce: "GTC",
      selfTrade: "CANCEL_AGGRESSOR", postOnly: true, touches: MAX_TOUCHES });
    await execute(`rest distinct bounded-work maker ${maker + 1}`, [placement.instruction]);
  }
  const beforeBoundary = await marketState(touch);
  assert.equal(beforeBoundary.decoded.orders.length, MAX_TOUCHES);
  assert.equal(new Set(beforeBoundary.decoded.orders.map(order => order.wallet)).size, MAX_TOUCHES);
  const taker = participants[MAX_TOUCHES];
  const tooSmall = await buildPlaceOrderInstruction({ programAddress: PROGRAM, marketId: touch.marketId,
    wallet: taker, seats: touch.seats, expectedNonce: beforeBoundary.rows[MAX_TOUCHES].nextNonce,
    price: 600n, quantity: BigInt(MAX_TOUCHES), outcome: "NO", action: "BUY", timeInForce: "FOK",
    selfTrade: "CANCEL_AGGRESSOR", touches: MAX_TOUCHES - 1 });
  await execute("fifteen-touch FOK cannot consume sixteen makers and rolls back", [tooSmall.instruction], { code: 7014 });
  const stillBefore = await marketState(touch);
  assert.equal(stillBefore.rows[MAX_TOUCHES].nextNonce, beforeBoundary.rows[MAX_TOUCHES].nextNonce);
  assert.deepEqual(stillBefore.decoded.orders.map(order => [order.id, order.slot, order.remaining]),
    beforeBoundary.decoded.orders.map(order => [order.id, order.slot, order.remaining]));
  const exact = await buildPlaceOrderInstruction({ programAddress: PROGRAM, marketId: touch.marketId,
    wallet: taker, seats: touch.seats, expectedNonce: beforeBoundary.rows[MAX_TOUCHES].nextNonce,
    price: 600n, quantity: BigInt(MAX_TOUCHES), outcome: "NO", action: "BUY", timeInForce: "FOK",
    selfTrade: "CANCEL_AGGRESSOR", touches: MAX_TOUCHES });
  const boundary = await execute("sixteen-touch FOK fills sixteen distinct actual makers", [exact.instruction]);
  assert(boundary.cu > 0 && boundary.cu <= 1_400_000, "16-touch execution exceeded explicit transaction budget");
  const eventBytes = boundary.logs.filter(line => line.startsWith("Program data: "))
    .map(line => Buffer.from(line.slice(14), "base64"));
  const trades = eventBytes.filter(value => value.subarray(0, 8).equals(discriminator("event", "TradeExecuted")));
  const orders = eventBytes.filter(value => value.subarray(0, 8).equals(discriminator("event", "OrderExecuted")));
  assert.equal(trades.length, MAX_TOUCHES); assert.equal(orders.length, 1);
  assert.equal(orders[0].readBigUInt64LE(88), BigInt(MAX_TOUCHES));
  assert.equal(orders[0].readBigUInt64LE(96), 0n); assert.equal(orders[0].readBigUInt64LE(104), 0n);
  const makerSeats = new Set<bigint>();
  let makerFees = 0n, takerFees = 0n;
  for (const trade of trades) {
    assert.equal(trade.length, 108);
    makerSeats.add(trade.readBigUInt64LE(56));
    assert.equal(trade.readBigUInt64LE(64), BigInt(MAX_TOUCHES));
    assert.equal(trade.readBigUInt64LE(72), 1n); assert.equal(trade.readBigUInt64LE(80), 400n);
    makerFees += trade.readBigUInt64LE(88); takerFees += trade.readBigUInt64LE(96);
  }
  assert.deepEqual([...makerSeats].sort((a, b) => Number(a - b)),
    Array.from({ length: MAX_TOUCHES }, (_, index) => BigInt(index)));
  assert.equal(makerFees, BigInt(MAX_TOUCHES) * fee(400n));
  assert.equal(takerFees, fee(600n * BigInt(MAX_TOUCHES)));
  const afterBoundary = await marketState(touch);
  assert.equal(afterBoundary.decoded.orders.length, 0);
  assert.equal(afterBoundary.collateral, BigInt(MAX_TOUCHES) * PAYOUT);
  assert.equal(afterBoundary.revenue, makerFees + takerFees);
  for (let maker = 0; maker < MAX_TOUCHES; maker++) {
    assert.deepEqual({ available: afterBoundary.rows[maker].availableCash,
      reserved: afterBoundary.rows[maker].reservedCash, yes: afterBoundary.rows[maker].yes,
      no: afterBoundary.rows[maker].no }, { available: 599n, reserved: 0n, yes: 1n, no: 0n });
  }
  assert.deepEqual({ available: afterBoundary.rows[MAX_TOUCHES].availableCash,
    reserved: afterBoundary.rows[MAX_TOUCHES].reservedCash, yes: afterBoundary.rows[MAX_TOUCHES].yes,
    no: afterBoundary.rows[MAX_TOUCHES].no }, { available: 399n, reserved: 0n, yes: 0n, no: 16n });

  async function finalized(signature: string) {
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      const status = (await rpc<Context<({ confirmationStatus: string; err: unknown } | null)[]>>(
        "getSignatureStatuses", [[signature], { searchTransactionHistory: true }])).value[0];
      if (status?.confirmationStatus === "finalized") { assert.equal(status.err, null); return; }
      await delay(200);
    }
    assert.fail("16-touch boundary transaction did not finalize");
  }
  await finalized(boundary.signature);
  const finalFull = await marketState(full, "finalized");
  const finalTouch = await marketState(touch, "finalized");
  assert.equal(finalFull.decoded.orders.length, CAPACITY); assert.equal(finalTouch.decoded.orders.length, 0);
  const tokenAccounts = await accounts([base.featherMint, ...walletTokens, full.vault, touch.vault], "finalized");
  const mint = getMintDecoder().decode(bytes(tokenAccounts[0]));
  const tokenTotal = tokenAccounts.slice(1).reduce((sum, account) => sum + getTokenDecoder().decode(bytes(account)).amount, 0n);
  assert.equal(mint.supply, BigInt(PARTICIPANT_COUNT) * GRANT);
  assert.equal(tokenTotal, mint.supply, "All participant ATAs and both program vaults must conserve the actual SPL supply");
  assert.equal(finalFull.accounted + finalTouch.accounted,
    finalFull.rows.reduce((sum, row) => sum + row.availableCash + row.reservedCash, 0n)
      + finalTouch.rows.reduce((sum, row) => sum + row.availableCash + row.reservedCash, 0n)
      + finalFull.collateral + finalTouch.collateral + finalFull.revenue + finalTouch.revenue);

  console.log(JSON.stringify({ result: "PASS", scope: "Actual compiled-program order capacity and maximum touch bound",
    rpc: endpoint.toString(), genesis, program: PROGRAM, capacity: CAPACITY, placementBatchSize: BATCH_SIZE,
    capacityMarket: { activeOrders: finalFull.decoded.orders.length, accounted: finalFull.accounted,
      reservedCash: finalFull.rows[0].reservedCash, replacementSlot: reused.slot },
    touchBoundary: { distinctMakers: makerSeats.size, fills: trades.length, computeUnits: boundary.cu,
      collateral: finalTouch.collateral, fees: finalTouch.revenue },
    transactionCaseCount: receipts.length, finalizedBoundarySignature: boundary.signature,
    conservation: { mintSupply: mint.supply, tokenTotal, fullVault: finalFull.vault, touchVault: finalTouch.vault },
    rerun: "npm run test:chain:isolated -- --suite capacity" },
  (_, value: unknown) => typeof value === "bigint" ? value.toString() : value, 2));
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "Capacity RPC suite failed");
  process.exitCode = 1;
});
