/** Actual compiled-program MarketTerms RPC suite. It runs only against the fresh
 * loopback ledger created by solana-program-e2e-isolated.ts --suite terms.
 * Accounts, deposits, reviewer eligibility and signatures are produced by real
 * program instructions; this suite never injects or rewrites account data. */
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, readFile, realpath, readdir } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  address, appendTransactionMessageInstructions, blockhash, createKeyPairSignerFromBytes,
  createTransactionMessage, generateKeyPairSigner, getAddressDecoder, getBase64EncodedWireTransaction,
  getSignatureFromTransaction, pipe, setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash, signTransactionMessageWithSigners,
  type Address, type Instruction,
} from "@solana/kit";
import { getTokenDecoder, TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";
import { getTransferSolInstruction } from "@solana-program/system";
import {
  buildAuthorizeEnrollmentInstruction, buildClaimFeathersInstructions,
  buildInitializeInstruction, deriveGooseyProgramAddresses,
} from "../src/lib/solana/program-client";
import {
  buildCreateMarketInstructions, buildDepositInstruction, buildRegisterSeatInstruction,
} from "../src/lib/solana/escrow-client";
import {
  buildBookSetupInstruction, buildPlaceOrderInstruction, deriveGooseyBookAddress,
  GOOSEY_BOOK_BYTES,
} from "../src/lib/solana/exchange-client";
import { buildInitializeResolutionInstruction } from "../src/lib/solana/resolution-client";
import {
  buildAcceptMarketTermsInstruction, buildInitializeMarketTermsInstruction,
  buildSealMarketTermsInstruction, readMarketTermsAccount,
} from "../src/lib/solana/market-terms-client";
import {
  decodeMarketTerms, encodeMarketTerms, hashMarketTerms, verifyMarketTerms, type MarketTerms,
} from "../src/lib/solana/market-terms";
import { readGooseyEscrow } from "../src/lib/solana/escrow-read";
import { retainMarketTerms, readRetainedMarketTerms, MarketTermsRetentionConflict,
  type RetainedMarketTermsExpectation } from "../src/lib/solana/market-terms-store";

const PROGRAM = address("CgEGAD3EGLm63YaSx58sRiNPQmmxg8RqvqcxE3xThX8Q");
const LOADER = address("BPFLoaderUpgradeab1e11111111111111111111111");
const CLOCK = address("SysvarC1ock11111111111111111111111111111111");
const GRANT = 2_000_000n;
const FEE_BPS = 1;
type Account = { data: [string, string]; owner: Address; executable: boolean; lamports: number };
type Context<T> = { context: { slot: number }; value: T };
type Receipt = { slot: number; meta: { err: unknown; computeUnitsConsumed?: number; logMessages: string[] | null } };
type ExpectedError = { code?: number; index?: number };
type Market = { marketId: bigint; market: Address; seats: Address; vault: Address; book: Address;
  closesAt: bigint; resolvesAt: bigint };

async function main() {
  if (process.argv.includes("--help")) {
    console.log(`Actual Goosey MarketTerms RPC suite. Launch only through:
GOOSEY_SOLANA_BIN_DIR=/path/to/bin node --import tsx scripts/solana-program-e2e-isolated.ts --suite terms
Direct execution requires the fresh runner's loopback RPC, pinned genesis and
disposable upgrade-authority keypair. Public/shared ledgers and account-state
injection are refused.`);
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
  const pin = async () => assert.equal(await rpc("getGenesisHash"), genesis, "Genesis changed; no writes allowed");
  const accounts = async (keys: readonly Address[], commitment = "confirmed") =>
    (await rpc<Context<(Account | null)[]>>("getMultipleAccounts", [keys, { encoding: "base64", commitment }])).value;
  const bytes = (account: Account | null | undefined) => { assert(account); return Buffer.from(account.data[0], "base64"); };
  const chainTime = async () => bytes((await accounts([CLOCK]))[0]).readBigInt64LE(32);
  const waitUntil = async (timestamp: bigint) => {
    const deadline = Date.now() + 240_000;
    while (await chainTime() < timestamp) {
      assert(Date.now() < deadline, `Validator Clock did not reach ${timestamp}`);
      await delay(200);
    }
  };

  await pin();
  const base = await deriveGooseyProgramAddresses(PROGRAM);
  const [program, programData, config] = await accounts([PROGRAM, base.programData, base.config]);
  assert(program?.executable && program.owner === LOADER && programData?.owner === LOADER);
  assert.equal(bytes(program).readUInt32LE(0), 2);
  assert.equal(getAddressDecoder().decode(bytes(program).subarray(4, 36)), base.programData);
  assert.equal(bytes(programData).readUInt32LE(0), 3);
  assert.equal(bytes(programData)[12], 1, "Disposable upgrade authority must be present");
  assert.equal(config, null, "Existing config refused; use a fresh isolated ledger");
  const raw: unknown = JSON.parse(await readFile(adminPath, "utf8"));
  assert(Array.isArray(raw) && raw.length === 64 && raw.every(n => Number.isInteger(n) && n >= 0 && n <= 255));
  const secret = Uint8Array.from(raw);
  const admin = await createKeyPairSignerFromBytes(secret);
  secret.fill(0); raw.fill(0);
  assert.equal(getAddressDecoder().decode(bytes(programData).subarray(13, 45)), admin.address, "Wrong upgrade authority");
  assert((await rpc<Context<number>>("getBalance", [admin.address])).value >= 5_000_000_000);

  const watched = new Set<Address>([base.config, base.featherMint]);
  const receipts: Record<string, unknown>[] = [];
  let serial = 0;
  async function execute(name: string, instructions: readonly Instruction[], expected?: ExpectedError) {
    await pin();
    assert(instructions.length > 0);
    const keys = [...watched];
    const before = expected ? await accounts(keys) : null;
    const lifetime = (await rpc<Context<{ blockhash: string; lastValidBlockHeight: number }>>(
      "getLatestBlockhash", [{ commitment: "confirmed" }])).value;
    const budgetData = Buffer.alloc(5); budgetData[0] = 2;
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
    const send = async () => {
      await pin();
      assert.equal(await rpc("sendTransaction", [wire, { encoding: "base64", skipPreflight: true, maxRetries: 5 }]), signature);
    };
    await send();
    const deadline = Date.now() + 60_000;
    let receipt: Receipt | null = null, resentAt = Date.now();
    while (Date.now() < deadline) {
      receipt = await rpc("getTransaction", [signature, { commitment: "confirmed", maxSupportedTransactionVersion: 0 }]);
      if (receipt?.meta) break;
      if (Date.now() - resentAt > 1_000) { await send(); resentAt = Date.now(); }
      await delay(150);
    }
    assert(receipt?.meta, `Unknown transaction outcome: ${signature}`);
    const logs = receipt.meta.logMessages ?? [];
    assert(logs.some(line => line.startsWith(`Program ${instructions[0].programAddress} invoke`)), `${name}: program not invoked`);
    if (!expected) assert.equal(receipt.meta.err, null, `${name}: ${signature}\n${logs.join("\n")}`);
    else {
      assert.notEqual(receipt.meta.err, null, `${name}: expected failure`);
      if (expected.code !== undefined) assert.deepEqual(receipt.meta.err,
        { InstructionError: [(expected.index ?? 0) + 1, { Custom: expected.code }] }, `${name}: ${logs.join("\n")}`);
      assert.deepEqual(await accounts(keys), before, `${name}: failed transaction did not roll back watched accounts`);
    }
    assert(Number.isInteger(receipt.meta.computeUnitsConsumed));
    receipts.push({ name, signature, slot: receipt.slot, error: receipt.meta.err, cu: receipt.meta.computeUnitsConsumed });
    console.log(`PASS ${name}: ${signature} (${receipt.meta.computeUnitsConsumed} CU)`);
    return { signature, receipt };
  }
  async function awaitFinalized(signature: string) {
    const deadline = Date.now() + 60_000;
    for (;;) {
      const status = (await rpc<Context<({ confirmationStatus: string; err: unknown } | null)[]>>(
        "getSignatureStatuses", [[signature], { searchTransactionHistory: true }])).value[0];
      if (status?.confirmationStatus === "finalized") { assert.equal(status.err, null); return; }
      assert(Date.now() < deadline, `Transaction did not finalize: ${signature}`);
      await delay(200);
    }
  }

  const initialized = await buildInitializeInstruction({ programAddress: PROGRAM, admin, environment: 1,
    genesisDomain: createHash("sha256").update(genesis).digest(), enrollmentAuthority: admin.address,
    perWalletCap: GRANT, campaignCap: 2n * GRANT + 200_002n });
  await execute("initialize actual program and feather mint", [initialized.instruction]);
  const actors = await Promise.all(Array.from({ length: 3 }, () => generateKeyPairSigner()));
  const reviewers = await Promise.all([generateKeyPairSigner(), generateKeyPairSigner()]);
  assert.equal(new Set([admin.address, ...actors.map(a => a.address), ...reviewers.map(r => r.address)]).size, 6);
  await execute("fund disposable actors and reviewers", [...actors, ...reviewers].map(wallet =>
    getTransferSolInstruction({ source: admin, destination: wallet.address, amount: 1_000_000_000n })));
  const enrollmentExpiry = (await chainTime()) + 900n;
  const actorTokens: Address[] = [];
  for (const [index, actor] of actors.entries()) {
    const allowance = index < 2 ? GRANT : 1n;
    const grant = await buildAuthorizeEnrollmentInstruction({ programAddress: PROGRAM, enrollmentAuthority: admin,
      wallet: actor.address, identityDigest: randomBytes(32), allowance, expiresAt: enrollmentExpiry });
    await execute(`authorize actor enrollment ${index}`, [grant.instruction]);
    watched.add(grant.enrollment); watched.add(grant.identity);
    if (index < 2) {
      const claim = await buildClaimFeathersInstructions({ programAddress: PROGRAM, wallet: actor, payer: admin, createAta: true });
      await execute(`actor ${index} claims real SPL feathers`, claim.instructions);
      watched.add(claim.walletTokens); actorTokens.push(claim.walletTokens);
      assert.equal(getTokenDecoder().decode(bytes((await accounts([claim.walletTokens]))[0])).amount, GRANT);
    }
  }
  const reviewerTokens: Address[] = [];
  for (const [index, reviewer] of reviewers.entries()) {
    const allowance = index === 0 ? 200_000n : 1n;
    const grant = await buildAuthorizeEnrollmentInstruction({ programAddress: PROGRAM, enrollmentAuthority: admin,
      wallet: reviewer.address, identityDigest: randomBytes(32), allowance, expiresAt: enrollmentExpiry });
    await execute(`enroll independent reviewer ${index}`, [grant.instruction]);
    watched.add(grant.enrollment); watched.add(grant.identity);
    if (index === 0) {
      const claim = await buildClaimFeathersInstructions({ programAddress: PROGRAM, wallet: reviewer, payer: admin, createAta: true });
      await execute("reviewer 0 claims real SPL feathers for admission rejection", claim.instructions);
      reviewerTokens.push(claim.walletTokens); watched.add(claim.walletTokens);
      assert.equal(getTokenDecoder().decode(bytes((await accounts([claim.walletTokens]))[0])).amount, allowance);
    }
  }

  async function createMarket(marketId: bigint, closesAt: bigint, resolvesAt: bigint): Promise<Market> {
    const created = await buildCreateMarketInstructions({ programAddress: PROGRAM, marketId, admin,
      seats: await generateKeyPairSigner(), seatsRentLamports: BigInt(await rpc<number>("getMinimumBalanceForRentExemption", [32_816])),
      payoutMilli: 100_000n, feeBps: FEE_BPS, closesAt, resolvesAt });
    await execute(`create market ${marketId}`, created.instructions);
    const { book } = await deriveGooseyBookAddress(PROGRAM, created.market);
    for (const key of [created.market, created.seats, created.vault, book]) watched.add(key);
    const setup = async (step: Parameters<typeof buildBookSetupInstruction>[0]["step"]) =>
      (await buildBookSetupInstruction({ programAddress: PROGRAM, marketId, admin, step })).instruction;
    await execute(`create market ${marketId} canonical book`, [await setup({ kind: "create" })]);
    for (;;) {
      const observed = bytes((await accounts([book]))[0]).length;
      if (observed === GOOSEY_BOOK_BYTES) break;
      await execute(`grow market ${marketId} book from ${observed}`, [await setup({ kind: "grow", expectedSize: observed })]);
    }
    await execute(`finalize market ${marketId} canonical book`, [await setup({ kind: "finalize" })]);
    return { marketId, market: created.market, seats: created.seats, vault: created.vault, book, closesAt, resolvesAt };
  }
  async function registerAndDeposit(market: Market, actorIndex: number, amount: bigint) {
    const registered = await buildRegisterSeatInstruction({ programAddress: PROGRAM, marketId: market.marketId,
      wallet: actors[actorIndex], rentPayer: admin, seats: market.seats });
    await execute(`register market ${market.marketId} actor ${actorIndex}`, [registered.instruction]);
    watched.add(registered.locator);
    const deposited = await buildDepositInstruction({ programAddress: PROGRAM, marketId: market.marketId,
      wallet: actors[actorIndex], seats: market.seats, amount, expectedNonce: 0n });
    await execute(`deposit market ${market.marketId} actor ${actorIndex}`, [deposited.instruction]);
  }
  async function registerReviewerAndDeposit(market: Market, amount: bigint) {
    const registered = await buildRegisterSeatInstruction({ programAddress: PROGRAM, marketId: market.marketId,
      wallet: reviewers[0], rentPayer: admin, seats: market.seats });
    await execute(`register market ${market.marketId} designated reviewer`, [registered.instruction]);
    watched.add(registered.locator);
    const deposited = await buildDepositInstruction({ programAddress: PROGRAM, marketId: market.marketId,
      wallet: reviewers[0], seats: market.seats, amount, expectedNonce: 0n });
    await execute(`deposit market ${market.marketId} designated reviewer`, [deposited.instruction]);
  }

  const longClose = (await chainTime()) + 180n;
  const longResolve = longClose + 30n;
  const lifecycle = await createMarket(41n, longClose, longResolve);
  await registerAndDeposit(lifecycle, 1, 100_000n);
  await registerReviewerAndDeposit(lifecycle, 100_000n);
  const initializedTerms = await buildInitializeMarketTermsInstruction({ programAddress: PROGRAM,
    marketId: lifecycle.marketId, seats: lifecycle.seats, creator: admin,
    proposer: reviewers[0].address, approver: reviewers[1].address,
    version: 1, digest: randomBytes(32), manifestLength: 1 });

  const manifest: MarketTerms = {
    version: 1,
    binding: { cluster: "localnet", genesisHash: genesis, program: PROGRAM, config: base.config,
      market: lifecycle.market, marketId: lifecycle.marketId.toString(), creator: admin.address,
      featherMint: base.featherMint },
    question: "Will the Goosey MarketTerms lifecycle pass on this isolated ledger?",
    rules: { yes: "YES if every stated lifecycle assertion succeeds on the pinned isolated ledger.",
      no: "NO if any stated lifecycle assertion fails on the pinned isolated ledger.",
      void: "VOID only if the isolated validator cannot produce a determinate execution record." },
    observation: { startsAt: (longClose - 120n).toString(), endsAt: longClose.toString(), timezone: "UTC" },
    sources: [{ id: "goosey-docs", uri: "https://hackthenorth.com/",
      selection: "Use the pinned transaction receipts and canonical account snapshot retained by this isolated run.",
      snapshotSha256: null }],
    sourcePolicy: { priority: "array-order-first-authoritative",
      missing: "Wait for the designated source to be available; do not substitute an uncommitted source.",
      revisions: "Use only evidence committed by the immutable digest for this market." },
    economics: { payoutMilli: "100000", feeBps: String(FEE_BPS), closesAt: longClose.toString(),
      resolvesAt: longResolve.toString(), decimals: 3 },
    oracle: { kind: "two-reviewer-no-fallback-v1",
      proposer: { wallet: reviewers[0].address, enrollment: initializedTerms.proposerEnrollment },
      approver: { wallet: reviewers[1].address, enrollment: initializedTerms.approverEnrollment },
      unavailable: "wait-for-designated-reviewers", replacement: "none", automaticVoid: false },
  };
  const manifestBytes = encodeMarketTerms(manifest);
  assert.deepEqual(decodeMarketTerms(manifestBytes), manifest);
  const digestHex = await hashMarketTerms(manifestBytes);
  const digest = Buffer.from(digestHex, "hex");
  const termsInit = await buildInitializeMarketTermsInstruction({ programAddress: PROGRAM,
    marketId: lifecycle.marketId, seats: lifecycle.seats, creator: admin,
    proposer: reviewers[0].address, approver: reviewers[1].address,
    version: 1, digest, manifestLength: manifestBytes.length });
  assert.equal(termsInit.terms, initializedTerms.terms);
  watched.add(termsInit.terms);
  const initReceipt = await execute("initialize immutable canonical market terms", [termsInit.instruction]);
  const initialRaw = bytes((await accounts([termsInit.terms]))[0]);
  const binding = { programAddress: PROGRAM, marketId: lifecycle.marketId, config: base.config,
    market: lifecycle.market, creator: admin.address,
    proposer: { wallet: reviewers[0].address, enrollment: termsInit.proposerEnrollment },
    approver: { wallet: reviewers[1].address, enrollment: termsInit.approverEnrollment } };
  const decodeAccount = async (commitment = "confirmed") => {
    const account = (await accounts([termsInit.terms], commitment))[0]; assert(account);
    return readMarketTermsAccount(binding, { address: termsInit.terms, owner: account.owner,
      executable: account.executable, data: bytes(account) });
  };
  const initial = await decodeAccount();
  assert.equal(Buffer.from(initial.digest).toString("hex"), digestHex);
  assert.equal(initial.manifestLength, manifestBytes.length);
  assert.equal(initial.acceptanceBits, 0); assert.equal(initial.sealed, false);
  assert.deepEqual(await verifyMarketTerms(manifestBytes, { digest: digestHex, binding: manifest.binding,
    economics: manifest.economics, proposer: manifest.oracle.proposer, approver: manifest.oracle.approver }), manifest);

  await execute("reinitialize existing terms PDA rejected atomically", [termsInit.instruction], {});
  const prematureSeal = await buildSealMarketTermsInstruction({ programAddress: PROGRAM, marketId: lifecycle.marketId,
    seats: lifecycle.seats, creator: admin, expectedDigest: digest });
  await execute("seal without both acceptances rejected", [prematureSeal.instruction], { code: 7610 });
  const unauthorized = await buildAcceptMarketTermsInstruction({ programAddress: PROGRAM, marketId: lifecycle.marketId,
    seats: lifecycle.seats, reviewer: actors[2], expectedDigest: digest });
  await execute("enrolled but undesignated reviewer rejected", [unauthorized.instruction], { code: 7606 });
  const wrongDigest = await buildAcceptMarketTermsInstruction({ programAddress: PROGRAM, marketId: lifecycle.marketId,
    seats: lifecycle.seats, reviewer: reviewers[0], expectedDigest: randomBytes(32) });
  await execute("designated reviewer mismatched digest rejected", [wrongDigest.instruction], { code: 7608 });
  const proposerAccept = await buildAcceptMarketTermsInstruction({ programAddress: PROGRAM, marketId: lifecycle.marketId,
    seats: lifecycle.seats, reviewer: reviewers[0], expectedDigest: digest });
  await execute("designated proposer accepts exact digest", [proposerAccept.instruction]);
  assert.equal((await decodeAccount()).acceptanceBits, 1);
  await execute("repeat proposer acceptance rejected", [proposerAccept.instruction], { code: 7609 });
  const approverAccept = await buildAcceptMarketTermsInstruction({ programAddress: PROGRAM, marketId: lifecycle.marketId,
    seats: lifecycle.seats, reviewer: reviewers[1], expectedDigest: digest });
  await execute("independent approver accepts exact digest", [approverAccept.instruction]);
  assert.equal((await decodeAccount()).acceptanceBits, 3);
  const sealedReceipt = await execute("creator seals accepted pristine terms", [prematureSeal.instruction]);
  const sealedRaw = bytes((await accounts([termsInit.terms]))[0]);
  const sealed = await decodeAccount();
  assert.equal(sealed.sealed, true); assert.equal(sealed.acceptanceBits, 3);
  assert.deepEqual(sealedRaw.subarray(8, 237), initialRaw.subarray(8, 237), "Commitment or reviewer binding mutated");
  assert.equal(sealedRaw[239], initialRaw[239], "Canonical bump mutated");
  assert.deepEqual(sealedRaw.subarray(237, 239), Buffer.from([3, 1]));
  await execute("acceptance after seal rejected", [approverAccept.instruction], { code: 7611 });
  await execute("seal replay rejected", [prematureSeal.instruction], { code: 7611 });

  const mismatchedResolution = await buildInitializeResolutionInstruction({ programAddress: PROGRAM,
    marketId: lifecycle.marketId, seats: lifecycle.seats, creator: admin,
    proposer: reviewers[0].address, approver: actors[2].address });
  watched.add(mismatchedResolution.resolution);
  await execute("resolution reviewer pair mismatching sealed terms rejected", [mismatchedResolution.instruction], { code: 7600 });
  const resolution = await buildInitializeResolutionInstruction({ programAddress: PROGRAM,
    marketId: lifecycle.marketId, seats: lifecycle.seats, creator: admin,
    proposer: reviewers[0].address, approver: reviewers[1].address });
  watched.add(resolution.resolution);
  await execute("initialize resolution with same frozen reviewers", [resolution.instruction]);
  const reviewerOrder = await buildPlaceOrderInstruction({ programAddress: PROGRAM, marketId: lifecycle.marketId,
    seats: lifecycle.seats, wallet: reviewers[0], expectedNonce: 1n, action: "BUY", outcome: "YES",
    price: 10_000n, quantity: 1n, timeInForce: "IOC", selfTrade: "CANCEL_AGGRESSOR", touches: 16 });
  await execute("designated reviewer trading rejected by sealed terms admission", [reviewerOrder.instruction], { code: 7613 });
  const participantOrder = await buildPlaceOrderInstruction({ programAddress: PROGRAM, marketId: lifecycle.marketId,
    seats: lifecycle.seats, wallet: actors[1], expectedNonce: 1n, action: "BUY", outcome: "YES",
    price: 10_000n, quantity: 1n, timeInForce: "IOC", selfTrade: "CANCEL_AGGRESSOR", touches: 16 });
  const participantReceipt = await execute("ordinary participant passes sealed terms admission", [participantOrder.instruction]);
  await awaitFinalized(participantReceipt.signature);
  const runtime = { cluster: "localnet" as const, rpcUrl: endpoint.toString(), genesisHash: genesis, programAddress: PROGRAM };
  const snapshot = await readGooseyEscrow(runtime, { marketId: lifecycle.marketId, wallet: actors[1].address },
    { includeMarketTerms: true });
  assert(snapshot.finalizedSlot >= BigInt(participantReceipt.receipt.slot));
  assert.equal(snapshot.marketTerms?.address, termsInit.terms);
  assert.equal(snapshot.marketTerms?.sealed, true);
  assert.equal(snapshot.marketTerms?.acceptanceBits, 3);
  assert.equal(Buffer.from(snapshot.marketTerms!.digest).toString("hex"), digestHex);
  assert.deepEqual(snapshot.marketTerms?.proposer, manifest.oracle.proposer);
  assert.deepEqual(snapshot.marketTerms?.approver, manifest.oracle.approver);
  assert.equal(snapshot.resolution?.proposer.wallet, reviewers[0].address);
  assert.equal(snapshot.resolution?.approver.wallet, reviewers[1].address);
  assert.equal(snapshot.orderBook?.orders.length, 0);
  assert.equal(snapshot.orderBook?.reservesReconciled, true);

  // Retain the EXISTING suite manifest, not a substitute. Every expectation
  // below comes from the coherent finalized account snapshot or pinned domain.
  assert(snapshot.marketTerms && snapshot.resolution);
  assert(snapshot.finalizedSlot >= BigInt(sealedReceipt.receipt.slot));
  const retainedExpectation: RetainedMarketTermsExpectation = {
    digest: Buffer.from(snapshot.marketTerms.digest).toString("hex"),
    manifestLength: snapshot.marketTerms.manifestLength,
    binding: { cluster: runtime.cluster, genesisHash: runtime.genesisHash, program: runtime.programAddress,
      config: snapshot.config, market: snapshot.market, marketId: snapshot.marketState.marketId.toString(),
      creator: snapshot.marketState.creator, featherMint: snapshot.featherMint },
    economics: { payoutMilli: snapshot.marketState.payoutMilli.toString(), feeBps: snapshot.marketState.feeBps.toString(),
      closesAt: snapshot.marketState.closesAt.toString(), resolvesAt: snapshot.marketState.resolvesAt.toString(), decimals: 3 },
    proposer: snapshot.marketTerms.proposer, approver: snapshot.marketTerms.approver,
  };
  assert.deepEqual(retainedExpectation.proposer, snapshot.resolution.proposer);
  assert.deepEqual(retainedExpectation.approver, snapshot.resolution.approver);
  // Retained beneath this runner's private evidence directory; no shared store,
  // DB, endpoint or operator configuration is changed. Runner owns its lifetime.
  const termsStore = await mkdtemp(path.join(path.dirname(adminPath), "market-terms-store-"));
  assert.equal((await retainMarketTerms(termsStore, manifestBytes, retainedExpectation)).created, true);
  const retrieved = await readRetainedMarketTerms(termsStore, retainedExpectation);
  assert.deepEqual(retrieved.bytes, manifestBytes);
  assert.deepEqual(retrieved.terms, manifest);
  assert.equal(retrieved.digest, digestHex);
  assert.equal(await hashMarketTerms(retrieved.bytes), retainedExpectation.digest);
  assert.equal((await retainMarketTerms(termsStore, manifestBytes, retainedExpectation)).created, false);
  const changedManifest = structuredClone(manifest);
  changedManifest.question = "Altered isolated test manifest; must never replace finalized sealed terms.";
  const changedBytes = encodeMarketTerms(changedManifest);
  await assert.rejects(retainMarketTerms(termsStore, changedBytes, retainedExpectation));
  // Even if a caller supplies a self-consistent NEW digest/length, the store's
  // market identity is immutable. This candidate is never sent to the chain.
  const conflictingExpectation = { ...retainedExpectation, digest: await hashMarketTerms(changedBytes), manifestLength: changedBytes.length };
  await assert.rejects(retainMarketTerms(termsStore, changedBytes, conflictingExpectation), MarketTermsRetentionConflict);
  await assert.rejects(readRetainedMarketTerms(termsStore, conflictingExpectation));
  assert.deepEqual((await readRetainedMarketTerms(termsStore, retainedExpectation)).bytes, manifestBytes);
  assert.equal((await readdir(termsStore)).length, 1, "No conflicting or pending manifest published");
  console.log(`PASS finalized immutable terms retention/retrieval: ${retainedExpectation.digest} at slot ${snapshot.finalizedSlot}`);

  const missing = await createMarket(42n, longClose, longResolve);
  const missingResolution = await buildInitializeResolutionInstruction({ programAddress: PROGRAM,
    marketId: missing.marketId, seats: missing.seats, creator: admin,
    proposer: reviewers[0].address, approver: reviewers[1].address });
  watched.add(missingResolution.resolution); watched.add(missingResolution.terms);
  await execute("resolution initialization without MarketTerms fails closed", [missingResolution.instruction], {});

  const unsealed = await createMarket(44n, longClose, longResolve);
  const unsealedDigest = randomBytes(32);
  const unsealedTerms = await buildInitializeMarketTermsInstruction({ programAddress: PROGRAM,
    marketId: unsealed.marketId, seats: unsealed.seats, creator: admin,
    proposer: reviewers[0].address, approver: reviewers[1].address,
    version: 1, digest: unsealedDigest, manifestLength: 321 });
  watched.add(unsealedTerms.terms);
  await execute("initialize deliberately unsealed terms fixture", [unsealedTerms.instruction]);
  const unsealedResolution = await buildInitializeResolutionInstruction({ programAddress: PROGRAM,
    marketId: unsealed.marketId, seats: unsealed.seats, creator: admin,
    proposer: reviewers[0].address, approver: reviewers[1].address });
  watched.add(unsealedResolution.resolution);
  await execute("resolution initialization with unsealed terms fails closed", [unsealedResolution.instruction], { code: 7600 });

  const lateClose = (await chainTime()) + 35n;
  const late = await createMarket(43n, lateClose, lateClose + 20n);
  const lateDigest = randomBytes(32);
  const lateTerms = await buildInitializeMarketTermsInstruction({ programAddress: PROGRAM,
    marketId: late.marketId, seats: late.seats, creator: admin,
    proposer: reviewers[0].address, approver: reviewers[1].address,
    version: 1, digest: lateDigest, manifestLength: 50 });
  watched.add(lateTerms.terms);
  await execute("initialize short-lived pristine terms", [lateTerms.instruction]);
  for (const reviewer of reviewers) {
    const acceptance = await buildAcceptMarketTermsInstruction({ programAddress: PROGRAM,
      marketId: late.marketId, seats: late.seats, reviewer, expectedDigest: lateDigest });
    await execute(`short-lived designated reviewer ${reviewer.address} accepts`, [acceptance.instruction]);
  }
  await waitUntil(lateClose);
  const lateSeal = await buildSealMarketTermsInstruction({ programAddress: PROGRAM, marketId: late.marketId,
    seats: late.seats, creator: admin, expectedDigest: lateDigest });
  await execute("seal at or after market close rejected", [lateSeal.instruction], { code: 7612 });

  await awaitFinalized(sealedReceipt.signature);
  const finalizedTerms = await decodeAccount("finalized");
  assert.deepEqual(finalizedTerms, sealed);
  const tokenAccounts = await accounts([...actorTokens, ...reviewerTokens, lifecycle.vault, missing.vault,
    unsealed.vault, late.vault, base.featherMint], "finalized");
  tokenAccounts.slice(0, -1).forEach(account => assert.equal(account?.owner, TOKEN_PROGRAM_ADDRESS));

  console.log(JSON.stringify({ result: "PASS", scope: "Actual compiled-program immutable MarketTerms RPC lifecycle",
    rpc: endpoint.toString(), genesis, program: PROGRAM, validator: await rpc("getVersion"),
    transactionCaseCount: receipts.length, initializedSignature: initReceipt.signature,
    sealedSignature: sealedReceipt.signature, finalizedSlot: snapshot.finalizedSlot,
    manifest: { bytes: manifestBytes.length, digest: digestHex, verifiedAgainstActualAddresses: true },
    retention: { directory: termsStore, verifiedFinalizedSlot: snapshot.finalizedSlot, digest: retainedExpectation.digest,
      exactBytes: true, sameContentIdempotent: true, mutatedContentRejected: true, conflictingDigestRejected: true },
    checks: ["pristine ready-book initialization with real deposit", "strict account decoder",
      "canonical manifest binding", "two independent exact-digest acceptances", "unauthorized/mismatch/repeat rollback",
      "reinitialization rejection", "unaccepted seal rejection", "sealed commitment byte immutability",
      "missing/unsealed/mismatched terms fail-closed activation", "designated reviewer trading rejection",
      "ordinary participant admission", "post-close seal rejection",
      "finalized same-batch market/book/resolution/terms read with matching frozen reviewers",
      "exact canonical filesystem retention/retrieval against finalized sealed terms",
      "idempotent same-content retention and mutated/conflicting manifest rejection"],
    admissionScope: "Mandatory sealed terms are enforced for new-order and resolution initialization; legacy settlement, withdrawal and cancellation are outside this suite.",
    receipts }, (_, value: unknown) => typeof value === "bigint" ? value.toString() : value, 2));
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "MarketTerms RPC suite failed");
  process.exitCode = 1;
});
