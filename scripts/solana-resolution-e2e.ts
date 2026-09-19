/** Actual compiled-program resolution RPC suite. It runs only against the fresh
 * loopback ledger created by solana-program-e2e-isolated.ts --suite resolution.
 * Every feather, position, reserve and payout is produced by shipping program
 * instructions; this file never writes or fabricates account state. */
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  address, appendTransactionMessageInstructions, blockhash, createKeyPairSignerFromBytes,
  createTransactionMessage, generateKeyPairSigner, getAddressDecoder, getAddressEncoder,
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
  buildWithdrawInstruction,
} from "../src/lib/solana/escrow-client";
import {
  buildBookSetupInstruction, buildCleanupOrderInstruction, buildPlaceOrderInstruction,
  deriveGooseyBookAddress, GOOSEY_BOOK_BYTES, type ChainOrderInput, type ChainOrderTarget,
} from "../src/lib/solana/exchange-client";
import {
  buildApproveResolutionInstruction, buildClaimResolutionInstruction,
  buildCloseResolutionInstruction, buildFinalizeResolutionInstruction,
  buildInitializeResolutionInstruction, buildProposeResolutionInstruction,
  buildRejectResolutionInstruction,
  type ResolutionFingerprint, type ResolutionOutcome,
} from "../src/lib/solana/resolution-client";
import { readResolutionState } from "../src/lib/solana/resolution-state";
import { readGooseyEscrow } from "../src/lib/solana/escrow-read";

const PROGRAM = address("CgEGAD3EGLm63YaSx58sRiNPQmmxg8RqvqcxE3xThX8Q");
const LOADER = address("BPFLoaderUpgradeab1e11111111111111111111111");
const CLOCK = address("SysvarC1ock11111111111111111111111111111111");
const GRANT = 10_000_000n;
const FEE_BPS = 1;
const keyBytes = (key: Address) => Buffer.from(getAddressEncoder().encode(key));
type Account = { data: [string, string]; owner: Address; executable: boolean; lamports: number };
type Context<T> = { context: { slot: number }; value: T };
type Receipt = { slot: number; meta: { err: unknown; fee: number; computeUnitsConsumed?: number; logMessages: string[] | null } };
type ExpectedError = { code?: number; index?: number };
type Row = { available: bigint; reserved: bigint; yes: bigint; no: bigint; reservedYes: bigint;
  reservedNo: bigint; nonce: bigint; ever: number };
type Order = { id: bigint; owner: number; price: bigint; quantity: bigint; chain: bigint;
  side: "BID" | "ASK"; heapIndex: number; action: "BUY" | "SELL"; outcome: "YES" | "NO" };
type Market = { marketId: bigint; market: Address; seats: Address; vault: Address; book: Address;
  resolution: Address; payout: bigint; closesAt: bigint; resolvesAt: bigint; outcome: ResolutionOutcome };

async function main() {
  if (process.argv.includes("--help")) {
    console.log(`Actual Goosey resolution RPC suite. Launch only through:
GOOSEY_SOLANA_BIN_DIR=/path/to/bin node --import tsx scripts/solana-program-e2e-isolated.ts --suite resolution
Direct execution requires the fresh runner's loopback RPC, pinned genesis and
disposable upgrade-authority keypair. Shared ports, public networks, existing
configuration, account injection and validator resets are refused.`);
    return;
  }
  assert.equal(process.argv.length, 2, "Unknown arguments; use --help");
  const endpoint = new URL(process.env.GOOSEY_SOLANA_RPC_URL ?? "");
  assert(["127.0.0.1", "[::1]"].includes(endpoint.hostname) && ["http:", "https:"].includes(endpoint.protocol));
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
  assert.equal(bytes(programData)[12], 1);
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
    const send = async () => {
      await pin();
      assert.equal(await rpc("sendTransaction", [wire, { encoding: "base64", skipPreflight: true, maxRetries: 5 }]), signature);
    };
    await send();
    const deadline = Date.now() + 60_000;
    let receipt: Receipt | null = null;
    let resentAt = Date.now();
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
    return { signature, receipt, logs, send };
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
    perWalletCap: GRANT, campaignCap: 4n * GRANT + 2n });
  await execute("initialize actual program and feather mint", [initialized.instruction]);
  const actors = await Promise.all(Array.from({ length: 4 }, () => generateKeyPairSigner()));
  const reviewers = await Promise.all([generateKeyPairSigner(), generateKeyPairSigner()]);
  assert.equal(new Set([admin.address, ...actors.map(a => a.address), ...reviewers.map(r => r.address)]).size, 7);
  await execute("fund disposable actor/reviewer rent", [...actors, ...reviewers].map(wallet =>
    getTransferSolInstruction({ source: admin, destination: wallet.address, amount: 1_000_000_000n })));

  const enrollmentExpiry = (await chainTime()) + 900n;
  const walletTokens: Address[] = [];
  for (const [index, wallet] of actors.entries()) {
    const grant = await buildAuthorizeEnrollmentInstruction({ programAddress: PROGRAM, enrollmentAuthority: admin,
      wallet: wallet.address, identityDigest: randomBytes(32), allowance: GRANT, expiresAt: enrollmentExpiry });
    await execute(`authorize real actor grant ${index}`, [grant.instruction]);
    const claim = await buildClaimFeathersInstructions({ programAddress: PROGRAM, wallet, payer: admin, createAta: true });
    await execute(`actor ${index} claims actual SPL feathers`, claim.instructions);
    walletTokens.push(claim.walletTokens);
    for (const key of [claim.walletTokens, claim.enrollment, grant.identity]) watched.add(key);
    assert.equal(getTokenDecoder().decode(bytes((await accounts([claim.walletTokens]))[0])).amount, GRANT);
  }
  for (const [index, reviewer] of reviewers.entries()) {
    const grant = await buildAuthorizeEnrollmentInstruction({ programAddress: PROGRAM, enrollmentAuthority: admin,
      wallet: reviewer.address, identityDigest: randomBytes(32), allowance: 1n, expiresAt: enrollmentExpiry });
    await execute(`enroll independent nontrading reviewer ${index}`, [grant.instruction]);
    watched.add(grant.enrollment); watched.add(grant.identity);
  }

  const commonClose = (await chainTime()) + 150n;
  const commonResolve = commonClose + 20n;
  const runtime = { cluster: "localnet" as const, rpcUrl: endpoint.toString(), genesisHash: genesis, programAddress: PROGRAM };
  const phaseThreeReaderEvidence: Record<string, unknown>[] = [];
  let earlyResolutionTimingChecked = false;
  async function createMarket(marketId: bigint, payout: bigint, outcome: ResolutionOutcome): Promise<Market> {
    const created = await buildCreateMarketInstructions({ programAddress: PROGRAM, marketId, admin,
      seats: await generateKeyPairSigner(), seatsRentLamports: BigInt(await rpc<number>("getMinimumBalanceForRentExemption", [32_816])),
      payoutMilli: payout, feeBps: FEE_BPS, closesAt: commonClose, resolvesAt: commonResolve });
    await execute(`create ${outcome} market ${marketId}`, created.instructions);
    const { book } = await deriveGooseyBookAddress(PROGRAM, created.market);
    for (const key of [created.market, created.seats, created.vault, book]) watched.add(key);
    for (const [index, wallet] of actors.entries()) {
      const registered = await buildRegisterSeatInstruction({ programAddress: PROGRAM, marketId, wallet, seats: created.seats });
      await execute(`register ${outcome} seat ${index}`, [registered.instruction]);
      watched.add(registered.locator);
      const deposit = await buildDepositInstruction({ programAddress: PROGRAM, marketId, wallet, seats: created.seats,
        amount: 2_000_000n, expectedNonce: 0n });
      await execute(`deposit real feathers ${outcome} seat ${index}`, [deposit.instruction]);
    }
    const setup = async (step: Parameters<typeof buildBookSetupInstruction>[0]["step"]) =>
      (await buildBookSetupInstruction({ programAddress: PROGRAM, marketId, admin, step })).instruction;
    await execute(`create ${outcome} canonical book`, [await setup({ kind: "create" })]);
    for (;;) {
      const observed = bytes((await accounts([book]))[0]).length;
      if (observed === GOOSEY_BOOK_BYTES) break;
      await execute(`grow ${outcome} book from observed ${observed}`, [await setup({ kind: "grow", expectedSize: observed })]);
    }
    await execute(`finalize ${outcome} canonical book`, [await setup({ kind: "finalize" })]);
    const resolution = await buildInitializeResolutionInstruction({ programAddress: PROGRAM, marketId, seats: created.seats,
      creator: admin, proposer: reviewers[0].address, approver: reviewers[1].address });
    watched.add(resolution.resolution);
    await execute(`freeze ${outcome} reviewers before first trade`, [resolution.instruction]);
    return { marketId, market: created.market, seats: created.seats, vault: created.vault, book,
      resolution: resolution.resolution, payout, closesAt: commonClose, resolvesAt: commonResolve, outcome };
  }

  const markets = [
    await createMarket(1n, 100_000n, "YES"),
    await createMarket(2n, 100_000n, "NO"),
    await createMarket(3n, 100_001n, "VOID"),
  ];

  async function state(market: Market, commitment = "confirmed") {
    const rawAccounts = await accounts([market.market, market.seats, market.book, market.vault,
      market.resolution, base.featherMint, ...walletTokens], commitment);
    const [marketAccount, seatsAccount, bookAccount, vaultAccount, resolutionAccount, mintAccount, ...tokenAccounts] = rawAccounts;
    for (const account of [marketAccount, seatsAccount, bookAccount, resolutionAccount]) assert.equal(account?.owner, PROGRAM);
    for (const account of [vaultAccount, mintAccount, ...tokenAccounts]) assert.equal(account?.owner, TOKEN_PROGRAM_ADDRESS);
    const md = bytes(marketAccount), sd = bytes(seatsAccount), bd = bytes(bookAccount);
    assert.equal(bd.length, GOOSEY_BOOK_BYTES);
    assert.equal(bd.subarray(0, 8).toString(), "GOOSEYB1");
    assert.deepEqual(bd.subarray(8, 40), keyBytes(market.market));
    const rows: Row[] = actors.map((wallet, index) => {
      const offset = 48 + index * 128;
      assert.deepEqual(sd.subarray(offset, offset + 32), keyBytes(wallet.address));
      return { available: sd.readBigUInt64LE(offset + 64), reserved: sd.readBigUInt64LE(offset + 72),
        yes: sd.readBigUInt64LE(offset + 80), no: sd.readBigUInt64LE(offset + 88),
        reservedYes: sd.readBigUInt64LE(offset + 96), reservedNo: sd.readBigUInt64LE(offset + 104),
        nonce: sd.readBigUInt64LE(offset + 112), ever: sd[offset + 120] };
    });
    assert.equal(sd.readUInt32LE(40), actors.length, "Reviewers must remain unseated and unexposed");
    const orders: Order[] = [];
    for (const [side, offset, count] of [["BID", 65_624, bd.readUInt16LE(74)], ["ASK", 67_672, bd.readUInt16LE(76)]] as const) {
      for (let heapIndex = 0; heapIndex < count; heapIndex++) {
        const slot = bd.readUInt16LE(offset + heapIndex * 2), entry = 88 + slot * 64, flags = bd.readUInt16LE(entry + 56);
        assert(slot < 1024 && flags & 1);
        orders.push({ id: bd.readBigUInt64LE(entry), owner: Number(bd.readBigUInt64LE(entry + 8)),
          price: bd.readBigUInt64LE(entry + 16), quantity: bd.readBigUInt64LE(entry + 24),
          chain: bd.readBigUInt64LE(entry + 48), side, heapIndex,
          outcome: flags & 2 ? "NO" : "YES", action: flags & 4 ? "SELL" : "BUY" });
      }
    }
    assert.equal(orders.length, bd.readUInt16LE(78));
    const expected = rows.map(() => ({ cash: 0n, yes: 0n, no: 0n }));
    const fee = (notional: bigint) => (notional * BigInt(FEE_BPS) + 9_999n) / 10_000n;
    for (const order of orders) {
      const reserve = expected[order.owner]; assert(reserve);
      if (order.action === "BUY") {
        const notional = order.price * order.quantity;
        reserve.cash += notional + fee(order.chain + notional) - fee(order.chain);
      } else if (order.outcome === "YES") reserve.yes += order.quantity;
      else reserve.no += order.quantity;
    }
    rows.forEach((row, index) => assert.deepEqual([row.reserved, row.reservedYes, row.reservedNo],
      [expected[index].cash, expected[index].yes, expected[index].no]));
    const accounted = md.readBigUInt64LE(168), collateral = md.readBigUInt64LE(176), fees = md.readBigUInt64LE(184);
    const availableAndReserved = rows.reduce((sum, row) => sum + row.available + row.reserved, 0n);
    assert.equal(availableAndReserved + collateral + fees, accounted);
    const vault = getTokenDecoder().decode(bytes(vaultAccount));
    assert.equal(vault.amount, accounted); assert.equal(vault.owner, market.market); assert.equal(vault.mint, base.featherMint);
    const binding = { market: market.market, config: base.config, creator: admin.address, payoutMilli: market.payout,
      closesAt: market.closesAt, resolvesAt: market.resolvesAt };
    const resolution = await readResolutionState(PROGRAM, binding, { address: market.resolution,
      owner: resolutionAccount!.owner, executable: resolutionAccount!.executable, data: bytes(resolutionAccount) });
    const totalYes = rows.reduce((sum, row) => sum + row.yes, 0n);
    const totalNo = rows.reduce((sum, row) => sum + row.no, 0n);
    if (resolution.phase <= 2) {
      assert.equal(totalYes, totalNo); assert.equal(collateral, totalYes * market.payout);
    } else if (resolution.phase === 3) {
      assert.equal(totalYes, resolution.outstandingYes); assert.equal(totalNo, resolution.outstandingNo);
      const liability = resolution.outcome === 0 ? totalYes * market.payout
        : resolution.outcome === 1 ? totalNo * market.payout
        : rows.reduce((sum, row) => sum + market.payout * (row.yes + row.no) / 2n, 0n);
      assert(collateral >= liability);
      if (resolution.outcome !== 2) assert.equal(collateral, liability);
    } else {
      assert.equal(totalYes, 0n); assert.equal(totalNo, 0n); assert.equal(collateral, 0n);
    }
    return { rows, orders, accounted, collateral, fees, resolution, vault, rawAccounts,
      nextSequence: bd.readBigUInt64LE(64) };
  }

  const orderInput = (action: "BUY" | "SELL", outcome: "YES" | "NO", price: bigint, quantity: bigint,
    timeInForce: "GTC" | "IOC" | "FOK" = "GTC") => ({ action, outcome, price, quantity, timeInForce,
      selfTrade: "CANCEL_AGGRESSOR" as const });
  async function place(market: Market, owner: number,
    input: Pick<ChainOrderInput, "action" | "outcome" | "price" | "quantity" | "timeInForce" | "selfTrade">,
    expected?: ExpectedError) {
    const before = await state(market);
    const built = await buildPlaceOrderInstruction({ programAddress: PROGRAM, marketId: market.marketId,
      seats: market.seats, wallet: actors[owner], expectedNonce: before.rows[owner].nonce, ...input, touches: 16 });
    await execute(`${expected ? "reject" : "place"} ${market.outcome} ${input.action} ${input.outcome} owner${owner}`,
      [built.instruction], expected);
    const after = await state(market);
    if (expected) assert.deepEqual(after.rows, before.rows);
    return before.nextSequence;
  }
  async function cleanupAll(market: Market) {
    for (;;) {
      const snapshot = await state(market);
      const order = snapshot.orders.find(candidate => candidate.heapIndex === 0);
      if (!order) return;
      const target: ChainOrderTarget = { orderId: order.id, side: order.side, heapIndex: 0 };
      const built = await buildCleanupOrderInstruction({ programAddress: PROGRAM, marketId: market.marketId,
        seats: market.seats, target });
      await execute(`permissionless post-close cleanup ${market.outcome} order${order.id}`, [built.instruction]);
    }
  }

  for (const market of markets) {
    const noPrice = market.payout - 40_000n;
    await place(market, 1, orderInput("BUY", "NO", noPrice, market.outcome === "VOID" ? 1n : 3n));
    await place(market, 0, orderInput("BUY", "YES", 40_000n, market.outcome === "VOID" ? 1n : 3n, "FOK"));
    await place(market, 2, orderInput("BUY", "YES", 10_000n, 1n));
    const filled = await state(market);
    assert(filled.rows[0].yes > 0n && filled.rows[1].no > 0n);
    assert.equal(filled.orders.length, 1);
    assert(filled.fees > 0n && filled.collateral > 0n);
  }

  const earlyClose = await buildCloseResolutionInstruction({ programAddress: PROGRAM, marketId: markets[0].marketId,
    seats: markets[0].seats, keeper: admin });
  await execute("close before chain close rejected atomically", [earlyClose.instruction], { code: 7404 });
  await waitUntil(commonClose);
  for (const market of markets) {
    await place(market, 3, orderInput("BUY", "NO", 20_000n, 1n), { code: 7002 });
    const close = await buildCloseResolutionInstruction({ programAddress: PROGRAM, marketId: market.marketId,
      seats: market.seats, keeper: admin });
    await execute(`close ${market.outcome} blocked while canonical order remains`, [close.instruction], { code: 7406 });
    await cleanupAll(market);
    await execute(`close drained ${market.outcome} market`, [close.instruction]);
    assert.equal((await state(market)).resolution.phase, 1);
  }

  const earlyFingerprint: ResolutionFingerprint = { sequence: 1n, outcome: "YES",
    reasonDigest: randomBytes(32), evidenceDigest: randomBytes(32) };
  if (await chainTime() < commonResolve) {
    const earlyProposal = await buildProposeResolutionInstruction({ programAddress: PROGRAM,
      marketId: markets[0].marketId, seats: markets[0].seats, reviewer: reviewers[0], ...earlyFingerprint });
    watched.add(earlyProposal.proposal);
    await execute("proposal before resolvesAt rejected and PDA creation rolled back", [earlyProposal.instruction], { code: 7404 });
    earlyResolutionTimingChecked = true;
  }
  await waitUntil(commonResolve);

  const fingerprints = new Map<bigint, ResolutionFingerprint>();
  for (const market of markets) {
    let sequence = 1n;
    let fingerprint: ResolutionFingerprint = { sequence, outcome: market.outcome,
      reasonDigest: randomBytes(32), evidenceDigest: randomBytes(32) };
    const unauthorized = await buildProposeResolutionInstruction({ programAddress: PROGRAM, marketId: market.marketId,
      seats: market.seats, reviewer: actors[0], ...fingerprint });
    watched.add(unauthorized.proposal);
    await execute(`trading participant cannot replace frozen ${market.outcome} proposer`, [unauthorized.instruction], { code: 7410 });
    const proposed = await buildProposeResolutionInstruction({ programAddress: PROGRAM, marketId: market.marketId,
      seats: market.seats, reviewer: reviewers[0], ...fingerprint });
    watched.add(proposed.proposal);
    await execute(`frozen proposer submits ${market.outcome} evidence`, [proposed.instruction]);
    assert.deepEqual((await state(market)).resolution.activeProposalSequence, sequence);

    const sameParty = await buildApproveResolutionInstruction({ programAddress: PROGRAM, marketId: market.marketId,
      seats: market.seats, reviewer: reviewers[0], expected: fingerprint });
    await execute(`proposer cannot self-approve ${market.outcome}`, [sameParty.instruction], { code: 7410 });
    const altered = { ...fingerprint, evidenceDigest: randomBytes(32) };
    const wrongEvidence = await buildApproveResolutionInstruction({ programAddress: PROGRAM, marketId: market.marketId,
      seats: market.seats, reviewer: reviewers[1], expected: altered });
    await execute(`approval must bind immutable ${market.outcome} evidence`, [wrongEvidence.instruction], { code: 7414 });

    if (market.outcome === "VOID") {
      const rejected = await buildRejectResolutionInstruction({ programAddress: PROGRAM, marketId: market.marketId,
        seats: market.seats, reviewer: reviewers[1], expected: fingerprint, reviewDigest: randomBytes(32) });
      await execute("independent reviewer rejects first VOID proposal", [rejected.instruction]);
      assert.equal((await state(market)).resolution.phase, 1);
      sequence = 2n;
      fingerprint = { sequence, outcome: market.outcome, reasonDigest: randomBytes(32), evidenceDigest: randomBytes(32) };
      const reproposed = await buildProposeResolutionInstruction({ programAddress: PROGRAM, marketId: market.marketId,
        seats: market.seats, reviewer: reviewers[0], ...fingerprint });
      watched.add(reproposed.proposal);
      await execute("VOID reproposal uses a fresh immutable sequence", [reproposed.instruction]);
    }
    const approved = await buildApproveResolutionInstruction({ programAddress: PROGRAM, marketId: market.marketId,
      seats: market.seats, reviewer: reviewers[1], expected: fingerprint });
    await execute(`independent reviewer approves ${market.outcome}`, [approved.instruction]);
    const resolved = await state(market);
    assert.equal(resolved.resolution.phase, 3);
    assert.equal(resolved.resolution.outcome, { YES: 0, NO: 1, VOID: 2 }[market.outcome]);
    fingerprints.set(market.marketId, fingerprint);
    await place(market, 3, orderInput("BUY", "YES", 30_000n, 1n), { code: 7002 });
  }

  for (const market of markets) {
    const before = await state(market);
    const finalizeEarly = await buildFinalizeResolutionInstruction({ programAddress: PROGRAM, marketId: market.marketId,
      seats: market.seats, keeper: admin });
    await execute(`finalize ${market.outcome} blocked while claims remain`, [finalizeEarly.instruction], { code: 7420 });
    const expectedPayouts = market.outcome === "YES" ? [before.rows[0].yes * market.payout, 0n]
      : market.outcome === "NO" ? [0n, before.rows[1].no * market.payout]
      : [market.payout * before.rows[0].yes / 2n, market.payout * before.rows[1].no / 2n];
    for (const seatIndex of [0, 1]) {
      const claim = await buildClaimResolutionInstruction({ programAddress: PROGRAM, marketId: market.marketId,
        seats: market.seats, payer: admin, seatIndex });
      watched.add(claim.receipt);
      const sent = await execute(`permissionless ${market.outcome} claim seat${seatIndex}`, [claim.instruction]);
      const after = await state(market);
      assert.equal(after.rows[seatIndex].yes, 0n); assert.equal(after.rows[seatIndex].no, 0n);
      assert.equal(after.rows[seatIndex].available - before.rows[seatIndex].available, expectedPayouts[seatIndex]);
      if (seatIndex === 0) {
        await awaitFinalized(sent.signature);
        const phaseThree = await state(market, "finalized");
        const verified = await Promise.all([0, 1].map(index => readGooseyEscrow(runtime,
          { marketId: market.marketId, wallet: actors[index].address }, { includeResolution: true })));
        verified.forEach((snapshot, index) => {
          const row = phaseThree.rows[index];
          assert.equal(snapshot.finalizedSlot >= BigInt(sent.receipt.slot), true);
          assert.equal(snapshot.registered, true);
          assert.equal(snapshot.wallet, actors[index].address);
          assert.equal(snapshot.resolution?.phase, 3);
          assert.equal(snapshot.resolution?.outcome, { YES: 0, NO: 1, VOID: 2 }[market.outcome]);
          assert.equal(snapshot.resolution?.outstandingYes, phaseThree.resolution.outstandingYes);
          assert.equal(snapshot.resolution?.outstandingNo, phaseThree.resolution.outstandingNo);
          assert.equal(snapshot.marketState.collateral, phaseThree.collateral);
          assert.equal(snapshot.marketState.feeRevenue, phaseThree.fees);
          assert.equal(snapshot.seat?.availableCash, row.available);
          assert.equal(snapshot.seat?.yes, row.yes);
          assert.equal(snapshot.seat?.no, row.no);
          assert.equal(snapshot.orderBook?.orders.length, 0);
          assert.equal(snapshot.orderBook?.reservesReconciled, true);
          assert.equal(snapshot.vaultSurplus, 0n);
        });
        phaseThreeReaderEvidence.push({ marketId: market.marketId, outcome: market.outcome,
          exactFinalizedSignature: sent.signature, minimumSlot: sent.receipt.slot,
          outstandingYes: phaseThree.resolution.outstandingYes,
          outstandingNo: phaseThree.resolution.outstandingNo,
          collateral: phaseThree.collateral,
          available: phaseThree.rows.slice(0, 2).map(row => row.available),
          finalizedSlots: verified.map(snapshot => snapshot.finalizedSlot) });
        const replayBefore = await accounts([...watched]);
        await sent.send();
        assert.deepEqual(await accounts([...watched]), replayBefore, "identical signed claim replay changed state");
        await execute(`fresh ${market.outcome} claim replay rejected`, [claim.instruction], {});
      }
    }
    const beforeFinalize = await state(market);
    const finalized = await buildFinalizeResolutionInstruction({ programAddress: PROGRAM, marketId: market.marketId,
      seats: market.seats, keeper: admin });
    const receipt = await execute(`finalize ${market.outcome} lifecycle`, [finalized.instruction]);
    const after = await state(market);
    assert.equal(after.resolution.phase, 4);
    assert.equal(after.collateral, 0n);
    const expectedDust = market.outcome === "VOID" ? 1n : 0n;
    assert.equal(after.fees - beforeFinalize.fees, expectedDust);
    assert.equal(after.accounted, beforeFinalize.accounted);
    if (market.outcome === "VOID") assert.equal(market.payout % 2n, 1n);
    await awaitFinalized(receipt.signature);
    const verified = await Promise.all([0, 1].map(index => readGooseyEscrow(runtime,
      { marketId: market.marketId, wallet: actors[index].address }, { includeResolution: true })));
    verified.forEach((snapshot, index) => {
      assert(snapshot.finalizedSlot > 0n);
      assert.equal(snapshot.registered, true);
      assert.equal(snapshot.wallet, actors[index].address);
      assert.equal(snapshot.market, market.market);
      assert.equal(snapshot.seats, market.seats);
      assert.equal(snapshot.vault, market.vault);
      assert.equal(snapshot.resolution?.phase, 4);
      assert.equal(snapshot.resolution?.outcome, { YES: 0, NO: 1, VOID: 2 }[market.outcome]);
      assert.equal(snapshot.resolution?.outstandingYes, 0n);
      assert.equal(snapshot.resolution?.outstandingNo, 0n);
      assert.equal(snapshot.orderBook?.orders.length, 0);
      assert.equal(snapshot.orderBook?.reservesReconciled, true);
      assert.equal(snapshot.marketState.collateral, 0n);
      assert.equal(snapshot.vaultSurplus, 0n);
    });
  }

  const withdrawMarket = markets[0];
  const beforeWithdraw = await state(withdrawMarket, "finalized");
  const walletBefore = getTokenDecoder().decode(bytes((await accounts([walletTokens[0]], "finalized"))[0])).amount;
  const amount = beforeWithdraw.rows[0].available;
  assert(amount > 0n);
  const withdrawal = await buildWithdrawInstruction({ programAddress: PROGRAM, marketId: withdrawMarket.marketId,
    wallet: actors[0], seats: withdrawMarket.seats, amount, expectedNonce: beforeWithdraw.rows[0].nonce });
  const withdrawalReceipt = await execute("resolved winner withdraws real SPL feathers", [withdrawal.instruction]);
  await awaitFinalized(withdrawalReceipt.signature);
  const afterWithdraw = await state(withdrawMarket, "finalized");
  const walletAfter = getTokenDecoder().decode(bytes((await accounts([walletTokens[0]], "finalized"))[0])).amount;
  assert.equal(afterWithdraw.rows[0].available, 0n);
  assert.equal(beforeWithdraw.accounted - afterWithdraw.accounted, amount);
  assert.equal(beforeWithdraw.vault.amount - afterWithdraw.vault.amount, amount);
  assert.equal(walletAfter - walletBefore, amount);

  const conservationAccounts = await accounts([...walletTokens, ...markets.map(market => market.vault), base.featherMint], "finalized");
  const tokenTotal = conservationAccounts.slice(0, -1).reduce((sum, account) =>
    sum + getTokenDecoder().decode(bytes(account)).amount, 0n);
  const mint = getMintDecoder().decode(bytes(conservationAccounts.at(-1)));
  assert.equal(mint.supply, 4n * GRANT);
  assert.equal(tokenTotal, mint.supply, "wallet plus escrow-vault SPL balances must conserve the complete mint supply");

  console.log(JSON.stringify({ result: "PASS", scope: "Actual compiled-program YES/NO/VOID resolution RPC lifecycle",
    rpc: endpoint.toString(), genesis, program: PROGRAM, validator: await rpc("getVersion"),
    transactionCaseCount: receipts.length, finalizedSignature: withdrawalReceipt.signature,
    funding: "authorized grants -> wallet claims -> wallet-signed deposits -> actual CLOB fills",
    checks: ["mandatory pre-trade resolution", "canonical post-close cleanup",
      ...(earlyResolutionTimingChecked ? ["pre-resolvesAt rejection"] : []), "frozen two-person review",
      "immutable evidence fingerprints", "rejection/new sequence", "YES/NO/VOID payouts", "claim replay resistance",
      "odd VOID dust to fee revenue", "failed-transition rollback", "resolved trading rejection", "SPL withdrawal and total conservation"],
    earlyResolutionTimingChecked, phaseThreeReaderEvidence, fingerprints: [...fingerprints.entries()], receipts },
  (_, value: unknown) => typeof value === "bigint" ? value.toString() : value, 2));
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "Resolution RPC suite failed");
  process.exitCode = 1;
});
