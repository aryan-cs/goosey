/** Actual RPC matcher integration. NEVER sets account data or seeds positions.
 * Run ONLY against a NEW isolated ledger containing the compiled Goosey program.
 * Same explicit loopback/genesis/temporary-admin contract as the isolated runner.
 * Does not launch, reset or stop any validator. See --help; no default endpoint.
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { DEVNET_GENESIS_HASH, MAINNET_GENESIS_HASH, TESTNET_GENESIS_HASH } from "../src/lib/solana/runtime";
import { createHash, randomBytes } from "node:crypto";
import { open, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { PrismaClient } from "@prisma/client";
import { AccountRole, address, appendTransactionMessageInstructions, blockhash, createKeyPairSignerFromBytes,
  createTransactionMessage, generateKeyPairSigner, getAddressDecoder, getAddressEncoder, getBase64EncodedWireTransaction,
  getProgramDerivedAddress, getSignatureFromTransaction, pipe, setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash, signTransactionMessageWithSigners,
  type AccountMeta, type Address, type Instruction, type TransactionSigner } from "@solana/kit";
import { getMintDecoder, getTokenDecoder, TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";
import { getTransferSolInstruction, SYSTEM_PROGRAM_ADDRESS } from "@solana-program/system";
import { buildInitializeInstruction, buildAuthorizeEnrollmentInstruction, buildClaimFeathersInstructions,
  deriveGooseyProgramAddresses } from "../src/lib/solana/program-client";
import { buildCreateMarketInstructions, buildRegisterSeatInstruction, buildDepositInstruction,
  buildWithdrawInstruction } from "../src/lib/solana/escrow-client";
import { buildBookSetupInstruction, buildPlaceOrderInstruction } from "../src/lib/solana/exchange-client";
import { readGooseyEscrow } from "../src/lib/solana/escrow-read";
import { buildFeatherTransfer } from "../src/lib/solana/feather-transfer";
import { prepareOrder } from "../src/lib/solana/prepare-order";
import { submitSignedWalletTransaction, type TransferSubmission } from "../src/lib/solana/submit-transfer";
import { buildInitializeResolutionInstruction } from "../src/lib/solana/resolution-client";
import { buildInitializeMarketTermsInstruction, buildAcceptMarketTermsInstruction, buildSealMarketTermsInstruction,
  deriveGooseyMarketTermsAddresses } from "../src/lib/solana/market-terms-client";
import { encodeMarketTerms, hashMarketTerms } from "../src/lib/solana/market-terms";
import { decodeFinalizedProgramEvents, type GooseyProgramEvent } from "../src/lib/solana/program-events";
import { readFinalizedProgramEvents } from "../src/lib/solana/program-event-read";
import { ingestFinalizedProgramTransaction } from "../src/lib/solana/event-journal";
import { ingestFinalizedProgramPage } from "../src/lib/solana/ingestion-worker";

const PROGRAM = address("CgEGAD3EGLm63YaSx58sRiNPQmmxg8RqvqcxE3xThX8Q");
const LOADER = address("BPFLoaderUpgradeab1e11111111111111111111111");
const CLOCK = address("SysvarC1ock11111111111111111111111111111111");
const BOOK_BYTES = 69_720, STEP = 10_240, CAPACITY = 1024;
const PAYOUT = 1_000n, FEE_BPS = 100n, GRANT = 1_000_000n;
const executeFile = promisify(execFile);
const keyBytes = (key: Address) => Buffer.from(getAddressEncoder().encode(key));
const disc = (space: string, name: string) => createHash("sha256").update(`${space}:${name}`).digest().subarray(0, 8);
function u64(n: bigint) { const b = Buffer.alloc(8); b.writeBigUInt64LE(n); return b; }
function i64(n: bigint) { const b = Buffer.alloc(8); b.writeBigInt64LE(n); return b; }
function u32(n: number) { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; }
const ro = (key: Address): AccountMeta => ({ address: key, role: AccountRole.READONLY });
const rw = (key: Address): AccountMeta => ({ address: key, role: AccountRole.WRITABLE });
const signer = (key: TransactionSigner, writable = false) => ({ address: key.address, signer: key, role: writable ? AccountRole.WRITABLE_SIGNER : AccountRole.READONLY_SIGNER });
const fee = (notional: bigint) => (notional * FEE_BPS + 9_999n) / 10_000n;
type ChainAccount = { data: [string, string]; owner: string; executable: boolean; lamports: number };
type Context<T> = { context: { slot: number }; value: T };
type Receipt = { slot: number; meta: { err: unknown; fee: number; computeUnitsConsumed?: number; logMessages: string[] | null } | null };
type ExpectedError = number | { index: number; error: number | string };
type OrderArgs = { expectedNonce?: bigint; price: bigint; quantity: bigint; outcome: number; action: number;
  tif?: number; selfTrade?: number; postOnly?: boolean; expiresAt?: bigint; touches?: number };
type OrderEvent = { orderId: bigint; nonce: bigint; filled: bigint; canceled: bigint; rested: bigint; disposition: number };
type TradeEvent = { makerOrderId: bigint; takerOrderId: bigint; makerSeat: bigint; takerSeat: bigint;
  quantity: bigint; yesPrice: bigint; makerFee: bigint; takerFee: bigint; makerOutcome: number; makerAction: number; takerOutcome: number; takerAction: number };
type RemovalEvent = { orderId: bigint; seat: bigint; remaining: bigint; reason: number };

async function main() {
  if (process.argv.includes("--help")) {
    console.log(`Actual Goosey exchange RPC suite (no mock state).
Preferred isolated launch: GOOSEY_SOLANA_BIN_DIR=/path/to/bin npm run test:chain:exchange
Required: GOOSEY_SOLANA_RPC_URL, GOOSEY_SOLANA_GENESIS_HASH,
GOOSEY_SOLANA_TEST_ADMIN_KEYPAIR=/tmp/goosey-solana-<run>/goosey-admin-keypair.json.
Use a freshly isolated validator loaded with the actual compiled SBPFv3 program
via --upgradeable-program ${PROGRAM} <artifact.so> <fresh-admin-pubkey>.
Supply that same fresh admin explicitly as --mint and in a private CLI config.
Never use personal CLI configuration or reset a shared ledger. Ports 18999/8080
are prohibited. Existing config is refused. This script leaves validator lifecycle
to its caller. All other signers remain in memory; no private keys are printed.
Run: node --import tsx scripts/solana-exchange-e2e.ts
Each transaction sets a 1.4M CU ceiling; receipts record actual compute consumed.
Book ABI: create_book(); grow_book(expected_size:u32); finalize_book();
place_order(u64 nonce,u64 price,u64 quantity,u8 outcome,u8 action,u8 tif,
u8 self_trade,bool post_only,Option<i64> expires_at,u8 touches).
Scope includes real grants/claims/deposits, incremental PDA bootstrap, all four
trade paths, account/book/heap/reserve/supply invariants and atomic rejections.
Resolution initialization is tested; no cancellation/replacement/settlement lifecycle is claimed.`);
    return;
  }
  assert.equal(process.argv.length, 2, "Unknown arguments; use --help");
  const endpoint = new URL(process.env.GOOSEY_SOLANA_RPC_URL ?? "");
  assert(["127.0.0.1", "[::1]"].includes(endpoint.hostname) && ["http:", "https:"].includes(endpoint.protocol), "Literal loopback RPC required");
  assert(!endpoint.username && !endpoint.password && !endpoint.hash && !endpoint.search, "Unsafe RPC URL");
  assert(!["18999", "8080"].includes(endpoint.port), "Shared validator/app ports are prohibited");
  const genesis = process.env.GOOSEY_SOLANA_GENESIS_HASH ?? "";
  assert(genesis && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(genesis), "Explicit genesis pin required");
  address(genesis);
  assert(![MAINNET_GENESIS_HASH, DEVNET_GENESIS_HASH, TESTNET_GENESIS_HASH].includes(genesis), "Public clusters prohibited");
  assert(process.env.GOOSEY_SOLANA_TEST_ADMIN_KEYPAIR, "Explicit disposable test-admin path required");
  const adminPath = await realpath(process.env.GOOSEY_SOLANA_TEST_ADMIN_KEYPAIR);
  const relative = path.relative(await realpath("/tmp"), adminPath).split(path.sep);
  assert(relative.length === 2 && /^goosey-solana-[A-Za-z0-9._-]+$/.test(relative[0]) && relative[1] === "goosey-admin-keypair.json", "Admin must be a dedicated disposable /tmp/goosey-solana-* test key");
  let rpcId = 0;
  async function rpc<T>(method: string, params: unknown[] = []): Promise<T> {
    const response = await fetch(endpoint, { method: "POST", redirect: "error", signal: AbortSignal.timeout(10_000),
      headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params }) });
    assert(response.ok, `RPC HTTP ${response.status}`);
    const body = await response.json() as { result: T; error?: { code: number; message: string } };
    if (body.error) throw new Error(`${method}: ${body.error.code}: ${body.error.message}`);
    return body.result;
  }
  const pin = async () => assert.equal(await rpc("getGenesisHash"), genesis, "Genesis changed: no writes allowed");
  const accounts = async (keys: readonly Address[], commitment: "confirmed" | "finalized" = "confirmed") => (await rpc<Context<(ChainAccount | null)[]>>("getMultipleAccounts", [keys, { encoding: "base64", commitment }])).value;
  const bytes = (account: ChainAccount | null | undefined) => { assert(account, "Expected real account missing"); return Buffer.from(account.data[0], "base64"); };
  await pin();
  const base = await deriveGooseyProgramAddresses(PROGRAM);
  const [program, programData, config] = await accounts([PROGRAM, base.programData, base.config]);
  assert(program?.executable && program.owner === LOADER && programData?.owner === LOADER, "Actual upgradeable program required");
  assert.equal(bytes(program).readUInt32LE(0), 2);
  assert.equal(getAddressDecoder().decode(bytes(program).subarray(4, 36)), base.programData);
  assert.equal(bytes(programData).readUInt32LE(0), 3);
  assert.equal(bytes(programData)[12], 1);
  assert.equal(config, null, "Existing config refused: use a NEW isolated ledger; never reset shared state");
  const raw: unknown = JSON.parse(await readFile(adminPath, "utf8"));
  assert(Array.isArray(raw) && raw.length === 64 && raw.every(n => Number.isInteger(n) && n >= 0 && n <= 255));
  const secret = new Uint8Array(raw);
  const admin = await createKeyPairSignerFromBytes(secret);
  secret.fill(0); raw.fill(0);
  assert.equal(getAddressDecoder().decode(bytes(programData).subarray(13, 45)), admin.address, "Fresh key is not this program's actual upgrade authority");
  assert((await rpc<Context<number>>("getBalance", [admin.address, { commitment: "confirmed" }])).value >= 5_000_000_000, "Pre-fund ONLY the fresh test admin via isolated-validator --mint");
  const receipts: Record<string, unknown>[] = [];
  const watched = new Set<Address>([base.config, base.featherMint]);
  let lastBlockhash = "";
  const budget: Instruction = { programAddress: address("ComputeBudget111111111111111111111111111111"), data: Buffer.concat([Buffer.from([2]), u32(1_400_000)]) };
  async function execute(name: string, instructions: readonly Instruction[], error?: ExpectedError) {
    await pin();
    const keys = [...watched], before = error === undefined ? undefined : await accounts(keys);
    const deadline = Date.now() + 15_000;
    let lifetime: { blockhash: string; lastValidBlockHeight: number };
    do {
      lifetime = (await rpc<Context<typeof lifetime>>("getLatestBlockhash", [{ commitment: "confirmed" }])).value;
      if (lifetime.blockhash !== lastBlockhash) break;
      assert(Date.now() < deadline, "Validator blockhash failed to advance"); await delay(150);
    } while (true);
    lastBlockhash = lifetime.blockhash;
    const message = pipe(createTransactionMessage({ version: 0 }), tx => setTransactionMessageFeePayerSigner(admin, tx),
      tx => setTransactionMessageLifetimeUsingBlockhash({ blockhash: blockhash(lifetime.blockhash), lastValidBlockHeight: BigInt(lifetime.lastValidBlockHeight) }, tx),
      tx => appendTransactionMessageInstructions([budget, ...instructions], tx));
    const signed = await signTransactionMessageWithSigners(message), signature = getSignatureFromTransaction(signed);
    const wire = getBase64EncodedWireTransaction(signed);
    const send = async () => { await pin(); assert.equal(await rpc("sendTransaction", [wire, { encoding: "base64", skipPreflight: true, maxRetries: 5 }]), signature); };
    await send();
    const confirmationDeadline = Date.now() + 60_000;
    let resent = Date.now();
    type SignatureStatus = { err: unknown; confirmationStatus: string };
    let status: SignatureStatus | null = null;
    while (Date.now() < confirmationDeadline) {
      status = (await rpc<Context<(SignatureStatus | null)[]>>("getSignatureStatuses", [[signature], { searchTransactionHistory: true }])).value[0];
      if (status && ["confirmed", "finalized"].includes(status.confirmationStatus)) break;
      if (!status && Date.now() - resent > 1_000) { await send(); resent = Date.now(); }
      await delay(200);
    }
    assert(status && ["confirmed", "finalized"].includes(status.confirmationStatus), `Unknown outcome; reconcile this same signature: ${signature}`);
    let receipt: Receipt | null = null;
    for (let i = 0; i < 30; i++) {
      receipt = await rpc("getTransaction", [signature, { commitment: "confirmed", maxSupportedTransactionVersion: 0 }]);
      if (receipt?.meta) break;
      await delay(200);
    }
    assert(receipt?.meta, "Execution receipt unavailable");
    const logs = receipt.meta.logMessages ?? [];
    assert(logs.some(line => line.startsWith(`Program ${instructions[0].programAddress} invoke`)), `${name}: no actual program invocation`);
    assert.deepEqual(receipt.meta.err, status.err);
    if (error === undefined) assert.equal(receipt.meta.err, null, `${name}: ${signature}: ${JSON.stringify(receipt.meta.err)}\n${logs.join("\n")}`);
    else {
      const expected = typeof error === "number" ? { index: 0, error } : error;
      assert.deepEqual(receipt.meta.err, { InstructionError: [expected.index + 1, typeof expected.error === "number" ? { Custom: expected.error } : expected.error] }, `${name}: ${signature}: ${logs.join("\n")}`);
      assert.deepEqual(await accounts(keys), before, `${name}: failed transaction mutated economic accounts (fee payer excluded)`);
    }
    receipts.push({ name, signature, slot: receipt.slot, error: receipt.meta.err, feeLamports: receipt.meta.fee, computeUnits: receipt.meta.computeUnitsConsumed });
    console.log(`PASS ${name}: ${signature} (${receipt.meta.computeUnitsConsumed ?? "unknown"} CU)`);
    return { signature, wire, receipt, logs, send };
  }
  const time = async () => bytes((await accounts([CLOCK]))[0]).readBigInt64LE(32);
  async function until(timestamp: bigint) {
    const deadline = Date.now() + 45_000;
    while (await time() < timestamp) { assert(Date.now() < deadline, "Validator Clock deadline exceeded"); await delay(200); }
  }
  async function finalized(signature: string, minimumSlot: number) {
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      const status = (await rpc<Context<({ err: unknown; confirmationStatus: string; slot: number } | null)[]>>("getSignatureStatuses", [[signature], { searchTransactionHistory: true }])).value[0];
      if (status?.confirmationStatus === "finalized") {
        assert.equal(status.err, null); assert.equal(status.slot, minimumSlot);
        const root = await rpc<number>("getSlot", [{ commitment: "finalized" }]);
        assert(root >= minimumSlot);
        return root;
      }
      await delay(200);
    }
    throw new Error(`Exact transaction signature did not finalize: ${signature}`);
  }
  const initialized = await buildInitializeInstruction({ programAddress: PROGRAM, admin, environment: 1,
    genesisDomain: createHash("sha256").update(genesis).digest(), enrollmentAuthority: admin.address,
    perWalletCap: GRANT, campaignCap: 4n * GRANT + 2n });
  const initializationReceipt = await execute("initialize real program and 3-decimal feather mint", [initialized.instruction]);
  const actors = await Promise.all(Array.from({ length: 4 }, () => generateKeyPairSigner()));
  await execute("fund four ephemeral wallets with local SOL for account rent", actors.map(wallet => getTransferSolInstruction({ source: admin, destination: wallet.address, amount: 1_000_000_000n })));
  const walletTokens: Address[] = [], enrollments: Address[] = [];
  const enrollmentReceipts: Awaited<ReturnType<typeof execute>>[] = [];
  const claimReceipts: Awaited<ReturnType<typeof execute>>[] = [];
  const closesAt = (await time()) + 900n;
  for (const [i, wallet] of actors.entries()) {
    const enrolled = await buildAuthorizeEnrollmentInstruction({ programAddress: PROGRAM, enrollmentAuthority: admin,
      wallet: wallet.address, identityDigest: randomBytes(32), allowance: GRANT, expiresAt: closesAt });
    enrollmentReceipts.push(await execute(`authorize real unique wallet ${i}`, [enrolled.instruction]));
    const claim = await buildClaimFeathersInstructions({ programAddress: PROGRAM, wallet, payer: admin, createAta: true });
    claimReceipts.push(await execute(`wallet ${i} claims actual SPL feathers`, claim.instructions));
    walletTokens.push(claim.walletTokens); enrollments.push(claim.enrollment);
    watched.add(claim.walletTokens); watched.add(claim.enrollment); watched.add(enrolled.identity);
  }
  // Independent oracle identities: no creator/trader reuse, claims or seats.
  const reviewers = await Promise.all([generateKeyPairSigner(), generateKeyPairSigner()]);
  const reviewerEnrollments: Address[] = [];
  for (const [i, reviewer] of reviewers.entries()) {
    assert(reviewer.address !== admin.address && !actors.some(actor => actor.address === reviewer.address));
    const enrolled = await buildAuthorizeEnrollmentInstruction({ programAddress: PROGRAM, enrollmentAuthority: admin,
      wallet: reviewer.address, identityDigest: randomBytes(32), allowance: 1n, expiresAt: closesAt });
    watched.add(enrolled.enrollment); watched.add(enrolled.identity); reviewerEnrollments.push(enrolled.enrollment);
    await execute(`enroll independent unclaimed resolution reviewer ${i}`, [enrolled.instruction]);
  }
  assert.notEqual(reviewers[0].address, reviewers[1].address);
  async function termsPlan(id: bigint, seats: Address, close: bigint) {
    const a = await deriveGooseyMarketTermsAddresses({ programAddress: PROGRAM, marketId: id });
    const manifest = encodeMarketTerms({ version: 1,
      binding: { cluster: "localnet", genesisHash: genesis, program: PROGRAM, config: base.config, market: a.market,
        marketId: String(id), creator: admin.address, featherMint: base.featherMint },
      question: `Local integration test market ${id}: did the specified transaction scenario complete?`,
      rules: { yes: "YES if the recorded local integration transaction scenario completes successfully.",
        no: "NO if its finalized execution fails.", void: "VOID if no finalized execution can be obtained." },
      observation: { startsAt: "0", endsAt: String(close), timezone: "UTC" },
      sources: [{ id: "local-test", uri: "https://example.invalid/goosey-local-integration",
        selection: "Offline test specification only: inspect this isolated validator's finalized transaction receipts. No production event is represented.", snapshotSha256: null }],
      sourcePolicy: { priority: "array-order-first-authoritative", missing: "Use the explicit VOID criterion.", revisions: "Finalized local receipts are the sole test evidence." },
      economics: { payoutMilli: String(PAYOUT), feeBps: String(FEE_BPS), closesAt: String(close), resolvesAt: String(close), decimals: 3 },
      oracle: { kind: "two-reviewer-no-fallback-v1", proposer: { wallet: reviewers[0].address, enrollment: reviewerEnrollments[0] },
        approver: { wallet: reviewers[1].address, enrollment: reviewerEnrollments[1] },
        unavailable: "wait-for-designated-reviewers", replacement: "none", automaticVoid: false } });
    const digest = Buffer.from(await hashMarketTerms(manifest), "hex");
    const created = await buildInitializeMarketTermsInstruction({ programAddress: PROGRAM, marketId: id, seats, creator: admin,
      proposer: reviewers[0].address, approver: reviewers[1].address, version: 1, digest, manifestLength: manifest.length });
    watched.add(created.terms);
    return { ...created, digest, manifest };
  }
  async function acceptAndSeal(id: bigint, seats: Address, digest: Uint8Array) {
    for (const reviewer of reviewers) {
      await execute(`market ${id} reviewer accepts exact immutable terms`, [(await buildAcceptMarketTermsInstruction({
        programAddress: PROGRAM, marketId: id, seats, reviewer, expectedDigest: digest })).instruction]);
    }
    await execute(`market ${id} creator seals both accepted terms`, [(await buildSealMarketTermsInstruction({
      programAddress: PROGRAM, marketId: id, seats, creator: admin, expectedDigest: digest })).instruction]);
  }
  const seatsSigner = await generateKeyPairSigner();
  const market = await buildCreateMarketInstructions({ programAddress: PROGRAM, marketId: 1n, admin, seats: seatsSigner,
    seatsRentLamports: BigInt(await rpc<number>("getMinimumBalanceForRentExemption", [32_816])), payoutMilli: PAYOUT,
    feeBps: Number(FEE_BPS), closesAt, resolvesAt: closesAt });
  await execute("create real market, seats and SPL escrow vault", market.instructions);
  const [book] = await getProgramDerivedAddress({ programAddress: PROGRAM, seeds: ["order_book", keyBytes(market.market)] });
  const resolutionPlan = await buildInitializeResolutionInstruction({ programAddress: PROGRAM, marketId: 1n, creator: admin,
    seats: market.seats, proposer: reviewers[0].address, approver: reviewers[1].address });
  const resolution = resolutionPlan.resolution;
  const terms = await termsPlan(1n, market.seats, closesAt);
  for (const key of [market.market, market.seats, market.vault, book, resolution]) watched.add(key);
  const locators: Address[] = [];
  for (const [i, wallet] of actors.entries()) {
    const seat = await buildRegisterSeatInstruction({ programAddress: PROGRAM, marketId: 1n, wallet, seats: market.seats });
    await execute(`register actual wallet seat ${i}`, [seat.instruction]);
    locators.push(seat.locator); watched.add(seat.locator);
  }
  const instruction = (name: string, keys: AccountMeta[], args = Buffer.alloc(0)): Instruction => ({ programAddress: PROGRAM, accounts: keys, data: Buffer.concat([disc("global", name), args]) });
  const setup = (name: string, expectedSize?: number, authority: TransactionSigner = admin) => instruction(name,
    [signer(authority, true), ro(base.config), ro(market.market), rw(book), ro(SYSTEM_PROGRAM_ADDRESS)], expectedSize === undefined ? undefined : u32(expectedSize));
  async function shippingSetup(step: Parameters<typeof buildBookSetupInstruction>[0]["step"]) {
    const built = await buildBookSetupInstruction({ programAddress: PROGRAM, marketId: 1n, admin, step });
    assert.equal(built.book, book);
    assert.deepEqual(Buffer.from(built.instruction.data!), setup(`${step.kind}_book`, step.kind === "grow" ? step.expectedSize : undefined).data);
    return built.instruction;
  }
  const place = (owner: number, args: OrderArgs, keys?: AccountMeta[]) => instruction("place_order", keys ?? [signer(actors[owner]), ro(base.config), rw(market.market), rw(market.seats), ro(locators[owner]), ro(market.vault), rw(book), ro(resolution), ro(terms.terms)],
    Buffer.concat([u64(args.expectedNonce ?? 0n), u64(args.price), u64(args.quantity), Buffer.from([args.outcome, args.action, args.tif ?? 0, args.selfTrade ?? 0, args.postOnly ? 1 : 0]),
      args.expiresAt === undefined ? Buffer.from([0]) : Buffer.concat([Buffer.from([1]), i64(args.expiresAt)]), Buffer.from([args.touches ?? 0])]));
  await execute("wrong admin cannot create the canonical book", [setup("create_book", undefined, actors[0])], 2001);
  await execute("shipping builder creates canonical draft PDA at 10240 bytes", [await shippingSetup({ kind: "create" })]);
  assert.equal(bytes((await accounts([book]))[0]).length, STEP);
  assert.equal(bytes((await accounts([book]))[0]).subarray(0, 8).toString(), "GOOSEYI1");
  await execute("draft cannot be finalized early", [setup("finalize_book")], 7100);
  await execute("draft placement rejects uninitialized mandatory resolution account", [place(0, { price: 400n, quantity: 1n, outcome: 0, action: 0 })], 3012);
  await execute("draft resolution cannot activate without mandatory terms", [resolutionPlan.instruction], 3012);
  await execute("terms cannot initialize against an unfinished canonical book", [terms.instruction], 7602);
  await execute("wrong admin cannot grow draft", [setup("grow_book", STEP, actors[0])], 2001);
  await execute("stale growth size rejected", [setup("grow_book", STEP - 1)], 7101);
  // Agave 4.2.2 permits separate top-level growth instructions in one tx;
  // do NOT invent a per-transaction 10KiB rejection. A repeated stale size is
  // the actual program-enforced failure that must roll back prior rent/resize.
  await execute("stale second growth atomically rolls back first rent and resize", [setup("grow_book", STEP), setup("grow_book", STEP)], { index: 1, error: 7101 });
  for (let size = STEP; size < BOOK_BYTES; size = Math.min(size + STEP, BOOK_BYTES)) {
    await execute(`shipping builder grows book separately ${size} -> ${Math.min(size + STEP, BOOK_BYTES)}`, [await shippingSetup({ kind: "grow", expectedSize: size })]);
    const actual = (await accounts([book]))[0];
    assert.equal(bytes(actual).length, Math.min(size + STEP, BOOK_BYTES));
    assert.equal(bytes(actual).subarray(0, 8).toString(), "GOOSEYI1");
    assert(actual!.lamports >= await rpc<number>("getMinimumBalanceForRentExemption", [bytes(actual).length]));
  }
  await execute("wrong admin cannot finalize draft", [setup("finalize_book", undefined, actors[0])], 2001);
  await execute("shipping builder finalizes exact-size canonical order book once", [await shippingSetup({ kind: "finalize" })]);
  await execute("ready book cannot be finalized again", [setup("finalize_book")], 7100);
  await execute("ready book cannot grow or reset", [setup("grow_book", BOOK_BYTES)], 7100);
  await execute("ready book still cannot trade before resolution initialization", [place(0, { price: 400n, quantity: 1n, outcome: 0, action: 0 })], 3012);
  await execute("commit canonical test manifest before activation", [terms.instruction]);
  await execute("unsealed terms cannot activate resolution", [resolutionPlan.instruction], 7600);
  await acceptAndSeal(1n, market.seats, terms.digest);
  const conflictKeys = [...resolutionPlan.instruction.accounts]; conflictKeys[6] = conflictKeys[5];
  await execute("resolution reviewers must match the exact accepted terms roles", [{ ...resolutionPlan.instruction, accounts: conflictKeys }], 7600);
  await execute("initialize canonical Open resolution with two independent enrolled reviewers", [resolutionPlan.instruction]);
  const resolutionAccount = (await accounts([resolution]))[0];
  assert.equal(resolutionAccount?.owner, PROGRAM);
  const resolutionBytes = bytes(resolutionAccount);
  assert.deepEqual(resolutionBytes.subarray(0, 8), disc("account", "ResolutionState"));
  assert.deepEqual(resolutionBytes.subarray(8, 40), keyBytes(market.market));
  assert.deepEqual(resolutionBytes.subarray(40, 72), keyBytes(admin.address));
  for (let i = 0; i < 2; i++) {
    assert.deepEqual(resolutionBytes.subarray(96 + i * 64, 128 + i * 64), keyBytes(reviewers[i].address));
    assert.deepEqual(resolutionBytes.subarray(128 + i * 64, 160 + i * 64), keyBytes(reviewerEnrollments[i]));
  }
  assert.equal(resolutionBytes[224], 0, "Resolution phase must be Open");
  const omittedResolution = place(0, { price: 400n, quantity: 1n, outcome: 0, action: 0 });
  await execute("legacy seven-account placement cannot omit resolution admission", [{ ...omittedResolution, accounts: omittedResolution.accounts!.slice(0, 7) }], 3005);
  await execute("legacy eight-account placement cannot omit sealed terms", [{ ...omittedResolution, accounts: omittedResolution.accounts!.slice(0, 8) }], 3005);

  async function state(commitment: "confirmed" | "finalized" = "confirmed") {
    const [m, s, b, vault, mint, ...tokens] = await accounts([market.market, market.seats, book, market.vault, base.featherMint, ...walletTokens], commitment);
    for (const account of [m, s, b]) assert.equal(account?.owner, PROGRAM);
    for (const account of [vault, mint, ...tokens]) assert.equal(account?.owner, TOKEN_PROGRAM_ADDRESS);
    const md = bytes(m), sd = bytes(s), bd = bytes(b);
    assert.equal(md.length, 195); assert.equal(sd.length, 32_816); assert.equal(bd.length, BOOK_BYTES);
    assert.deepEqual(md.subarray(0, 8), disc("account", "Market")); assert.deepEqual(sd.subarray(0, 8), disc("account", "Seats"));
    assert.equal(bd.subarray(0, 8).toString(), "GOOSEYB1");
    assert.deepEqual(bd.subarray(8, 40), keyBytes(market.market)); assert.equal(bd.readBigUInt64LE(40), 1n);
    assert.equal(bd.readBigUInt64LE(48), PAYOUT); assert.equal(bd.readUInt16LE(72), CAPACITY); assert.equal(bd.readUInt16LE(82), Number(FEE_BPS));
    assert.equal(sd.readUInt32LE(40), 4); assert.deepEqual(sd.subarray(8, 40), keyBytes(market.market));
    const seats = actors.map((wallet, index) => {
      const offset = 48 + index * 128;
      assert.deepEqual(sd.subarray(offset, offset + 32), keyBytes(wallet.address));
      assert.deepEqual(sd.subarray(offset + 32, offset + 64), keyBytes(enrollments[index]));
      return { available: sd.readBigUInt64LE(offset + 64), reserved: sd.readBigUInt64LE(offset + 72),
        yes: sd.readBigUInt64LE(offset + 80), no: sd.readBigUInt64LE(offset + 88), reservedYes: sd.readBigUInt64LE(offset + 96),
        reservedNo: sd.readBigUInt64LE(offset + 104), nonce: sd.readBigUInt64LE(offset + 112), everTraded: sd[offset + 120] };
    });
    const orders = [];
    for (let index = 0; index < CAPACITY; index++) {
      const offset = 88 + index * 64, flags = bd.readUInt16LE(offset + 56);
      if (!(flags & 1)) continue;
      assert.equal(flags & ~15, 0);
      orders.push({ index, id: bd.readBigUInt64LE(offset), owner: Number(bd.readBigUInt64LE(offset + 8)), price: bd.readBigUInt64LE(offset + 16),
        remaining: bd.readBigUInt64LE(offset + 24), sequence: bd.readBigUInt64LE(offset + 32), expiresAt: flags & 8 ? bd.readBigInt64LE(offset + 40) : null,
        notional: bd.readBigUInt64LE(offset + 48), outcome: flags & 2 ? 1 : 0, action: flags & 4 ? 1 : 0 });
    }
    const token = getTokenDecoder().decode(bytes(vault)), mintData = getMintDecoder().decode(bytes(mint));
    assert.equal(token.owner, market.market); assert.equal(token.mint, base.featherMint);
    assert.equal(mintData.decimals, 3); assert.deepEqual(mintData.mintAuthority, { __option: "Some", value: base.mintAuthority });
    return { seats, orders, bd, revision: bd.readBigUInt64LE(56), nextSequence: bd.readBigUInt64LE(64),
      accounted: md.readBigUInt64LE(168), collateral: md.readBigUInt64LE(176), revenue: md.readBigUInt64LE(184),
      vault: token.amount, supply: mintData.supply, tokenAccounts: [vault, mint, ...tokens],
      walletAmounts: tokens.map((t, i) => { const data = getTokenDecoder().decode(bytes(t)); assert.equal(data.owner, actors[i].address); assert.equal(data.mint, base.featherMint); return data.amount; }) };
  }
  type State = Awaited<ReturnType<typeof state>>;
  function invariants(s: State, otherVaultAmount = 0n) {
    const reserves = s.seats.map(() => ({ cash: 0n, yes: 0n, no: 0n }));
    const active = new Set(s.orders.map(order => order.index));
    assert.equal(active.size, s.bd.readUInt16LE(78));
    assert.equal(s.bd.readUInt16LE(74) + s.bd.readUInt16LE(76), active.size);
    assert.equal(new Set(s.orders.map(order => order.id)).size, active.size);
    for (const order of s.orders) {
      assert(order.owner >= 0 && order.owner < s.seats.length && order.id === order.sequence && order.id < s.nextSequence);
      assert(order.remaining > 0n && order.price > 0n && order.price < PAYOUT);
      const reserve = reserves[order.owner];
      if (order.action === 0) { const principal = order.price * order.remaining; reserve.cash += principal + fee(order.notional + principal) - fee(order.notional); }
      else if (order.outcome === 0) reserve.yes += order.remaining;
      else reserve.no += order.remaining;
    }
    const heapSeen = new Set<number>();
    for (const [side, count, offset] of [[0, s.bd.readUInt16LE(74), 65_624], [1, s.bd.readUInt16LE(76), 67_672]]) {
      const heap = [];
      for (let i = 0; i < count; i++) {
        const index = s.bd.readUInt16LE(offset + i * 2), order = s.orders.find(o => o.index === index);
        assert(order && !heapSeen.has(index)); heapSeen.add(index);
        assert.equal((order.outcome === 0 && order.action === 0) || (order.outcome === 1 && order.action === 1) ? 0 : 1, side);
        heap.push({ price: order.outcome ? PAYOUT - order.price : order.price, sequence: order.sequence });
        if (i) {
          const parent = heap[Math.floor((i - 1) / 2)], child = heap[i];
          assert(parent.price === child.price ? parent.sequence < child.sequence : side === 0 ? parent.price > child.price : parent.price < child.price, "Heap price-time priority violated");
        }
      }
    }
    assert.deepEqual(heapSeen, active);
    const free = new Set<number>(); let next = s.bd.readUInt16LE(80);
    while (next !== 65_535) {
      assert(next < CAPACITY && !free.has(next) && !active.has(next), "Invalid/cyclic book free list");
      free.add(next); next = s.bd.readUInt16LE(88 + next * 64 + 58);
    }
    assert.equal(free.size + active.size, CAPACITY);
    let cash = 0n, yes = 0n, no = 0n;
    s.seats.forEach((seat, i) => {
      assert.deepEqual({ cash: seat.reserved, yes: seat.reservedYes, no: seat.reservedNo }, reserves[i], `Seat ${i} reserves differ from actual live orders`);
      assert(seat.yes >= seat.reservedYes && seat.no >= seat.reservedNo);
      cash += seat.available + seat.reserved; yes += seat.yes; no += seat.no;
    });
    assert.equal(yes, no); assert.equal(yes * PAYOUT, s.collateral);
    assert.equal(cash + s.collateral + s.revenue, s.accounted);
    assert.equal(s.vault, s.accounted); assert.equal(s.supply, 4n * GRANT);
    assert.equal(s.walletAmounts.reduce((sum, n) => sum + n, s.vault + otherVaultAmount), s.supply);
  }
  const runtime = { cluster: "localnet" as const, rpcUrl: endpoint.toString(), genesisHash: genesis, programAddress: PROGRAM };
  const finalizedReaders: Record<string, unknown>[] = [];
  async function verifyReaders(label: string, expected: State, minimumSlot: number) {
    const snapshots = await Promise.all(actors.map(wallet => readGooseyEscrow(runtime, { marketId: 1n, wallet: wallet.address }, { includeMarketTerms: true })));
    snapshots.forEach((snapshot, i) => {
      const seat = expected.seats[i];
      assert(snapshot.finalizedSlot >= BigInt(minimumSlot));
      assert.equal(snapshot.registered, true); assert.equal(snapshot.wallet, actors[i].address);
      assert.equal(snapshot.market, market.market); assert.equal(snapshot.seats, market.seats);
      assert.equal(snapshot.locator, locators[i]); assert.equal(snapshot.vault, market.vault);
      assert.deepEqual(snapshot.seat, { index: i, availableCash: seat.available, reservedCash: seat.reserved,
        yes: seat.yes, no: seat.no, reservedYes: seat.reservedYes, reservedNo: seat.reservedNo,
        nextNonce: seat.nonce, everTraded: seat.everTraded === 1 });
      assert.equal(snapshot.marketState.accountedVault, expected.accounted);
      assert.equal(snapshot.marketState.collateral, expected.collateral);
      assert.equal(snapshot.marketState.feeRevenue, expected.revenue);
      assert.equal(snapshot.marketState.payoutMilli, PAYOUT); assert.equal(snapshot.marketState.feeBps, Number(FEE_BPS));
      assert.equal(snapshot.vaultAmount, expected.vault); assert.equal(snapshot.vaultSurplus, 0n);
      assert.equal(snapshot.walletTokenAmount, expected.walletAmounts[i]);
      // Reader reconciles the same-batch book and escrow, not the complete exchange lifecycle.
      assert.equal(snapshot.exchangeVerified, false);
      assert(snapshot.resolution);
      assert.equal(snapshot.resolution.address, resolution);
      assert.equal(snapshot.resolution.phase, 0);
      assert.equal(snapshot.resolution.market, market.market);
      assert.equal(snapshot.resolution.proposer.wallet, reviewers[0].address);
      assert.equal(snapshot.resolution.approver.wallet, reviewers[1].address);
      assert(snapshot.marketTerms?.sealed);
      assert.equal(snapshot.marketTerms.address, terms.terms);
      assert.deepEqual(Buffer.from(snapshot.marketTerms.digest), terms.digest);
      assert.equal(snapshot.marketTerms.manifestLength, terms.manifest.length);
      assert(snapshot.orderBook);
      assert.equal(snapshot.orderBook.book, book);
      assert.equal(snapshot.orderBook.revision, expected.revision);
      assert.equal(snapshot.orderBook.nextSequence, expected.nextSequence);
      assert.equal(snapshot.orderBook.reservesReconciled, true);
      assert.equal(snapshot.orderBook.orders.length, expected.orders.length);
      for (const actual of snapshot.orderBook.orders) {
        const raw = expected.orders.find(order => order.id === actual.id);
        assert(raw);
        assert.equal(actual.ownerSeat, raw.owner);
        assert.equal(actual.remaining, raw.remaining);
        assert.equal(actual.limitPrice, raw.price);
        assert.equal(actual.sequence, raw.sequence);
        assert.equal(actual.expiresAt, raw.expiresAt);
      }
    });
    finalizedReaders.push({ label, minimumSlot, wallets: snapshots.map(snapshot => ({ wallet: snapshot.wallet,
      finalizedSlot: snapshot.finalizedSlot, seat: snapshot.seat, walletTokenAmount: snapshot.walletTokenAmount,
      vaultAmount: snapshot.vaultAmount, collateral: snapshot.marketState.collateral, fees: snapshot.marketState.feeRevenue })) });
    console.log(`PASS finalized shipping escrow reader: ${label}, all four actual participants`);
  }
  invariants(await state());
  const depositReceipts: Awaited<ReturnType<typeof execute>>[] = [];
  for (const [i, wallet] of actors.entries()) {
    const deposit = await buildDepositInstruction({ programAddress: PROGRAM, marketId: 1n, wallet, seats: market.seats, amount: GRANT, expectedNonce: 0n });
    depositReceipts.push(await execute(`wallet ${i} deposits only actual claimed SPL balance`, [deposit.instruction])); invariants(await state());
  }
  function events(logs: string[]) {
    const orders: OrderEvent[] = [], trades: TradeEvent[] = [], removed: RemovalEvent[] = [];
    for (const line of logs) {
      if (!line.startsWith("Program data: ")) continue;
      const data = Buffer.from(line.slice(14), "base64");
      if (data.subarray(0, 8).equals(disc("event", "OrderExecuted"))) {
        assert.equal(data.length, 123); assert.deepEqual(data.subarray(8, 40), keyBytes(market.market));
        orders.push({ orderId: data.readBigUInt64LE(72), nonce: data.readBigUInt64LE(80), filled: data.readBigUInt64LE(88), canceled: data.readBigUInt64LE(96), rested: data.readBigUInt64LE(104), disposition: data[112] });
      } else if (data.subarray(0, 8).equals(disc("event", "TradeExecuted"))) {
        assert.equal(data.length, 108); assert.deepEqual(data.subarray(8, 40), keyBytes(market.market));
        trades.push({ makerOrderId: data.readBigUInt64LE(40), takerOrderId: data.readBigUInt64LE(48), makerSeat: data.readBigUInt64LE(56), takerSeat: data.readBigUInt64LE(64),
          quantity: data.readBigUInt64LE(72), yesPrice: data.readBigUInt64LE(80), makerFee: data.readBigUInt64LE(88), takerFee: data.readBigUInt64LE(96),
          makerOutcome: data[104], makerAction: data[105], takerOutcome: data[106], takerAction: data[107] });
      } else if (data.subarray(0, 8).equals(disc("event", "RestingOrderRemoved"))) {
        assert.equal(data.length, 65); removed.push({ orderId: data.readBigUInt64LE(40), seat: data.readBigUInt64LE(48), remaining: data.readBigUInt64LE(56), reason: data[64] });
      }
    }
    return { orders, trades, removed };
  }
  async function order(name: string, owner: number, args: OrderArgs, expectation?: { error?: number; filled?: bigint; canceled?: bigint; rested?: bigint; disposition?: number }) {
    const before = await state();
    const command = { ...args, expectedNonce: args.expectedNonce ?? before.seats[owner].nonce };
    let placement = place(owner, command);
    if (expectation?.error === undefined) {
      const built = await buildPlaceOrderInstruction({ programAddress: PROGRAM, marketId: 1n, wallet: actors[owner], seats: market.seats,
        expectedNonce: command.expectedNonce, price: args.price, quantity: args.quantity,
        outcome: args.outcome === 0 ? "YES" : "NO", action: args.action === 0 ? "BUY" : "SELL",
        timeInForce: (["GTC", "IOC", "FOK"] as const)[args.tif ?? 0],
        selfTrade: (["CANCEL_AGGRESSOR", "CANCEL_RESTING", "CANCEL_BOTH"] as const)[args.selfTrade ?? 0],
        postOnly: args.postOnly, expiresAt: args.expiresAt, touches: args.touches });
      assert.deepEqual(Buffer.from(built.instruction.data!), placement.data);
      assert.deepEqual(built.instruction.accounts!.map(a => [a.address, a.role]), placement.accounts!.map(a => [a.address, a.role]));
      placement = built.instruction;
    }
    const result = await execute(name, [placement], expectation?.error);
    const after = await state(); invariants(after);
    if (expectation?.error !== undefined) return { ...result, before, after, events: events(result.logs), command };
    assert.equal(after.revision, before.revision + 1n); assert.equal(after.nextSequence, before.nextSequence + 1n);
    for (let i = 0; i < actors.length; i++) assert.equal(after.seats[i].nonce, before.seats[i].nonce + (i === owner ? 1n : 0n));
    assert.deepEqual(after.tokenAccounts, before.tokenAccounts, "Matching must not mint feathers or move SPL vault/wallet tokens");
    const decoded = events(result.logs); assert.equal(decoded.orders.length, 1);
    const event = decoded.orders[0]; assert.equal(event.orderId, before.nextSequence); assert.equal(event.nonce, command.expectedNonce);
    assert.equal(event.filled + event.canceled + event.rested, args.quantity);
    for (const field of ["filled", "canceled", "rested", "disposition"] as const) if (expectation?.[field] !== undefined) assert.equal(event[field], expectation[field], `${name}: ${field}`);
    assert.equal(decoded.trades.reduce((sum, fill) => sum + fill.quantity, 0n), event.filled);
    assert.equal(after.revenue - before.revenue, decoded.trades.reduce((sum, fill) => sum + fill.makerFee + fill.takerFee, 0n));
    const deltas = actors.map(() => ({ cash: 0n, yes: 0n, no: 0n }));
    let takerNotional = 0n, collateralDelta = 0n;
    for (const trade of decoded.trades) {
      assert.equal(trade.takerOrderId, event.orderId); assert.equal(trade.takerSeat, BigInt(owner));
      assert.equal(trade.takerOutcome, args.outcome); assert.equal(trade.takerAction, args.action);
      const maker = before.orders.find(o => o.id === trade.makerOrderId);
      assert(maker, "Fill references no actual preexisting maker");
      assert.equal(trade.makerSeat, BigInt(maker.owner)); assert.notEqual(maker.owner, owner);
      assert.equal(trade.makerAction, maker.action); assert.equal(trade.makerOutcome, maker.outcome);
      assert.equal(trade.yesPrice, maker.outcome === 0 ? maker.price : PAYOUT - maker.price);
      const makerPrincipal = (maker.outcome === 0 ? trade.yesPrice : PAYOUT - trade.yesPrice) * trade.quantity;
      const takerPrincipal = (args.outcome === 0 ? trade.yesPrice : PAYOUT - trade.yesPrice) * trade.quantity;
      assert.equal(trade.makerFee, fee(maker.notional + makerPrincipal) - fee(maker.notional));
      assert.equal(trade.takerFee, fee(takerNotional + takerPrincipal) - fee(takerNotional));
      takerNotional += takerPrincipal;
      for (const [seat, outcome, action, principal, charge] of [
        [maker.owner, maker.outcome, maker.action, makerPrincipal, trade.makerFee],
        [owner, args.outcome, args.action, takerPrincipal, trade.takerFee],
      ] as const) {
        const delta = deltas[seat];
        delta.cash += (action === 0 ? -principal : principal) - charge;
        delta[outcome === 0 ? "yes" : "no"] += action === 0 ? trade.quantity : -trade.quantity;
        assert.equal(after.seats[seat].everTraded, 1);
      }
      if (maker.action === args.action) collateralDelta += (args.action === 0 ? 1n : -1n) * PAYOUT * trade.quantity;
    }
    assert.equal(after.collateral - before.collateral, collateralDelta);
    deltas.forEach((delta, i) => {
      assert.equal(after.seats[i].available + after.seats[i].reserved - before.seats[i].available - before.seats[i].reserved, delta.cash);
      assert.equal(after.seats[i].yes - before.seats[i].yes, delta.yes);
      assert.equal(after.seats[i].no - before.seats[i].no, delta.no);
    });
    return { ...result, before, after, events: decoded, command };
  }
  const buyYes = (price: bigint, quantity: bigint, tif = 0): OrderArgs => ({ price, quantity, tif, outcome: 0, action: 0 });
  const buyNo = (price: bigint, quantity: bigint, tif = 0): OrderArgs => ({ price, quantity, tif, outcome: 1, action: 0 });
  const sellYes = (price: bigint, quantity: bigint, tif = 0): OrderArgs => ({ price, quantity, tif, outcome: 0, action: 1 });
  const sellNo = (price: bigint, quantity: bigint, tif = 0): OrderArgs => ({ price, quantity, tif, outcome: 1, action: 1 });
  const fill = { filled: 10n, canceled: 0n, rested: 0n, disposition: 0 };
  await order("rest YES buy with exact principal plus fee reserve", 0, buyYes(400n, 10n), { rested: 10n, disposition: 1 });
  let current = await state(); assert.equal(current.seats[0].reserved, 4_040n); assert.equal(current.collateral, 0n);
  const mintFill = await order("MINT: complementary real buys create backed YES/NO positions", 1, buyNo(600n, 10n, 2), fill);
  assert.equal(mintFill.after.collateral, 10_000n); assert.equal(mintFill.after.revenue, 100n);
  assert.deepEqual(mintFill.after.seats.map(s => [s.available, s.yes, s.no]), [[995_960n, 10n, 0n], [993_940n, 0n, 10n], [GRANT, 0n, 0n], [GRANT, 0n, 0n]]);
  await order("reserve only minted YES for a resting sale", 0, sellYes(450n, 4n), { rested: 4n });
  const yesFill = await order("TRANSFER YES: buyer receives existing minted position at maker price", 2, buyYes(500n, 4n, 2), { ...fill, filled: 4n });
  assert.equal(yesFill.after.collateral, 10_000n); assert.equal(yesFill.after.revenue, 136n);
  assert.deepEqual(yesFill.after.seats.map(s => [s.available, s.yes, s.no]), [[997_742n, 6n, 0n], [993_940n, 0n, 10n], [998_182n, 4n, 0n], [GRANT, 0n, 0n]]);
  await order("reserve only minted NO for a resting sale", 1, sellNo(550n, 3n), { rested: 3n });
  const noFill = await order("TRANSFER NO: normalized bid executes at maker NO price", 3, buyNo(600n, 3n, 2), { ...fill, filled: 3n });
  assert.equal(noFill.after.collateral, 10_000n); assert.equal(noFill.after.revenue, 170n);
  assert.equal(noFill.after.seats[1].available, 995_573n); assert.equal(noFill.after.seats[3].available, 998_333n);
  assert.equal(noFill.after.seats[1].no, 7n); assert.equal(noFill.after.seats[3].no, 3n);
  await order("rest sale of transferred YES positions", 2, sellYes(500n, 2n), { rested: 2n });
  const burnFill = await order("BURN: complementary minted positions release exact pair collateral", 3, sellNo(500n, 2n, 2), { ...fill, filled: 2n });
  assert.equal(burnFill.after.collateral, 8_000n); assert.equal(burnFill.after.revenue, 190n);
  assert.equal(burnFill.after.seats[2].available, 999_172n); assert.equal(burnFill.after.seats[3].available, 999_323n);
  assert.equal(burnFill.after.seats[2].yes, 2n); assert.equal(burnFill.after.seats[3].no, 1n);

  await order("maker fee-chain rounding setup", 0, buyYes(333n, 3n), { rested: 3n });
  for (const [i, makerFee] of [4n, 3n, 3n].entries()) {
    const partial = await order(`maker fee telescopes across real partial fill ${i + 1}`, 1, buyNo(667n, 1n, 1), { ...fill, filled: 1n });
    assert.equal(partial.events.trades[0].makerFee, makerFee); assert.equal(partial.events.trades[0].takerFee, 7n);
  }
  await order("rest position sale for partial/FOK/IOC cases", 0, sellYes(700n, 3n), { rested: 3n });
  const partial = await order("partial IOC releases unused cash reserve", 2, buyYes(750n, 1n, 1), { ...fill, filled: 1n });
  assert.equal(partial.after.seats[0].reservedYes, 2n);
  assert.equal(partial.before.seats[2].available - partial.after.seats[2].available, 707n);
  const failedFok = await order("atomic FOK cannot consume available partial liquidity", 2, buyYes(700n, 3n, 2), { error: 7011 });
  const partialIoc = await order("partial IOC cancels remainder without leaving a reserve", 3, buyYes(700n, 5n, 1), { filled: 2n, canceled: 3n, rested: 0n, disposition: 4 });
  assert.equal(partialIoc.before.seats[3].available - partialIoc.after.seats[3].available, 1_414n);
  await order("empty IOC advances nonce but creates no order or fee", 3, buyYes(100n, 1n, 1), { filled: 0n, canceled: 1n, rested: 0n, disposition: 3 });
  await order("partial GTC maker setup", 0, sellYes(700n, 1n), { rested: 1n });
  const partialGtc = await order("partial GTC rests exact remaining telescoping reserve", 2, buyYes(710n, 3n), { filled: 1n, canceled: 0n, rested: 2n, disposition: 2 });
  assert.equal(partialGtc.after.seats[2].reserved, 1_435n);
  const liveRoot = await finalized(partialGtc.signature, partialGtc.receipt.slot);
  const liveFinalized = await state("finalized"); invariants(liveFinalized);
  assert.equal(liveFinalized.seats[2].reserved, 1_435n);
  assert(liveFinalized.collateral > 0n && liveFinalized.revenue > 0n);
  await verifyReaders("live cash reserves, minted positions and accrued fees", liveFinalized, liveRoot);
  const cancelResting = await order("self-trade cancel-resting releases maker cash then rests incoming", 2, { ...sellYes(700n, 1n), selfTrade: 1 }, { filled: 0n, rested: 1n });
  assert.equal(cancelResting.events.removed[0].reason, 1); assert.equal(cancelResting.after.seats[2].reserved, 0n);
  await order("self-trade cancel-both releases both reserves", 2, { ...buyYes(700n, 1n, 1), selfTrade: 2 }, { filled: 0n, canceled: 1n, rested: 0n, disposition: 5 });
  await order("self-trade cancel-aggressor maker setup", 0, sellYes(700n, 1n), { rested: 1n });
  const stp = await order("self-trade cancel-aggressor leaves maker untouched", 0, buyYes(700n, 1n, 1), { filled: 0n, canceled: 1n, disposition: 5 });
  assert.deepEqual(stp.after.orders, stp.before.orders); assert.equal(stp.after.revenue, stp.before.revenue);
  await order("clean self-trade order using cancel-both", 0, { ...buyYes(700n, 1n, 1), selfTrade: 2 }, { canceled: 1n, disposition: 5 });
  await order("noncrossing post-only order rests", 0, { ...buyYes(100n, 1n), postOnly: true }, { rested: 1n });
  await order("crossing post-only is an atomic rejection", 3, { ...sellYes(100n, 1n), postOnly: true }, { error: 7012 });
  await order("execute the post-only maker with an authorized existing position", 3, sellYes(100n, 1n, 2), { ...fill, filled: 1n });

  for (const [label, args, code] of [
    ["invalid outcome", { ...buyYes(100n, 1n), outcome: 2 }, 7013],
    ["invalid action", { ...buyYes(100n, 1n), action: 2 }, 7013],
    ["invalid time in force", { ...buyYes(100n, 1n), tif: 3 }, 7013],
    ["invalid self-trade mode", { ...buyYes(100n, 1n), selfTrade: 3 }, 7013],
    ["invalid touch budget", { ...buyYes(100n, 1n), touches: 17 }, 7014],
    ["zero quantity", buyYes(100n, 0n), 7014], ["quantity above bound", buyYes(1n, 10_000_001n), 7014],
    ["zero price", buyYes(0n, 1n), 7014], ["price at payout", buyYes(PAYOUT, 1n), 7014],
    ["post-only IOC", { ...buyYes(100n, 1n, 1), postOnly: true }, 7014],
    ["expired incoming", { ...buyYes(100n, 1n), expiresAt: (await time()) - 1n }, 7014],
    ["insufficient cash", buyYes(100n, 100_000n), 7005],
    ["unowned position sale", sellYes(100n, 10_000n), 7006],
  ] as [string, OrderArgs, number][]) await order(`${label} rejects without mutation`, 0, args, { error: code });
  current = await state();
  await order("stale placement nonce rejects without mutation", 0, { ...buyYes(100n, 1n), expectedNonce: current.seats[0].nonce - 1n }, { error: 7003 });
  const wrongLocatorKeys = [signer(actors[0]), ro(base.config), rw(market.market), rw(market.seats), ro(locators[1]), ro(market.vault), rw(book), ro(resolution), ro(terms.terms)];
  await execute("another wallet locator cannot authorize a placement", [place(0, { ...buyYes(100n, 1n), expectedNonce: current.seats[0].nonce }, wrongLocatorKeys)], 2006);
  const wrongBookKeys = [signer(actors[0]), ro(base.config), rw(market.market), rw(market.seats), ro(locators[0]), ro(market.vault), rw(base.config), ro(resolution), ro(terms.terms)];
  await execute("noncanonical program-owned book rejected", [place(0, { ...buyYes(100n, 1n), expectedNonce: current.seats[0].nonce }, wrongBookKeys)], 2006);

  current = await state();
  await execute("later FOK failure atomically rolls back earlier successful placement", [
    place(0, { ...buyYes(300n, 1n), expectedNonce: current.seats[0].nonce }),
    place(1, { ...buyNo(700n, 2n, 2), expectedNonce: current.seats[1].nonce }),
  ], { index: 1, error: 7011 });
  invariants(await state());
  const expiry = (await time()) + 4n;
  await order("rest real expiring order", 0, { ...buyYes(200n, 1n), expiresAt: expiry }, { rested: 1n });
  await until(expiry);
  await order("FOK rejection rolls back tentative expired-maker cleanup", 1, buyNo(800n, 1n, 2), { error: 7011 });
  const expired = await order("IOC removes expired maker and refunds reserve even without crossing", 1, buyNo(100n, 1n, 1), { filled: 0n, canceled: 1n, rested: 0n });
  assert.equal(expired.events.removed[0].reason, 0); assert.equal(expired.after.seats[0].available - expired.before.seats[0].available, 202n);
  for (let i = 0; i < 9; i++) await order(`bounded work maker ${i + 1}`, 0, buyYes(100n, 1n), { rested: 1n });
  await order("default eight touches rejects nine-maker FOK atomically", 1, buyNo(900n, 9n, 2), { error: 7014 });
  const bounded = await order("explicit sixteen touches fills nine real makers", 1, { ...buyNo(900n, 9n, 2), touches: 16 }, { ...fill, filled: 9n });
  assert.equal(bounded.events.trades.length, 9);
  assert.equal(bounded.after.collateral - bounded.before.collateral, 9_000n);
  for (let i = 0; i < 2; i++) await order(`IOC work-bound maker ${i + 1}`, 1, buyNo(500n, 1n), { rested: 1n });
  await order("IOC touch limit commits one fill and cancels unmatched quantity", 0, { ...buyYes(500n, 2n, 1), touches: 1 }, { filled: 1n, canceled: 1n, rested: 0n, disposition: 4 });
  await order("remaining bounded-work maker is still executable", 0, buyYes(500n, 1n, 2), { ...fill, filled: 1n });
  const first = await order("FIFO first same-price maker", 0, buyYes(400n, 1n), { rested: 1n });
  const second = await order("FIFO second same-price maker", 2, buyYes(400n, 1n), { rested: 1n });
  const fifo = await order("actual persistent heap honors FIFO at equal price", 1, buyNo(600n, 2n, 2), { ...fill, filled: 2n });
  assert.deepEqual(fifo.events.trades.map(t => t.makerOrderId), [first.events.orders[0].orderId, second.events.orders[0].orderId]);
  const worse = await order("older lower-price bid", 0, buyYes(300n, 1n), { rested: 1n });
  const better = await order("newer better-price bid", 2, buyYes(400n, 1n), { rested: 1n });
  const priority = await order("price beats age in actual persistent heap", 1, buyNo(700n, 2n, 2), { ...fill, filled: 2n });
  assert.deepEqual(priority.events.trades.map(t => t.makerOrderId), [better.events.orders[0].orderId, worse.events.orders[0].orderId]);
  const replaySnapshot = await accounts([...watched, admin.address]);
  await priority.send(); await delay(500);
  assert.deepEqual(await accounts([...watched, admin.address]), replaySnapshot, "Exact signed transaction replay charged again or delivered twice");
  console.log(`PASS identical signed transaction replay is not a second trade: ${priority.signature}`);
  await order("fresh signature with consumed successful nonce cannot trade twice", 1, priority.command, { error: 7003 });
  await order("reserve cash before withdrawal restriction", 0, buyYes(100n, 1n), { rested: 1n });
  current = await state();
  const excessive = await buildWithdrawInstruction({ programAddress: PROGRAM, marketId: 1n, wallet: actors[0], seats: market.seats,
    amount: current.seats[0].available + 1n, expectedNonce: current.seats[0].nonce });
  await execute("reserved trading cash cannot be withdrawn", [excessive.instruction], 6012);
  await order("release final cash reservation through self-trade prevention", 0, { ...sellYes(100n, 1n, 1), selfTrade: 2 }, { canceled: 1n, rested: 0n });
  current = await state();
  const withdrawalAmount = current.seats[0].available;
  const withdrawal = await buildWithdrawInstruction({ programAddress: PROGRAM, marketId: 1n, wallet: actors[0], seats: market.seats,
    amount: withdrawalAmount, expectedNonce: current.seats[0].nonce });
  const finalWithdrawal = await execute("withdraw real unreserved cash while minted positions remain collateralized", [withdrawal.instruction]);
  const final = await state(); invariants(final); assert.equal(final.orders.length, 0); assert.equal(final.seats[0].available, 0n);
  // Preserve the original behavioral cases, not a frozen count that excludes
  // mandatory resolution setup and its new account-admission rejections.
  const primaryRoot = await finalized(finalWithdrawal.signature, finalWithdrawal.receipt.slot);
  const primaryFinalized = await state("finalized"); invariants(primaryFinalized);
  await verifyReaders("post-trade withdrawal with positions and fees still backed", primaryFinalized, primaryRoot);

  // Separate short-lived market. Fund only from the real primary withdrawal;
  // no new grants, account rewrites, clock warps, or synthetic positions.
  const shortId = 2n, shortClose = (await time()) + 30n;
  const shortSeats = await generateKeyPairSigner();
  const shortMarket = await buildCreateMarketInstructions({ programAddress: PROGRAM, marketId: shortId, admin, seats: shortSeats,
    seatsRentLamports: BigInt(await rpc<number>("getMinimumBalanceForRentExemption", [32_816])), payoutMilli: PAYOUT,
    feeBps: Number(FEE_BPS), closesAt: shortClose, resolvesAt: shortClose });
  const shortSetup = (step: Parameters<typeof buildBookSetupInstruction>[0]["step"]) => buildBookSetupInstruction({ programAddress: PROGRAM, marketId: shortId, admin, step });
  const shortBook = (await shortSetup({ kind: "create" })).book;
  for (const key of [shortMarket.market, shortMarket.seats, shortMarket.vault, shortBook]) watched.add(key);
  await execute("close-boundary market is created with actual future Clock deadline", shortMarket.instructions);
  await execute("close-boundary canonical draft is created", [(await shortSetup({ kind: "create" })).instruction]);
  for (let size = STEP; size < BOOK_BYTES; size = Math.min(size + STEP, BOOK_BYTES)) {
    await execute(`close-boundary book separate growth ${size}`, [(await shortSetup({ kind: "grow", expectedSize: size })).instruction]);
    assert.equal(bytes((await accounts([shortBook]))[0]).length, Math.min(size + STEP, BOOK_BYTES));
  }
  await execute("close-boundary book is finalized before close", [(await shortSetup({ kind: "finalize" })).instruction]);
  const shortTerms = await termsPlan(shortId, shortMarket.seats, shortClose);
  await execute("commit close-boundary test terms", [shortTerms.instruction]);
  await acceptAndSeal(shortId, shortMarket.seats, shortTerms.digest);
  const shortResolution = await buildInitializeResolutionInstruction({ programAddress: PROGRAM, marketId: shortId, creator: admin,
    seats: shortMarket.seats, proposer: reviewers[0].address, approver: reviewers[1].address });
  watched.add(shortResolution.resolution);
  await execute("close-boundary resolution freezes independent reviewers before trading", [shortResolution.instruction]);
  for (let i = 0; i < 2; i++) {
    const registered = await buildRegisterSeatInstruction({ programAddress: PROGRAM, marketId: shortId, wallet: actors[i], seats: shortMarket.seats });
    watched.add(registered.locator);
    await execute(`close-boundary register already-enrolled wallet ${i}`, [registered.instruction]);
  }
  const funding = await buildFeatherTransfer({ mint: base.featherMint, sender: actors[0], recipient: actors[1].address, payer: admin, amount: 2_000n });
  await execute("close-boundary funding transfers actual previously withdrawn feathers", funding.instructions);
  for (let i = 0; i < 2; i++) {
    const deposited = await buildDepositInstruction({ programAddress: PROGRAM, marketId: shortId, wallet: actors[i], seats: shortMarket.seats, amount: 2_000n, expectedNonce: 0n });
    await execute(`close-boundary deposit real balance for wallet ${i}`, [deposited.instruction]);
  }
  const shortOrder = (owner: number, expectedNonce: bigint, outcome: "YES" | "NO", price: bigint, timeInForce: "GTC" | "IOC" | "FOK") =>
    buildPlaceOrderInstruction({ programAddress: PROGRAM, marketId: shortId, wallet: actors[owner], seats: shortMarket.seats,
      expectedNonce, price, quantity: 1n, outcome, action: "BUY", timeInForce, selfTrade: "CANCEL_AGGRESSOR" });
  assert(await time() < shortClose, "Setup missed the market deadline; do not weaken the close test or forge Clock");
  await execute("close-boundary real complementary maker rests while open", [(await shortOrder(0, 1n, "YES", 400n, "GTC")).instruction]);
  const openFill = await execute("close-boundary real complementary fill succeeds while open", [(await shortOrder(1, 1n, "NO", 600n, "FOK")).instruction]);
  await execute("close-boundary reserves remain real while market approaches close", [(await shortOrder(0, 2n, "YES", 100n, "GTC")).instruction]);
  const openClock = await time(); assert(openClock < shortClose, "Expected successful trades strictly before the real close");
  const openBlockTime = await rpc<number | null>("getBlockTime", [openFill.receipt.slot]);
  assert(openBlockTime !== null && BigInt(openBlockTime) < shortClose);
  const shortBeforeClose = await accounts([shortMarket.market, shortMarket.seats, shortBook, shortMarket.vault]);
  assert.equal(bytes(shortBeforeClose[0]).readBigUInt64LE(176), 1_000n);
  assert.equal(bytes(shortBeforeClose[0]).readBigUInt64LE(184), 10n);
  assert.equal(bytes(shortBeforeClose[1]).readBigUInt64LE(48 + 72), 101n);
  await until(shortClose);
  const closedClock = await time(); assert(closedClock >= shortClose);
  const rejected = await execute("real Clock at/after close rejects an otherwise fillable FOK", [(await shortOrder(1, 2n, "NO", 900n, "FOK")).instruction], 7002);
  const closedBlockTime = await rpc<number | null>("getBlockTime", [rejected.receipt.slot]);
  assert(closedBlockTime !== null && BigInt(closedBlockTime) >= shortClose);
  await execute("real Clock at/after close rejects a new GTC placement", [(await shortOrder(1, 2n, "NO", 900n, "GTC")).instruction], 7002);
  await execute("real Clock at/after close rejects an IOC placement", [(await shortOrder(1, 2n, "NO", 900n, "IOC")).instruction], 7002);
  await execute("book finalization checks actual close before readiness", [(await shortSetup({ kind: "finalize" })).instruction], 7102);
  const oneUnitWithdrawal = await buildWithdrawInstruction({ programAddress: PROGRAM, marketId: shortId, wallet: actors[1], seats: shortMarket.seats, amount: 1n, expectedNonce: 2n });
  await execute("closed second instruction rolls back preceding real withdrawal CPI and nonce", [oneUnitWithdrawal.instruction,
    (await shortOrder(1, 3n, "NO", 900n, "FOK")).instruction], { index: 1, error: 7002 });
  assert.deepEqual(await accounts([shortMarket.market, shortMarket.seats, shortBook, shortMarket.vault]), shortBeforeClose);
  const withdrawAfterClose = await buildWithdrawInstruction({ programAddress: PROGRAM, marketId: shortId, wallet: actors[0], seats: shortMarket.seats, amount: 1_495n, expectedNonce: 3n });
  const closedWithdrawal = await execute("close blocks new trades but permits withdrawal of genuinely unreserved cash", [withdrawAfterClose.instruction]);
  const closedRoot = await finalized(closedWithdrawal.signature, closedWithdrawal.receipt.slot);
  const closedReads = await Promise.all(actors.slice(0, 2).map(wallet => readGooseyEscrow(runtime, { marketId: shortId, wallet: wallet.address }, { includeMarketTerms: true })));
  const shortFinalAccounts = await accounts([shortMarket.market, shortMarket.seats, shortBook, shortMarket.vault], "finalized");
  const shortVaultAmount = getTokenDecoder().decode(bytes(shortFinalAccounts[3])).amount;
  assert.equal(shortVaultAmount, 2_505n); assert.deepEqual(shortFinalAccounts[2], shortBeforeClose[2]);
  closedReads.forEach((snapshot, i) => {
    assert(snapshot.finalizedSlot >= BigInt(closedRoot)); assert.equal(snapshot.registered, true);
    assert.equal(snapshot.marketState.closesAt, shortClose);
    assert.equal(snapshot.marketState.accountedVault, shortVaultAmount); assert.equal(snapshot.vaultAmount, shortVaultAmount);
    assert.equal(snapshot.marketState.collateral, 1_000n); assert.equal(snapshot.marketState.feeRevenue, 10n);
    assert.equal(snapshot.vaultSurplus, 0n); assert.equal(snapshot.exchangeVerified, false);
    assert(snapshot.resolution);
    assert.equal(snapshot.resolution.address, shortResolution.resolution);
    // Passing Clock close alone blocks admission; it does not execute close_resolution.
    assert.equal(snapshot.resolution.phase, 0);
    assert.equal(snapshot.resolution.closesAt, shortClose);
    assert.equal(snapshot.resolution.proposer.wallet, reviewers[0].address);
    assert.equal(snapshot.resolution.approver.wallet, reviewers[1].address);
    assert(snapshot.marketTerms?.sealed);
    assert.equal(snapshot.marketTerms.address, shortTerms.terms);
    assert.deepEqual(Buffer.from(snapshot.marketTerms.digest), shortTerms.digest);
    assert(snapshot.orderBook);
    assert.equal(snapshot.orderBook.book, shortBook);
    assert.equal(snapshot.orderBook.reservesReconciled, true);
    assert.equal(snapshot.orderBook.revision, bytes(shortFinalAccounts[2]).readBigUInt64LE(56));
    assert.equal(snapshot.orderBook.orders.length, 1);
    assert.equal(snapshot.orderBook.orders[0].ownerSeat, 0);
    assert.equal(snapshot.orderBook.orders[0].remaining, 1n);
    assert.equal(snapshot.orderBook.orders[0].limitPrice, 100n);
    assert.deepEqual(snapshot.orderBook.orders[0].reserve, { cash: 101n, yes: 0n, no: 0n });
    assert.deepEqual(snapshot.seat, { index: i, availableCash: i === 0 ? 0n : 1_394n, reservedCash: i === 0 ? 101n : 0n,
      yes: i === 0 ? 1n : 0n, no: i === 0 ? 0n : 1n, reservedYes: 0n, reservedNo: 0n, nextNonce: i === 0 ? 4n : 2n, everTraded: true });
    const rawSeat = bytes(shortFinalAccounts[1]), offset = 48 + 128 * i;
    assert.equal(snapshot.seat!.availableCash, rawSeat.readBigUInt64LE(offset + 64));
    assert.equal(snapshot.seat!.reservedCash, rawSeat.readBigUInt64LE(offset + 72));
    assert.equal(snapshot.seat!.yes, rawSeat.readBigUInt64LE(offset + 80));
    assert.equal(snapshot.seat!.no, rawSeat.readBigUInt64LE(offset + 88));
    assert.equal(snapshot.seat!.nextNonce, rawSeat.readBigUInt64LE(offset + 112));
  });
  const primaryAfterBoundary = await state("finalized"); invariants(primaryAfterBoundary, shortVaultAmount);
  assert.deepEqual(primaryAfterBoundary.seats, final.seats); assert.equal(primaryAfterBoundary.collateral, final.collateral);
  assert.equal(primaryAfterBoundary.revenue, final.revenue); assert.deepEqual(primaryAfterBoundary.bd, final.bd);
  await verifyReaders("all primary participants after real cross-market funding and close", primaryAfterBoundary, closedRoot);
  console.log("PASS finalized shipping reader accepts both closed-market seats, positions, reserves and fees");
  // Shipping unsigned preparation -> real sole-wallet signature -> shipping send.
  // Place an actual position-backed maker; the prepared wallet takes that order.
  const makerBefore = await state("finalized");
  const preparedMaker = await buildPlaceOrderInstruction({ programAddress: PROGRAM, marketId: 1n, wallet: actors[0], seats: market.seats,
    expectedNonce: makerBefore.seats[0].nonce, price: 400n, quantity: 1n, outcome: "YES", action: "SELL", timeInForce: "GTC", selfTrade: "CANCEL_AGGRESSOR" });
  const makerReceipt = await execute("prepared-wallet path rests a real owned YES maker", [preparedMaker.instruction]);
  await finalized(makerReceipt.signature, makerReceipt.receipt.slot);
  const preparedBefore = await state("finalized"); invariants(preparedBefore, shortVaultAmount);
  assert.equal(preparedBefore.orders.length, 1);
  const prepared = await prepareOrder({ runtime, sender: actors[2], marketId: 1n, price: 400n, quantity: 1n,
    outcome: "YES", action: "BUY", timeInForce: "FOK", selfTrade: "CANCEL_AGGRESSOR" });
  assert.equal(prepared.sender, actors[2].address); assert.equal(prepared.market, market.market);
  assert.equal(prepared.book, book); assert.equal(prepared.seats, market.seats);
  assert.equal(prepared.expectedNonce, preparedBefore.seats[2].nonce);
  assert.equal(prepared.bookRevision, preparedBefore.revision);
  assert.equal(prepared.requiredCash, 404n);
  assert(prepared.observedSlot >= BigInt(makerReceipt.receipt.slot));
  const signedOrder = await signTransactionMessageWithSigners(prepared.message);
  assert.deepEqual(Object.keys(signedOrder.signatures), [actors[2].address]);
  const preparedSignature = getSignatureFromTransaction(signedOrder);
  const preparedWire = getBase64EncodedWireTransaction(signedOrder);
  const solBefore = await accounts([actors[2].address, admin.address]);
  const savedReceipts: Omit<TransferSubmission, "status">[] = [];
  const submittedOrder = await submitSignedWalletTransaction({ runtime, prepared, signed: signedOrder,
    onPrepared: async receipt => {
      // Explicitly in-memory callback evidence, NOT durable/crash-safe storage.
      assert(Object.isFrozen(receipt)); savedReceipts.push(receipt);
      assert.equal((await rpc<Context<(unknown | null)[]>>("getSignatureStatuses", [[receipt.signature], { searchTransactionHistory: true }])).value[0], null);
      assert.deepEqual(await accounts([actors[2].address, admin.address]), solBefore);
    } });
  assert.equal(savedReceipts.length, 1);
  assert.deepEqual(savedReceipts[0], { signature: preparedSignature, signedWireBase64: preparedWire,
    lastValidBlockHeight: prepared.lifetime.lastValidBlockHeight });
  assert.equal(submittedOrder.signature, preparedSignature); assert.equal(submittedOrder.signedWireBase64, preparedWire);
  assert(["submitted", "unknown"].includes(submittedOrder.status));
  // Neither submission status establishes settlement. Reconcile exactly that
  // signature without replacing the blockhash, re-signing, or sending again.
  let preparedReceipt: Receipt | null = null;
  const preparedDeadline = Date.now() + 60_000;
  while (Date.now() < preparedDeadline) {
    preparedReceipt = await rpc("getTransaction", [preparedSignature, { commitment: "confirmed", maxSupportedTransactionVersion: 0 }]);
    if (preparedReceipt?.meta) break;
    await delay(200);
  }
  assert(preparedReceipt?.meta, `Unknown prepared-order outcome: reconcile ${preparedSignature}`);
  assert.equal(preparedReceipt.meta.err, null);
  assert(preparedReceipt.meta.logMessages?.includes(`Program ${PROGRAM} success`));
  const preparedRoot = await finalized(preparedSignature, preparedReceipt.slot);
  const preparedAfter = await state("finalized"); invariants(preparedAfter, shortVaultAmount);
  assert.equal(preparedAfter.orders.length, 0);
  assert.equal(preparedAfter.revision, preparedBefore.revision + 1n);
  assert.equal(preparedAfter.nextSequence, preparedBefore.nextSequence + 1n);
  const expectedSeats = preparedBefore.seats.map(seat => ({ ...seat }));
  expectedSeats[0].available += 396n; expectedSeats[0].yes -= 1n; expectedSeats[0].reservedYes -= 1n;
  expectedSeats[2].available -= 404n; expectedSeats[2].yes += 1n; expectedSeats[2].nonce += 1n;
  assert.deepEqual(preparedAfter.seats, expectedSeats);
  assert.equal(preparedAfter.revenue, preparedBefore.revenue + 8n);
  assert.equal(preparedAfter.collateral, preparedBefore.collateral);
  assert.equal(preparedAfter.accounted, preparedBefore.accounted);
  assert.deepEqual(preparedAfter.tokenAccounts, preparedBefore.tokenAccounts);
  const solAfter = await accounts([actors[2].address, admin.address], "finalized");
  assert.equal(solBefore[0]!.lamports - solAfter[0]!.lamports, preparedReceipt.meta.fee);
  assert.equal(preparedReceipt.meta.fee, 5_000);
  assert.deepEqual(solAfter[1], solBefore[1], "Admin must not pay or sign the prepared order");
  receipts.push({ name: "shipping prepareOrder + sole-wallet signature + submitSignedWalletTransaction finalizes real fill", signature: preparedSignature,
    slot: preparedReceipt.slot, error: preparedReceipt.meta.err, feeLamports: preparedReceipt.meta.fee, computeUnits: preparedReceipt.meta.computeUnitsConsumed });
  await verifyReaders("after sole-wallet prepared order fills actual minted YES", preparedAfter, preparedRoot);
  console.log(`PASS prepared sole-wallet order finalized: ${preparedSignature}; wallet paid ${preparedReceipt.meta.fee} lamports`);

  // Decode only validator-returned finalized transaction logs. These records
  // are tied to exact signatures above; no locally encoded event fixture is
  // accepted as runtime evidence.
  async function finalizedEvents(result: Awaited<ReturnType<typeof execute>>) {
    const originalMeta = result.receipt.meta; assert(originalMeta);
    const deadline = Date.now() + 60_000;
    let actual: Receipt | null = null;
    while (Date.now() < deadline) {
      actual = await rpc("getTransaction", [result.signature, { commitment: "finalized", maxSupportedTransactionVersion: 0 }]);
      if (actual?.meta) break;
      await delay(200);
    }
    assert(actual?.meta, `Finalized event receipt unavailable: ${result.signature}`);
    assert.equal(actual.slot, result.receipt.slot);
    assert.deepEqual(actual.meta.err, originalMeta.err);
    const decoded = await decodeFinalizedProgramEvents({ programAddress: PROGRAM, genesisHash: genesis,
      signature: result.signature, slot: BigInt(actual.slot), commitment: "finalized",
      meta: { err: actual.meta.err, logMessages: actual.meta.logMessages } });
    const keys = decoded.records.map(record => record.eventKey);
    assert.equal(new Set(keys).size, keys.length);
    keys.forEach(key => assert(key.startsWith(`${genesis}:${PROGRAM}:${result.signature}:`)));
    return decoded;
  }
  function known<K extends GooseyProgramEvent["kind"]>(
    decoded: Awaited<ReturnType<typeof decodeFinalizedProgramEvents>>, kind: K,
  ): Extract<GooseyProgramEvent, { kind: K }>[] {
    return decoded.records.flatMap(record => record.status === "known" && record.event.kind === kind
      ? [record.event as Extract<GooseyProgramEvent, { kind: K }>] : []);
  }
  const configuredDecoded = await finalizedEvents(initializationReceipt);
  assert.equal(configuredDecoded.status, "decoded");
  assert.equal(configuredDecoded.records.some(record => record.status === "unknown"), false);
  assert.deepEqual(known(configuredDecoded, "Configured"), [{ kind: "Configured", config: base.config,
    mint: base.featherMint, environment: 1n, genesisDomain: createHash("sha256").update(genesis).digest("hex") }]);

  const enrollmentDecoded = await finalizedEvents(enrollmentReceipts[0]);
  assert.deepEqual(known(enrollmentDecoded, "EnrollmentAuthorized"), [{ kind: "EnrollmentAuthorized",
    wallet: actors[0].address, enrollment: enrollments[0], allowance: GRANT, expiresAt: closesAt }]);
  const claimDecoded = await finalizedEvents(claimReceipts[0]);
  assert.deepEqual(known(claimDecoded, "FeathersClaimed"), [{ kind: "FeathersClaimed",
    wallet: actors[0].address, amount: GRANT, lifetimeMinted: GRANT }]);

  const depositDecoded = await finalizedEvents(depositReceipts[0]);
  assert.deepEqual(known(depositDecoded, "CashMoved"), [{ kind: "CashMoved", market: market.market,
    wallet: actors[0].address, amount: GRANT, deposit: true, nonce: 0n }]);
  const withdrawalDecoded = await finalizedEvents(finalWithdrawal);
  assert.deepEqual(known(withdrawalDecoded, "CashMoved"), [{ kind: "CashMoved", market: market.market,
    wallet: actors[0].address, amount: withdrawalAmount, deposit: false,
    nonce: final.seats[0].nonce - 1n }]);

  const fillDecoded = await finalizedEvents(mintFill);
  const orderEvents = known(fillDecoded, "OrderExecuted"), tradeEvents = known(fillDecoded, "TradeExecuted");
  assert.equal(orderEvents.length, 1); assert.equal(tradeEvents.length, 1);
  const legacyOrder = mintFill.events.orders[0], legacyTrade = mintFill.events.trades[0];
  assert.deepEqual(orderEvents[0], { kind: "OrderExecuted", market: market.market, wallet: actors[1].address,
    orderId: legacyOrder.orderId, nonce: mintFill.command.expectedNonce, filled: legacyOrder.filled,
    canceled: legacyOrder.canceled, rested: legacyOrder.rested, disposition: BigInt(legacyOrder.disposition),
    outcome: BigInt(mintFill.command.outcome), action: BigInt(mintFill.command.action), price: mintFill.command.price });
  assert.deepEqual(tradeEvents[0], { kind: "TradeExecuted", market: market.market,
    makerOrderId: legacyTrade.makerOrderId, takerOrderId: legacyTrade.takerOrderId,
    makerSeat: legacyTrade.makerSeat, takerSeat: legacyTrade.takerSeat, quantity: legacyTrade.quantity,
    yesPrice: legacyTrade.yesPrice, makerFee: legacyTrade.makerFee, takerFee: legacyTrade.takerFee,
    makerOutcome: BigInt(legacyTrade.makerOutcome), makerAction: BigInt(legacyTrade.makerAction),
    takerOutcome: BigInt(legacyTrade.takerOutcome), takerAction: BigInt(legacyTrade.takerAction) });

  const failedDecoded = await finalizedEvents(failedFok);
  assert.equal(failedDecoded.status, "failed-transaction");
  assert.deepEqual(failedDecoded.records, [], "Rolled-back failed transaction exposed program events");
  const decodedEventEvidence = {
    finalizedReceipts: 7,
    signatures: [initializationReceipt.signature, enrollmentReceipts[0].signature, claimReceipts[0].signature,
      depositReceipts[0].signature, mintFill.signature, finalWithdrawal.signature, failedFok.signature],
    knownKinds: ["Configured", "EnrollmentAuthorized", "FeathersClaimed", "CashMoved", "OrderExecuted", "TradeExecuted"],
    failedReceiptExcludedEvents: true,
  };
  console.log("PASS finalized compiled-program event decoding matches actual enrollment, cash, order and fill receipts");

  // Exercise the shipping finalized reader and immutable journal against these
  // same actual transactions. The database contains only the three additive
  // journal tables and lives beside this run's disposable key and ledger.
  const verifiedReceipts = [];
  for (const transactionSignature of decodedEventEvidence.signatures) {
    verifiedReceipts.push(await readFinalizedProgramEvents(runtime, transactionSignature));
  }
  assert.deepEqual(verifiedReceipts.map(receipt => receipt.outcome),
    ["success", "success", "success", "success", "success", "success", "failed"]);
  assert(verifiedReceipts.slice(0, -1).every(receipt => receipt.records.length > 0));
  assert.deepEqual(verifiedReceipts.at(-1)?.records, []);

  const journalPath = path.join(path.dirname(adminPath), "event-journal.sqlite");
  const journalHandle = await open(journalPath, "wx", 0o600); await journalHandle.close();
  const journalSql = await readFile(new URL("../prisma/sqlite-upgrades/20260919220000_solana_event_journal.sql", import.meta.url), "utf8");
  await executeFile("sqlite3", ["-batch", "-bail", "-init", "/dev/null", journalPath,
    `PRAGMA foreign_keys=ON;\n${journalSql}\nPRAGMA foreign_key_check;\nPRAGMA integrity_check;`],
  { timeout: 15_000, maxBuffer: 1024 * 1024 });
  const schema = await executeFile("sqlite3", ["-readonly", "-batch", "-bail", "-init", "/dev/null", "-noheader", "-list",
    journalPath, "SELECT name FROM sqlite_master WHERE type='table' AND name NOT GLOB 'sqlite_*' ORDER BY name;"],
  { timeout: 5_000, maxBuffer: 64 * 1024 });
  assert.deepEqual(schema.stdout.trim().split("\n"), ["SolanaIngestionCursor", "SolanaProgramEvent", "SolanaTransactionReceipt"]);

  const journalUrl = `file:${journalPath}?connection_limit=1`;
  let journal = new PrismaClient({ datasourceUrl: journalUrl });
  const inserted = [];
  try {
    for (const expected of verifiedReceipts) {
      const result = await ingestFinalizedProgramTransaction(runtime, expected.signature,
        { client: journal, provider: "sqlite" });
      assert.equal(result.inserted, true); assert.equal(result.outcome, expected.outcome);
      assert.equal(result.eventCount, expected.records.length); assert.equal(result.slot, expected.slot);
      inserted.push(result);
    }
    const stored = await journal.solanaTransactionReceipt.findMany({
      orderBy: { slot: "asc" }, include: { events: { orderBy: { logIndex: "asc" } } },
    });
    assert.equal(stored.length, verifiedReceipts.length);
    for (const expected of verifiedReceipts) {
      const receipt = stored.find(candidate => candidate.signature === expected.signature); assert(receipt);
      assert.equal(receipt.genesisHash, genesis); assert.equal(receipt.programAddress, PROGRAM);
      assert.equal(receipt.slot, expected.slot); assert.equal(receipt.eventCount, expected.records.length);
      assert.equal(receipt.status, expected.outcome === "failed" ? "VERIFIED_FAILED" : "VERIFIED_SUCCESS");
      assert.deepEqual(receipt.events.map(event => [event.eventKey, event.logIndex, event.invocationDepth, event.kind]),
        expected.records.map(record => [record.eventKey, record.logIndex, record.invocationDepth, record.event.kind]));
    }
    const failedStored = stored.find(receipt => receipt.signature === failedFok.signature); assert(failedStored);
    assert.equal(failedStored.status, "VERIFIED_FAILED"); assert.equal(failedStored.eventCount, 0);
    assert.deepEqual(failedStored.events, []);
  } finally { await journal.$disconnect(); }

  // Reopen the database to prove replay behavior does not depend on an
  // in-memory Prisma connection or process-local deduplication state.
  journal = new PrismaClient({ datasourceUrl: journalUrl });
  try {
    for (const [index, expected] of verifiedReceipts.entries()) {
      const replay = await ingestFinalizedProgramTransaction(runtime, expected.signature,
        { client: journal, provider: "sqlite" });
      assert.equal(replay.inserted, false); assert.equal(replay.receiptId, inserted[index].receiptId);
      assert.equal(replay.eventCount, expected.records.length); assert.equal(replay.outcome, expected.outcome);
    }
    assert.equal(await journal.solanaTransactionReceipt.count(), verifiedReceipts.length);
    assert.equal(await journal.solanaProgramEvent.count(), verifiedReceipts.reduce((sum, receipt) => sum + receipt.records.length, 0));
  } finally { await journal.$disconnect(); }
  console.log("PASS actual finalized RPC receipts persist atomically and replay immutably after a Prisma restart");

  // Add only the second, ALTER-free membership migration to this same private
  // journal, then scan the actual finalized program history in bounded pages.
  const visitsSql = await readFile(new URL("../prisma/sqlite-upgrades/20260919230000_solana_ingestion_visits.sql", import.meta.url), "utf8");
  await executeFile("sqlite3", ["-batch", "-bail", "-init", "/dev/null", journalPath,
    `PRAGMA foreign_keys=ON;\nBEGIN IMMEDIATE;\n${visitsSql}\nCOMMIT;\nPRAGMA foreign_key_check;\nPRAGMA integrity_check;`],
  { timeout: 15_000, maxBuffer: 1024 * 1024 });
  const upgradedSchema = await executeFile("sqlite3", ["-readonly", "-batch", "-bail", "-init", "/dev/null", "-noheader", "-list",
    journalPath, "SELECT name FROM sqlite_master WHERE type='table' AND name NOT GLOB 'sqlite_*' ORDER BY name;"],
  { timeout: 5_000, maxBuffer: 64 * 1024 });
  assert.deepEqual(upgradedSchema.stdout.trim().split("\n"),
    ["SolanaIngestionCursor", "SolanaIngestionVisit", "SolanaProgramEvent", "SolanaTransactionReceipt"]);

  journal = new PrismaClient({ datasourceUrl: journalUrl });
  const preexisting = await journal.solanaTransactionReceipt.findMany({ orderBy: { signature: "asc" },
    select: { id: true, signature: true, status: true, eventCount: true } });
  assert.equal(preexisting.length, verifiedReceipts.length);
  const pageOptions = () => ({ client: journal, provider: "sqlite" as const, pageSize: 10, concurrency: 4 });
  let pageResult = await ingestFinalizedProgramPage(runtime, initializationReceipt.signature, pageOptions());
  assert.equal(pageResult.status, "page-committed"); assert.equal(pageResult.verifiedReceipts, 10);
  assert.equal(pageResult.cursor.coverageStartSignature, initializationReceipt.signature);
  assert.equal(pageResult.cursor.committedHeadSignature, null); assert.equal(pageResult.cursor.backfillComplete, false);
  assert(pageResult.cursor.scanHeadSignature && pageResult.cursor.scanBeforeSignature);
  const frozenHead = pageResult.cursor.scanHeadSignature;
  let pageCount = 1, insertedByPages = pageResult.insertedReceipts;
  const firstPageCursor = { revision: pageResult.cursor.revision, scanHeadSignature: pageResult.cursor.scanHeadSignature,
    scanBeforeSignature: pageResult.cursor.scanBeforeSignature, committedHeadSignature: pageResult.cursor.committedHeadSignature };
  await journal.$disconnect();

  // A fresh client must resume the exact frozen window rather than silently
  // replacing its head with transactions observed after the first page.
  journal = new PrismaClient({ datasourceUrl: journalUrl });
  assert.deepEqual(await journal.solanaIngestionCursor.findFirstOrThrow({ select: {
    revision: true, scanHeadSignature: true, scanBeforeSignature: true, committedHeadSignature: true,
  } }), firstPageCursor);
  while (pageResult.status !== "window-complete") {
    assert(pageCount < 100, "Finalized program history exceeded bounded test page count");
    pageResult = await ingestFinalizedProgramPage(runtime, initializationReceipt.signature, pageOptions());
    pageCount++; insertedByPages += pageResult.insertedReceipts;
    if (pageResult.status === "page-committed") {
      assert.equal(pageResult.cursor.scanHeadSignature, frozenHead);
      assert.equal(pageResult.cursor.committedHeadSignature, null);
      assert.equal(pageResult.cursor.backfillComplete, false);
    }
  }
  assert.equal(pageResult.cursor.committedHeadSignature, frozenHead);
  assert.equal(pageResult.cursor.backfillComplete, true);
  assert.equal(pageResult.cursor.scanHeadSignature, null); assert.equal(pageResult.cursor.scanBeforeSignature, null);

  const visits = await journal.solanaIngestionVisit.findMany({ orderBy: { createdAt: "asc" } });
  const windowReceipts = await journal.solanaTransactionReceipt.findMany({ orderBy: { signature: "asc" },
    include: { events: { orderBy: { logIndex: "asc" } } } });
  assert(visits.length > 10); assert.equal(new Set(visits.map(visit => visit.signature)).size, visits.length);
  assert(visits.every(visit => visit.genesisHash === genesis && visit.programAddress === PROGRAM
    && visit.scanHeadSignature === frozenHead));
  assert.deepEqual(visits.map(visit => visit.signature).sort(), windowReceipts.map(receipt => receipt.signature).sort());
  assert.equal(insertedByPages, windowReceipts.length - preexisting.length);
  const decodedSignatures = new Set<string>(decodedEventEvidence.signatures);
  const preexistingAfter = windowReceipts.filter(receipt => decodedSignatures.has(receipt.signature))
    .map(({ id, signature: transactionSignature, status, eventCount }) => ({ id, signature: transactionSignature, status, eventCount }))
    .sort((a, b) => a.signature < b.signature ? -1 : a.signature > b.signature ? 1 : 0);
  assert.deepEqual(preexistingAfter, preexisting);
  assert(decodedEventEvidence.signatures.every(transactionSignature => visits.some(visit => visit.signature === transactionSignature)));
  assert(visits.some(visit => visit.signature === initializationReceipt.signature));
  assert(windowReceipts.some(receipt => receipt.status === "VERIFIED_SUCCESS" && receipt.eventCount === 0));
  assert(windowReceipts.some(receipt => receipt.status === "VERIFIED_FAILED" && receipt.eventCount === 0));
  const windowFailedFok = windowReceipts.find(receipt => receipt.signature === failedFok.signature); assert(windowFailedFok);
  assert.equal(windowFailedFok.status, "VERIFIED_FAILED"); assert.equal(windowFailedFok.eventCount, 0);
  assert.deepEqual(windowFailedFok.events, []);
  assert.equal(await journal.solanaProgramEvent.count(),
    windowReceipts.reduce((sum, receipt) => sum + receipt.eventCount, 0));

  const completedCursor = await journal.solanaIngestionCursor.findFirstOrThrow();
  const completedCounts = { receipts: windowReceipts.length, visits: visits.length,
    events: await journal.solanaProgramEvent.count() };
  const idle = await ingestFinalizedProgramPage(runtime, initializationReceipt.signature, pageOptions());
  assert.equal(idle.status, "idle"); assert.equal(idle.verifiedReceipts, 0); assert.equal(idle.insertedReceipts, 0);
  assert.deepEqual(idle.cursor, completedCursor);
  assert.deepEqual({ receipts: await journal.solanaTransactionReceipt.count(), visits: await journal.solanaIngestionVisit.count(),
    events: await journal.solanaProgramEvent.count() }, completedCounts);
  await journal.$disconnect();
  const journalEvidence = { database: journalPath, tables: 4, preexistingReceipts: verifiedReceipts.length,
    preexistingReplayInserted: 0, coverageStartSignature: initializationReceipt.signature, frozenHead,
    pageSize: 10, pages: pageCount, receipts: completedCounts.receipts, visits: completedCounts.visits,
    events: completedCounts.events, pageInsertedReceipts: insertedByPages, completedRevision: completedCursor.revision,
    idleRevision: idle.cursor.revision, idleInsertedReceipts: idle.insertedReceipts,
    failedFok: { signature: failedFok.signature, status: "VERIFIED_FAILED", events: 0 } };
  console.log("PASS bounded finalized program window resumes after restart, preserves membership and idles without writes");
  console.log(JSON.stringify({ result: "PASS", scope: "Actual RPC compiled-program exchange integration, not a host arithmetic simulation",
    rpc: endpoint.toString(), genesis, program: PROGRAM, validator: await rpc("getVersion"), market: market.market, seats: market.seats, book,
    bookBytes: BOOK_BYTES, bootstrapSizes: [10_240, 20_480, 30_720, 40_960, 51_200, 61_440, 69_720], transactionCaseCount: receipts.length,
    successBuilders: ["program-client.ts", "escrow-client.ts", "exchange-client.ts", "resolution-client.ts"],
    resolutionAdmission: { resolution, reviewers: reviewers.map((wallet, i) => ({ wallet: wallet.address, enrollment: reviewerEnrollments[i] })),
      reviewerAllowanceEach: 1, reviewerClaims: 0, finalizedReaderBatchAccounts: 10 },
    additionalChecks: ["identical signed transaction replay", "exact-signature finality", "heap/free-list and exact live-order reserves after every placement", "18 finalized shipping escrow reader snapshots", "actual finalized program-event decoding", "disposable SQLite finalized-event journal restart replay", "bounded restart-safe full-window program ingestion"],
    decodedEventEvidence, journalEvidence,
    preparedOrder: { signature: preparedSignature, submissionStatus: submittedOrder.status, finalizedSlot: preparedRoot,
      sender: prepared.sender, expectedNonce: prepared.expectedNonce, observedSlot: prepared.observedSlot,
      bookRevision: prepared.bookRevision, receiptStorage: "in-memory callback only; not durable storage proof",
      callbackBeforeSend: true, walletFeeLamports: preparedReceipt.meta.fee, exchangeFeeDelta: 8n,
      finalFees: preparedAfter.revenue, finalSeats: preparedAfter.seats },
    finalizedReaders, closeBoundary: { market: shortMarket.market, closesAt: shortClose, openClock, closedClock, openBlockTime, closedBlockTime,
      openSignature: openFill.signature, rejectedSignature: rejected.signature, finalizedSlot: closedRoot,
      accountedVault: shortVaultAmount, collateral: 1_000n, fees: 10n, readers: closedReads.map(r => ({ wallet: r.wallet, finalizedSlot: r.finalizedSlot, seat: r.seat })) },
    final: { accounted: final.accounted, vault: final.vault, collateral: final.collateral, fees: final.revenue, supply: final.supply, seats: final.seats },
    receipts, gaps: ["cancel/replace/resolution instruction lifecycle", "1024-order capacity exhaustion", "16 distinct maker seats/full-book CU stress",
      "fork/restart recovery and concurrent RPC sends", "browser wallets", "unreachable corrupt-account/nonce-overflow states are not fabricated", "exact equality-second scheduling is not guaranteed; real pre-close and at/after-close receipts are checked"],
  }, (_, value: unknown) => typeof value === "bigint" ? value.toString() : value, 2));
}
main().catch((error: unknown) => { console.error(error instanceof Error ? error.message : "Exchange RPC suite failed"); process.exitCode = 1; });
