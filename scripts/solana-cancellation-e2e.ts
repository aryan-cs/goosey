/** Real RPC cancellation/cleanup suite. No account injection, synthetic positions,
 * wallet reuse, shared-validator reset or validator lifecycle management.
 * All successful operations use shipping program/escrow/exchange builders.
 * Launch with solana-program-e2e-isolated.ts --suite cancellation. */
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { readFile, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { address, appendTransactionMessageInstructions, blockhash, createKeyPairSignerFromBytes,
  createTransactionMessage, generateKeyPairSigner, getAddressDecoder, getAddressEncoder,
  getBase64EncodedWireTransaction, getSignatureFromTransaction, pipe, setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash, signTransactionMessageWithSigners,
  type Address, type Instruction } from "@solana/kit";
import { getMintDecoder, getTokenDecoder, TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";
import { getTransferSolInstruction } from "@solana-program/system";
import { deriveGooseyProgramAddresses, buildInitializeInstruction, buildAuthorizeEnrollmentInstruction,
  buildClaimFeathersInstructions } from "../src/lib/solana/program-client";
import { buildCreateMarketInstructions, buildRegisterSeatInstruction, buildDepositInstruction } from "../src/lib/solana/escrow-client";
import { buildBookSetupInstruction, deriveGooseyBookAddress, buildPlaceOrderInstruction,
  buildCancelOrderInstruction, buildCleanupOrderInstruction, type ChainOrderInput,
  type ChainOrderTarget, GOOSEY_BOOK_BYTES } from "../src/lib/solana/exchange-client";
import { readCanonicalOrderBook } from "../src/lib/solana/order-book-read";
import { buildInitializeResolutionInstruction } from "../src/lib/solana/resolution-client";
import { encodeMarketTerms, hashMarketTerms, verifyMarketTerms, type MarketTerms } from "../src/lib/solana/market-terms";
import { buildInitializeMarketTermsInstruction, buildAcceptMarketTermsInstruction, buildSealMarketTermsInstruction,
  readMarketTermsAccount } from "../src/lib/solana/market-terms-client";
import { prepareCancelOrder } from "../src/lib/solana/prepare-cancel";
import { submitSignedWalletTransaction, type TransferSubmission } from "../src/lib/solana/submit-transfer";

const PROGRAM = address("CgEGAD3EGLm63YaSx58sRiNPQmmxg8RqvqcxE3xThX8Q");
const LOADER = address("BPFLoaderUpgradeab1e11111111111111111111111");
const CLOCK = address("SysvarC1ock11111111111111111111111111111111");
const GRANT = 10_000_000n, PAYOUT = 100_000n, FEE = 1;
const keyBytes = (key: Address) => Buffer.from(getAddressEncoder().encode(key));
const disc = (space: string, name: string) => createHash("sha256").update(`${space}:${name}`).digest().subarray(0, 8);
type Account = { data: [string, string]; owner: Address; executable: boolean; lamports: number };
type Context<T> = { context: { slot: number }; value: T };
type Receipt = { slot: number; meta: { err: unknown; computeUnitsConsumed?: number; logMessages: string[] | null } };
type ErrorCase = { code: number; index?: number };
type Order = { id: bigint; slot: number; owner: number; price: bigint; quantity: bigint; chain: bigint;
  side: "BID" | "ASK"; heapIndex: number; action: "BUY" | "SELL"; outcome: "YES" | "NO" };

async function main() {
  if (process.argv.includes("--help")) {
    console.log(`Actual cancellation RPC suite. Preferred launch:
GOOSEY_SOLANA_BIN_DIR=/path/to/bin node --import tsx scripts/solana-program-e2e-isolated.ts --suite cancellation
Direct use requires GOOSEY_SOLANA_RPC_URL (literal loopback), GOOSEY_SOLANA_GENESIS_HASH,
GOOSEY_SOLANA_TEST_ADMIN_KEYPAIR=/tmp/goosey-solana-<run>/goosey-admin-keypair.json.
Requires a fresh ledger, uninitialized compiled program, matching disposable upgrade
authority funded by isolated-validator --mint. Refuses shared ports 18999/24999/8080.
No existing wallets, key output, public networks, data injection or validator reset.
Tests shipping cancellation/cleanup builders, true grants/deposits/fills, exact
refunds, authorization, expiry/close, slot reuse, replay and transaction rollback.`);
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
    const result = await response.json() as { result: T; error?: unknown };
    assert(!result.error, `${method}: ${JSON.stringify(result.error)}`); return result.result;
  }
  const pin = async () => assert.equal(await rpc("getGenesisHash"), genesis, "Genesis changed; no writes allowed");
  const accounts = async (keys: readonly Address[], commitment = "confirmed") =>
    (await rpc<Context<(Account | null)[]>>("getMultipleAccounts", [keys, { encoding: "base64", commitment }])).value;
  const bytes = (a: Account | null | undefined) => { assert(a); return Buffer.from(a.data[0], "base64"); };
  const time = async () => bytes((await accounts([CLOCK]))[0]).readBigInt64LE(32);
  await pin();
  const base = await deriveGooseyProgramAddresses(PROGRAM);
  const [program, programData, config] = await accounts([PROGRAM, base.programData, base.config]);
  assert(program?.executable && program.owner === LOADER && programData?.owner === LOADER);
  assert.equal(bytes(program).readUInt32LE(0), 2);
  assert.equal(getAddressDecoder().decode(bytes(program).subarray(4, 36)), base.programData);
  assert.equal(bytes(programData).readUInt32LE(0), 3); assert.equal(bytes(programData)[12], 1);
  assert.equal(config, null, "Existing config refused; use fresh isolated ledger, never reset shared state");
  const raw: unknown = JSON.parse(await readFile(adminPath, "utf8"));
  assert(Array.isArray(raw) && raw.length === 64 && raw.every(n => Number.isInteger(n) && n >= 0 && n <= 255));
  const secret = Uint8Array.from(raw), admin = await createKeyPairSignerFromBytes(secret); secret.fill(0); raw.fill(0);
  assert.equal(getAddressDecoder().decode(bytes(programData).subarray(13, 45)), admin.address, "Wrong deployment authority");
  assert((await rpc<Context<number>>("getBalance", [admin.address])).value >= 5_000_000_000);
  const watched = new Set<Address>([base.config, base.featherMint]);
  const receipts: Record<string, unknown>[] = [];
  let serial = 0;
  async function execute(name: string, instructions: readonly Instruction[], expected?: ErrorCase) {
    await pin();
    const keys = [...watched], before = expected ? await accounts(keys) : null;
    const lifetime = (await rpc<Context<{ blockhash: string; lastValidBlockHeight: number }>>("getLatestBlockhash", [{ commitment: "confirmed" }])).value;
    // Unique bounded compute limit avoids accidentally replaying a prior test's
    // identical message; actual replay below intentionally resends identical bytes.
    const b = Buffer.alloc(5); b[0] = 2; b.writeUInt32LE(1_400_000 - ++serial, 1);
    const budget: Instruction = { programAddress: address("ComputeBudget111111111111111111111111111111"), data: b };
    const message = pipe(createTransactionMessage({ version: 0 }), tx => setTransactionMessageFeePayerSigner(admin, tx),
      tx => setTransactionMessageLifetimeUsingBlockhash({ blockhash: blockhash(lifetime.blockhash), lastValidBlockHeight: BigInt(lifetime.lastValidBlockHeight) }, tx),
      tx => appendTransactionMessageInstructions([budget, ...instructions], tx));
    const signed = await signTransactionMessageWithSigners(message), signature = getSignatureFromTransaction(signed);
    const wire = getBase64EncodedWireTransaction(signed);
    const send = async () => { await pin(); assert.equal(await rpc("sendTransaction", [wire, { encoding: "base64", skipPreflight: true, maxRetries: 5 }]), signature); };
    await send();
    const deadline = Date.now() + 60_000; let resent = Date.now(); let receipt: Receipt | null = null;
    while (Date.now() < deadline) {
      receipt = await rpc("getTransaction", [signature, { commitment: "confirmed", maxSupportedTransactionVersion: 0 }]);
      if (receipt?.meta) break;
      if (Date.now() - resent > 1_000) { await send(); resent = Date.now(); }
      await delay(150);
    }
    assert(receipt?.meta, `Unknown transaction outcome: ${signature}`);
    const logs = receipt.meta.logMessages ?? [];
    assert(logs.some(l => l.startsWith(`Program ${instructions[0].programAddress} invoke`)), "No actual invocation");
    const error = expected ? { InstructionError: [(expected.index ?? 0) + 1, { Custom: expected.code }] } : null;
    assert.deepEqual(receipt.meta.err, error, `${name}: ${logs.join("\n")}`);
    if (expected) assert.deepEqual(await accounts(keys), before, `${name}: transaction failed to roll back economic account bytes`);
    assert(Number.isInteger(receipt.meta.computeUnitsConsumed));
    receipts.push({ name, signature, slot: receipt.slot, error, cu: receipt.meta.computeUnitsConsumed });
    console.log(`PASS ${name}: ${signature} (${receipt.meta.computeUnitsConsumed} CU)`);
    return { signature, receipt, logs, send };
  }
  const initialized = await buildInitializeInstruction({ programAddress: PROGRAM, admin, environment: 1,
    genesisDomain: createHash("sha256").update(genesis).digest(), enrollmentAuthority: admin.address,
    perWalletCap: GRANT, campaignCap: 4n * GRANT + 2n });
  await execute("initialize actual program/mint", [initialized.instruction]);
  const actors = await Promise.all(Array.from({ length: 4 }, () => generateKeyPairSigner()));
  await execute("fund disposable wallet rent", actors.map(wallet => getTransferSolInstruction({ source: admin,
    destination: wallet.address, amount: 1_000_000_000n })));
  const walletTokens: Address[] = [];
  for (const [i, wallet] of actors.entries()) {
    const grant = await buildAuthorizeEnrollmentInstruction({ programAddress: PROGRAM, enrollmentAuthority: admin,
      wallet: wallet.address, identityDigest: randomBytes(32), allowance: GRANT, expiresAt: (await time()) + 900n });
    await execute(`authorize grant ${i}`, [grant.instruction]);
    const claim = await buildClaimFeathersInstructions({ programAddress: PROGRAM, wallet, payer: admin, createAta: true });
    await execute(`mint real feathers to signing wallet ${i}`, claim.instructions);
    walletTokens.push(claim.walletTokens); watched.add(claim.walletTokens); watched.add(claim.enrollment); watched.add(grant.identity);
    assert.equal(getTokenDecoder().decode(bytes((await accounts([claim.walletTokens]))[0])).amount, GRANT);
  }
  const reviewers = await Promise.all([generateKeyPairSigner(), generateKeyPairSigner()]);
  const reviewerEnrollments: Address[] = [];
  const termsEvidence: Record<string, unknown>[] = [];
  const verifyFinalTerms: (() => Promise<void>)[] = [];
  let admissionCases = 0;
  async function admissionCase(name: string, instructions: readonly Instruction[], expected?: ErrorCase) {
    await execute(name, instructions, expected); admissionCases++;
  }
  assert.equal(new Set([admin.address, ...actors.map(a => a.address), ...reviewers.map(r => r.address)]).size, 7);
  for (const [i, reviewer] of reviewers.entries()) {
    const grant = await buildAuthorizeEnrollmentInstruction({ programAddress: PROGRAM, enrollmentAuthority: admin,
      wallet: reviewer.address, identityDigest: randomBytes(32), allowance: 1n, expiresAt: (await time()) + 900n });
    await execute(`enroll independent reviewer ${i} without token claim`, [grant.instruction]);
    watched.add(grant.enrollment); watched.add(grant.identity);
    reviewerEnrollments.push(grant.enrollment);
  }
  type Market = { marketId: bigint; market: Address; seats: Address; vault: Address; book: Address; closesAt: bigint; terms: Address };
  async function createMarket(marketId: bigint, duration: bigint): Promise<Market> {
    const closesAt = (await time()) + duration;
    const created = await buildCreateMarketInstructions({ programAddress: PROGRAM, marketId, admin, seats: await generateKeyPairSigner(),
      seatsRentLamports: BigInt(await rpc<number>("getMinimumBalanceForRentExemption", [32_816])),
      payoutMilli: PAYOUT, feeBps: FEE, closesAt, resolvesAt: closesAt });
    await execute(`create market ${marketId} and real SPL vault`, created.instructions);
    const { book } = await deriveGooseyBookAddress(PROGRAM, created.market);
    for (const key of [created.market, created.seats, created.vault, book]) watched.add(key);
    const m = { ...created, marketId, closesAt, book };
    for (const [i, wallet] of actors.entries()) {
      const seat = await buildRegisterSeatInstruction({ programAddress: PROGRAM, marketId,
        wallet, rentPayer: admin, seats: m.seats });
      await execute(`register market${marketId} seat${i}`, [seat.instruction]); watched.add(seat.locator);
      const deposit = await buildDepositInstruction({ programAddress: PROGRAM, marketId, wallet, seats: m.seats,
        amount: marketId === 1n ? 5_000_000n : 1_000_000n, expectedNonce: 0n });
      await execute(`deposit actual feathers market${marketId} seat${i}`, [deposit.instruction]);
    }
    const setup = async (step: Parameters<typeof buildBookSetupInstruction>[0]["step"]) =>
      (await buildBookSetupInstruction({ programAddress: PROGRAM, marketId, admin, step })).instruction;
    await execute(`create canonical book ${marketId}`, [await setup({ kind: "create" })]);
    for (;;) {
      const size = bytes((await accounts([book]))[0]).length;
      if (size === GOOSEY_BOOK_BYTES) break;
      await execute(`grow canonical book ${marketId} from observed ${size}`, [await setup({ kind: "grow", expectedSize: size })]);
    }
    await execute(`finalize canonical book ${marketId}`, [await setup({ kind: "finalize" })]);
    const resolution = await buildInitializeResolutionInstruction({ programAddress: PROGRAM, marketId, seats: m.seats,
      creator: admin, proposer: reviewers[0].address, approver: reviewers[1].address });
    watched.add(resolution.resolution);
    if (marketId === 1n) await admissionCase("missing terms cannot initialize resolution", [resolution.instruction], { code: 3012 });
    // Terms describe this disposable ledger only, never a production event.
    // Read actual market/config/reviewer bindings, then retain the exact canonical
    // bytes separately from the on-chain content commitment.
    const [chainMarket, chainConfig, ...chainReviewers] = await accounts([m.market, base.config, ...reviewerEnrollments]);
    assert.equal(chainMarket?.owner, PROGRAM); assert.equal(chainConfig?.owner, PROGRAM);
    const marketBytes = bytes(chainMarket), configBytes = bytes(chainConfig);
    assert.deepEqual(marketBytes.subarray(0, 8), disc("account", "Market"));
    assert.deepEqual(configBytes.subarray(0, 8), disc("account", "Config"));
    const keyAt = (data: Buffer, offset: number) => getAddressDecoder().decode(data.subarray(offset, offset + 32));
    assert.equal(keyAt(marketBytes, 8), base.config); assert.equal(keyAt(marketBytes, 40), admin.address);
    assert.equal(keyAt(marketBytes, 72), m.seats); assert.equal(keyAt(configBytes, 108), base.featherMint);
    assert.equal(marketBytes.readBigUInt64LE(136), marketId);
    assert.equal(marketBytes.readBigUInt64LE(144), PAYOUT); assert.equal(marketBytes.readUInt16LE(192), FEE);
    assert.equal(marketBytes.readBigInt64LE(152), closesAt);
    const pairs = chainReviewers.map((account, i) => {
      assert.equal(account?.owner, PROGRAM); const data = bytes(account);
      assert.deepEqual(data.subarray(0, 8), disc("account", "Enrollment"));
      assert.equal(keyAt(data, 8), base.config); assert.equal(keyAt(data, 40), reviewers[i].address);
      assert.equal(data.readBigUInt64LE(104), 1n); assert.equal(data.readBigUInt64LE(112), 0n);
      return { wallet: keyAt(data, 40), enrollment: reviewerEnrollments[i] };
    });
    const binding = { cluster: "localnet" as const, genesisHash: genesis!, program: PROGRAM, config: keyAt(marketBytes, 8),
      market: m.market, marketId: marketBytes.readBigUInt64LE(136).toString(), creator: keyAt(marketBytes, 40), featherMint: keyAt(configBytes, 108) };
    const economics = { payoutMilli: marketBytes.readBigUInt64LE(144).toString(), feeBps: marketBytes.readUInt16LE(192).toString(),
      closesAt: marketBytes.readBigInt64LE(152).toString(), resolvesAt: marketBytes.readBigInt64LE(160).toString(), decimals: 3 as const };
    const manifest: MarketTerms = { version: 1, binding,
      question: "TEST ONLY: Is this disposable market's order book empty at the first finalized bank at or after its close timestamp?",
      rules: { yes: "YES if the canonical order book has zero live orders in that bank.",
        no: "NO if the canonical order book has one or more live orders in that bank.",
        void: "VOID only if the designated bank's canonical market, book, or Clock data cannot be recovered and verified against this genesis." },
      observation: { startsAt: economics.closesAt, endsAt: economics.resolvesAt, timezone: "UTC" },
      sources: [{ id: "isolated-bank", uri: "https://solana.com/docs/rpc/http/getmultipleaccounts",
        selection: "Method specification only, not hosted event evidence. Evidence is the canonical market, order book and Clock from the pinned disposable validator. This cancellation suite does not propose or approve outcomes.", snapshotSha256: null }],
      sourcePolicy: { priority: "array-order-first-authoritative", missing: "Recover the designated finalized bank from this test ledger; if irrecoverable, reviewers may apply the stated VOID criterion.",
        revisions: "Use the designated finalized bank only; later cleanup transactions do not revise that observation." },
      economics, oracle: { kind: "two-reviewer-no-fallback-v1", proposer: pairs[0], approver: pairs[1],
        unavailable: "wait-for-designated-reviewers", replacement: "none", automaticVoid: false } };
    const manifestBytes = encodeMarketTerms(manifest), digestHex = await hashMarketTerms(manifestBytes), digest = Buffer.from(digestHex, "hex");
    const manifestPath = path.join(path.dirname(adminPath), `market-${marketId}-terms.json`);
    await writeFile(manifestPath, manifestBytes, { flag: "wx", mode: 0o600 });
    const termsInit = await buildInitializeMarketTermsInstruction({ programAddress: PROGRAM, marketId, seats: m.seats,
      creator: admin, proposer: reviewers[0].address, approver: reviewers[1].address, version: 1, digest, manifestLength: manifestBytes.length });
    assert.equal(termsInit.market, m.market); assert.equal(termsInit.book, m.book);
    assert.equal(termsInit.proposerEnrollment, pairs[0].enrollment); assert.equal(termsInit.approverEnrollment, pairs[1].enrollment);
    await execute(`initialize canonical test-only terms ${marketId}`, [termsInit.instruction]);
    watched.add(termsInit.terms);
    const verifyTermsState = async (acceptanceBits: number, sealed: boolean, commitment = "confirmed") => {
      const account = (await accounts([termsInit.terms], commitment))[0]; assert(account);
      const state = await readMarketTermsAccount({ programAddress: PROGRAM, marketId, config: base.config, market: m.market,
        creator: admin.address, proposer: pairs[0], approver: pairs[1] },
      { address: termsInit.terms, owner: account.owner, executable: account.executable, data: bytes(account) });
      assert.equal(state.acceptanceBits, acceptanceBits); assert.equal(state.sealed, sealed);
      assert.deepEqual(Buffer.from(state.digest), digest); assert.equal(state.manifestLength, manifestBytes.length);
      return state;
    };
    await verifyTermsState(0, false);
    if (marketId === 1n) {
      await admissionCase("unsealed terms cannot initialize resolution", [resolution.instruction], { code: 7600 });
      const wrongDigest = Buffer.from(digest); wrongDigest[0] ^= 1;
      const wrongAcceptance = await buildAcceptMarketTermsInstruction({ programAddress: PROGRAM, marketId, seats: m.seats,
        reviewer: reviewers[0], expectedDigest: wrongDigest });
      await admissionCase("reviewer cannot accept a different manifest digest", [wrongAcceptance.instruction], { code: 7608 });
      await verifyTermsState(0, false);
    }
    for (const [i, reviewer] of reviewers.entries()) {
      // Each reviewer retrieves and verifies retained exact bytes before signing
      // its own acceptance; admin is only the transaction fee payer.
      const retrieved = new Uint8Array(await readFile(manifestPath));
      await verifyMarketTerms(retrieved, { digest: digestHex, binding, economics, proposer: pairs[0], approver: pairs[1] });
      const accept = await buildAcceptMarketTermsInstruction({ programAddress: PROGRAM, marketId, seats: m.seats,
        reviewer, expectedDigest: digest });
      assert.equal(accept.instruction.accounts[0].address, reviewer.address);
      await execute(`reviewer ${i} signs exact terms digest ${marketId}`, [accept.instruction]);
      await verifyTermsState(i === 0 ? 1 : 3, false);
    }
    const seal = await buildSealMarketTermsInstruction({ programAddress: PROGRAM, marketId, seats: m.seats,
      creator: admin, expectedDigest: digest });
    const sealed = await execute(`creator seals independently accepted terms ${marketId}`, [seal.instruction]);
    await verifyTermsState(3, true);
    termsEvidence.push({ marketId, terms: termsInit.terms, digest: digestHex, manifestLength: manifestBytes.length,
      manifestPath, sealSignature: sealed.signature });
    verifyFinalTerms.push(async () => { await verifyTermsState(3, true, "finalized"); });
    assert.equal(resolution.instruction.accounts[9].address, termsInit.terms, "Resolution terms ABI index changed");
    if (marketId === 2n) {
      const foreignTerms = termsEvidence[0].terms as Address;
      await admissionCase("foreign sealed terms cannot initialize another resolution", [{ ...resolution.instruction,
        accounts: resolution.instruction.accounts.map((meta, i) => i === 9 ? { ...meta, address: foreignTerms } : meta) }], { code: 2006 });
    }
    await execute(`initialize independent two-person resolution before first trade ${marketId}`, [resolution.instruction]);
    if (marketId === 2n) {
      const proposed = await buildPlaceOrderInstruction({ programAddress: PROGRAM, marketId, seats: m.seats, wallet: actors[0],
        expectedNonce: 1n, action: "BUY", outcome: "YES", price: 1n, quantity: 1n, timeInForce: "GTC", selfTrade: "CANCEL_AGGRESSOR", touches: 16 });
      await admissionCase("foreign sealed terms cannot admit an order", [{ ...proposed.instruction,
        accounts: proposed.instruction.accounts.map((meta, i) => i === 8 ? { ...meta, address: termsEvidence[0].terms as Address } : meta) }], { code: 2006 });
    }
    if (marketId === 1n) {
      // Register real, zero-funded reviewer seats to reach the reviewer admission
      // guard (not an earlier missing-locator failure). No feathers are claimed.
      await admissionCase("fund reviewer locator rent only", reviewers.map(reviewer => getTransferSolInstruction({
        source: admin, destination: reviewer.address, amount: 10_000_000n })));
      for (const [i, reviewer] of reviewers.entries()) {
        const seat = await buildRegisterSeatInstruction({ programAddress: PROGRAM, marketId,
          wallet: reviewer, rentPayer: admin, seats: m.seats });
        await admissionCase(`register zero-position reviewer seat ${i}`, [seat.instruction]); watched.add(seat.locator);
        const order = await buildPlaceOrderInstruction({ programAddress: PROGRAM, marketId, seats: m.seats, wallet: reviewer,
          expectedNonce: 0n, action: "BUY", outcome: "YES", price: 1n, quantity: 1n, timeInForce: "GTC", selfTrade: "CANCEL_AGGRESSOR", touches: 16 });
        await admissionCase(`designated reviewer ${i} cannot trade after sealing`, [order.instruction], { code: 7613 });
      }
    }
    return { ...m, terms: termsInit.terms };
  }
  async function state(m: Market, commitment = "confirmed") {
    const raw = await accounts([m.market, m.seats, m.book, m.vault, base.featherMint, ...walletTokens], commitment);
    const [market, seats, book, vault, mint, ...wallets] = raw;
    for (const a of [market, seats, book]) assert.equal(a?.owner, PROGRAM);
    for (const a of [vault, mint, ...wallets]) assert.equal(a?.owner, TOKEN_PROGRAM_ADDRESS);
    const md = bytes(market), sd = bytes(seats), bd = bytes(book);
    assert.equal(bd.length, GOOSEY_BOOK_BYTES); assert.equal(bd.subarray(0, 8).toString(), "GOOSEYB1");
    assert.deepEqual(bd.subarray(8, 40), keyBytes(m.market));
    const rows = actors.map((wallet, i) => {
      const o = 48 + i * 128; assert.deepEqual(sd.subarray(o, o + 32), keyBytes(wallet.address));
      return { available: sd.readBigUInt64LE(o + 64), reserved: sd.readBigUInt64LE(o + 72), yes: sd.readBigUInt64LE(o + 80),
        no: sd.readBigUInt64LE(o + 88), reservedYes: sd.readBigUInt64LE(o + 96), reservedNo: sd.readBigUInt64LE(o + 104),
        nonce: sd.readBigUInt64LE(o + 112), ever: sd[o + 120] };
    });
    const orders: Order[] = [];
    for (const [side, offset, count] of [["BID", 65_624, bd.readUInt16LE(74)], ["ASK", 67_672, bd.readUInt16LE(76)]] as const) {
      for (let h = 0; h < count; h++) {
        const slot = bd.readUInt16LE(offset + h * 2), o = 88 + slot * 64, flags = bd.readUInt16LE(o + 56);
        assert(slot < 1024 && flags & 1);
        orders.push({ id: bd.readBigUInt64LE(o), slot, owner: Number(bd.readBigUInt64LE(o + 8)), price: bd.readBigUInt64LE(o + 16),
          quantity: bd.readBigUInt64LE(o + 24), chain: bd.readBigUInt64LE(o + 48), side, heapIndex: h,
          outcome: flags & 2 ? "NO" : "YES", action: flags & 4 ? "SELL" : "BUY" });
      }
    }
    const expected = rows.map(() => ({ cash: 0n, yes: 0n, no: 0n }));
    const fee = (n: bigint) => (n * BigInt(FEE) + 9_999n) / 10_000n;
    for (const o of orders) {
      const r = expected[o.owner]; assert(r);
      if (o.action === "BUY") { const n = o.price * o.quantity; r.cash += n + fee(o.chain + n) - fee(o.chain); }
      else if (o.outcome === "YES") r.yes += o.quantity; else r.no += o.quantity;
    }
    rows.forEach((s, i) => assert.deepEqual([s.reserved, s.reservedYes, s.reservedNo], [expected[i].cash, expected[i].yes, expected[i].no]));
    const accounted = md.readBigUInt64LE(168), collateral = md.readBigUInt64LE(176), fees = md.readBigUInt64LE(184);
    assert.equal(rows.reduce((n, s) => n + s.available + s.reserved, 0n) + collateral + fees, accounted);
    assert.equal(rows.reduce((n, s) => n + s.yes, 0n) * PAYOUT, collateral);
    assert.equal(rows.reduce((n, s) => n + s.no, 0n) * PAYOUT, collateral);
    const v = getTokenDecoder().decode(bytes(vault)); assert.equal(v.amount, accounted);
    assert.equal(v.owner, m.market); assert.equal(v.mint, base.featherMint);
    const mintData = getMintDecoder().decode(bytes(mint)); assert.equal(mintData.decimals, 3); assert.equal(mintData.supply, 4n * GRANT);
    assert.equal(orders.length, bd.readUInt16LE(78));
    return { rows, orders, accounted, collateral, fees, bd, raw, revision: bd.readBigUInt64LE(56), nextSequence: bd.readBigUInt64LE(64) };
  }
  const orderInput = (action: "BUY" | "SELL", outcome: "YES" | "NO", price: bigint, quantity: bigint,
    timeInForce: "GTC" | "IOC" | "FOK" = "GTC") => ({ action, outcome, price, quantity, timeInForce, selfTrade: "CANCEL_AGGRESSOR" as const });
  async function place(m: Market, owner: number, input: Pick<ChainOrderInput, "action" | "outcome" | "price" | "quantity" | "timeInForce" | "selfTrade"> & { expiresAt?: bigint }) {
    const before = await state(m);
    const built = await buildPlaceOrderInstruction({ programAddress: PROGRAM, marketId: m.marketId, seats: m.seats,
      wallet: actors[owner], expectedNonce: before.rows[owner].nonce, ...input, touches: 16 });
    assert.equal(built.instruction.accounts[8].address, m.terms, "Placement terms ABI index changed");
    await execute(`place real ${input.action} ${input.outcome} owner${owner}`, [built.instruction]); await state(m);
    return before.nextSequence;
  }
  async function target(m: Market, id: bigint): Promise<ChainOrderTarget> {
    const o = (await state(m)).orders.find(o => o.id === id); assert(o, `Missing order ${id}`);
    return { orderId: id, side: o.side, heapIndex: o.heapIndex };
  }
  const cancelIx = async (m: Market, owner: number, t: ChainOrderTarget, nonce: bigint) =>
    (await buildCancelOrderInstruction({ programAddress: PROGRAM, marketId: m.marketId, wallet: actors[owner], seats: m.seats,
      target: t, expectedNonce: nonce })).instruction;
  const cleanupIx = async (m: Market, t: ChainOrderTarget) =>
    (await buildCleanupOrderInstruction({ programAddress: PROGRAM, marketId: m.marketId, seats: m.seats, target: t })).instruction;
  function removedEvent(logs: string[]) {
    const events = logs.filter(l => l.startsWith("Program data: ")).map(l => Buffer.from(l.slice(14), "base64"))
      .filter(b => b.subarray(0, 8).equals(disc("event", "OrderCanceled")));
    assert.equal(events.length, 1);
    const b = events[0]; let o = 8;
    const key = () => { const k = getAddressDecoder().decode(b.subarray(o, o + 32)); o += 32; return k; };
    const n = () => { const v = b.readBigUInt64LE(o); o += 8; return v; };
    const market = key(), wallet = key(), seat = n(), id = n(), reason = b[o++], hasNonce = b[o++];
    assert(hasNonce === 0 || hasNonce === 1);
    const nonce = hasNonce ? n() : null;
    const revision = n(), remaining = n(), chain = n(), cash = n(), yes = n(), no = n(); assert.equal(o, b.length);
    return { market, wallet, seat, id, reason, nonce, revision, remaining, chain, cash, yes, no };
  }
  async function removed(m: Market, owner: number, id: bigint, mode: "owner" | "expired" | "closed") {
    const before = await state(m), t = await target(m, id), prior = before.orders.find(o => o.id === id)!;
    const instruction = mode === "owner" ? await cancelIx(m, owner, t, before.rows[owner].nonce) : await cleanupIx(m, t);
    if (mode !== "owner") assert(instruction.accounts?.every(a => a.address !== actors[owner].address), "Keeper instruction must not require owner wallet");
    const sent = await execute(`${mode} removal order${id}`, [instruction]); const e = removedEvent(sent.logs), after = await state(m);
    assert.equal(e.market, m.market); assert.equal(e.wallet, actors[owner].address); assert.equal(e.id, id);
    assert.equal(e.reason, { owner: 0, expired: 1, closed: 2 }[mode]);
    assert.equal(e.nonce, mode === "owner" ? before.rows[owner].nonce : null);
    assert.equal(e.remaining, prior.quantity); assert.equal(e.chain, prior.chain); assert.equal(e.revision, before.revision + 1n);
    assert.equal(after.nextSequence, before.nextSequence); assert.equal(after.revision, e.revision);
    assert.deepEqual([after.accounted, after.collateral, after.fees], [before.accounted, before.collateral, before.fees]);
    const sorted = (orders: Order[]) => [...orders].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
    assert.deepEqual(sorted(after.orders), sorted(before.orders.filter(o => o.id !== id).map(o => ({ ...o,
      heapIndex: after.orders.find(a => a.id === o.id)!.heapIndex }))), "Unrelated order contents/history changed");
    for (let i = 0; i < actors.length; i++) {
      const a = after.rows[i], b = before.rows[i];
      if (i !== owner) assert.deepEqual(a, b);
      else assert.deepEqual(a, { ...b, available: b.available + e.cash, reserved: b.reserved - e.cash,
        reservedYes: b.reservedYes - e.yes, reservedNo: b.reservedNo - e.no, nonce: b.nonce + (mode === "owner" ? 1n : 0n) });
    }
    return { ...sent, event: e, prior, target: t };
  }
  const m = await createMarket(1n, 600n);
  // All positions originate through collateral-backed complementary buys.
  await place(m, 1, orderInput("BUY", "NO", 60_000n, 8n));
  await place(m, 0, orderInput("BUY", "YES", 40_000n, 8n, "FOK"));
  const wrong = await place(m, 0, orderInput("BUY", "YES", 10_000n, 2n));
  let s = await state(m); const wt = await target(m, wrong);
  await execute("wrong owner cannot cancel", [await cancelIx(m, 1, wt, s.rows[1].nonce)], { code: 7202 });
  await execute("stale signing nonce rejected", [await cancelIx(m, 0, wt, s.rows[0].nonce - 1n)], { code: 7203 });
  await execute("permissionless live cleanup denied", [await cleanupIx(m, wt)], { code: 7204 });
  const canceled = await removed(m, 0, wrong, "owner");
  const replayBefore = await accounts([...watched]); await canceled.send();
  assert.deepEqual(await accounts([...watched]), replayBefore, "Identical signed replay changed accounts");
  await execute("old canceled target cannot replay with fresh transaction", [await cancelIx(m, 0, wt, s.rows[0].nonce)], { code: 7201 });
  const reused = await place(m, 0, orderInput("BUY", "YES", 10_000n, 2n));
  assert.equal((await state(m)).orders.find(o => o.id === reused)!.slot, canceled.prior.slot);
  assert(reused > wrong);
  await execute("recycled slot cannot revive old order ID", [await cancelIx(m, 0, wt, (await state(m)).rows[0].nonce)], { code: 7201 });
  await removed(m, 0, reused, "owner");
  const low = await place(m, 0, orderInput("BUY", "YES", 10_000n, 1n)); const staleHint = await target(m, low);
  const high = await place(m, 0, orderInput("BUY", "YES", 20_000n, 1n));
  assert.notEqual((await target(m, low)).heapIndex, staleHint.heapIndex);
  await execute("intervening heap movement rejects stale hint", [await cancelIx(m, 0, staleHint, (await state(m)).rows[0].nonce)], { code: 7201 });
  await removed(m, 0, low, "owner"); await removed(m, 0, high, "owner");
  const noCash = await place(m, 1, orderInput("BUY", "NO", 10_000n, 3n));
  assert.equal((await removed(m, 1, noCash, "owner")).event.cash, 30_003n);
  const yesShares = await place(m, 0, orderInput("SELL", "YES", 70_000n, 2n));
  assert.equal((await removed(m, 0, yesShares, "owner")).event.yes, 2n);
  const noShares = await place(m, 1, orderInput("SELL", "NO", 70_000n, 2n));
  assert.equal((await removed(m, 1, noShares, "owner")).event.no, 2n);
  await place(m, 0, orderInput("SELL", "YES", 33_333n, 1n));
  const partial = await place(m, 2, orderInput("BUY", "YES", 40_001n, 3n));
  await place(m, 0, orderInput("SELL", "YES", 40_001n, 1n, "FOK"));
  const refund = await removed(m, 2, partial, "owner"); assert.equal(refund.event.cash, 40_005n); assert.equal(refund.event.chain, 73_334n);
  const atomic = await place(m, 0, orderInput("BUY", "YES", 10_000n, 1n)); s = await state(m);
  const twice = await cancelIx(m, 0, await target(m, atomic), s.rows[0].nonce);
  await execute("second cancellation failure rolls back first removal/nonce/refund", [twice, twice], { code: 7201, index: 1 });
  await removed(m, 0, atomic, "owner");
  const expiry = (await time()) + 5n;
  const expiring = await place(m, 1, { ...orderInput("BUY", "NO", 20_000n, 2n), expiresAt: expiry });
  if (await time() < expiry) await execute("not-yet-expired cleanup denied", [await cleanupIx(m, await target(m, expiring))], { code: 7204 });
  const waitUntil = async (timestamp: bigint) => {
    const deadline = Date.now() + 60_000;
    while (await time() < timestamp) { assert(Date.now() < deadline, "Clock failed to reach test boundary"); await delay(200); }
  };
  await waitUntil(expiry); assert(await time() < m.closesAt);
  await removed(m, 1, expiring, "expired");
  const short = await createMarket(2n, 40n);
  await place(short, 1, orderInput("BUY", "NO", 60_000n, 4n));
  await place(short, 0, orderInput("BUY", "YES", 40_000n, 4n, "FOK"));
  const closeIds = [await place(short, 0, orderInput("SELL", "YES", 70_000n, 2n)),
    await place(short, 1, orderInput("SELL", "NO", 70_000n, 2n)),
    await place(short, 2, orderInput("BUY", "YES", 10_000n, 1n))];
  const ownerAfterClose = await place(short, 3, orderInput("BUY", "NO", 10_000n, 1n));
  assert(await time() < short.closesAt, "Setup missed real pre-close boundary; increase isolated test window");
  await execute("unexpired order cannot be cleaned before market close", [await cleanupIx(short, await target(short, closeIds[0]))], { code: 7204 });
  await waitUntil(short.closesAt);
  const beforeClose = await state(short), t = await target(short, closeIds[0]);
  const twiceCleanup = await cleanupIx(short, t);
  await execute("second cleanup failure rolls back first cleanup/refund", [twiceCleanup, twiceCleanup], { code: 7201, index: 1 });
  await removed(short, 3, ownerAfterClose, "owner"); // Owner rights also survive close.
  await removed(short, 0, closeIds[0], "closed"); await removed(short, 1, closeIds[1], "closed");
  const last = await removed(short, 2, closeIds[2], "closed");
  const afterClose = await state(short); assert.equal(afterClose.orders.length, 0);
  assert.deepEqual(afterClose.rows.slice(0, 3).map(r => r.nonce), beforeClose.rows.slice(0, 3).map(r => r.nonce));
  for (const r of afterClose.rows) assert.deepEqual([r.reserved, r.reservedYes, r.reservedNo], [0n, 0n, 0n]);
  // Exact-signature finality gate, then shipping reader over coherent finalized
  // snapshots. Immediate checks above deliberately used confirmed test state.
  async function finalized(signature: string) {
    const deadline = Date.now() + 60_000;
    for (;;) {
      const status = (await rpc<Context<({ confirmationStatus: string; err: unknown } | null)[]>>("getSignatureStatuses", [[signature], { searchTransactionHistory: true }])).value[0];
      if (status?.confirmationStatus === "finalized") { assert.equal(status.err, null); return; }
      assert(Date.now() < deadline, "Exact transaction did not finalize"); await delay(200);
    }
  }
  await finalized(last.signature);
  // Additional high-level path. Preserve the original 88-case baseline above;
  // this is a new wallet-paid, finalized-snapshot preparation/submission case.
  const preparedOrder = await place(m, 3, orderInput("BUY", "YES", 12_345n, 2n));
  await finalized(String(receipts.at(-1)!.signature));
  const runtime = { cluster: "localnet" as const, rpcUrl: endpoint.toString(), genesisHash: genesis, programAddress: PROGRAM };
  const beforePrepared = await state(m, "finalized");
  const prepared = await prepareCancelOrder({ runtime, sender: actors[3], marketId: m.marketId, orderId: preparedOrder });
  assert.equal(prepared.expectedNonce, beforePrepared.rows[3].nonce);
  assert.deepEqual(prepared.target, await target(m, preparedOrder));
  assert.equal(prepared.bookRevision, beforePrepared.revision);
  assert.deepEqual(prepared.observedReserve, { cash: 24_693n, yes: 0n, no: 0n });
  assert.equal(prepared.sender, actors[3].address);
  const signed = await signTransactionMessageWithSigners(prepared.message);
  const signature = getSignatureFromTransaction(signed);
  assert.deepEqual(Object.keys(signed.signatures), [actors[3].address], "Only the user wallet may sign the prepared cancellation");
  const persisted: Omit<TransferSubmission, "status">[] = [];
  const submission = await submitSignedWalletTransaction({ runtime, prepared, signed,
    onPrepared: async receipt => {
      const status = (await rpc<Context<(unknown | null)[]>>("getSignatureStatuses", [[receipt.signature], { searchTransactionHistory: true }])).value[0];
      assert.equal(status, null, "Receipt must persist before first send");
      await writeFile(path.join(path.dirname(adminPath), "prepared-cancel-submission.json"), JSON.stringify(receipt,
        (_, v: unknown) => typeof v === "bigint" ? v.toString() : v), { flag: "wx", mode: 0o600 });
      persisted.push(receipt);
    } });
  assert.equal(persisted.length, 1); assert.equal(submission.signature, signature);
  assert.equal(submission.signedWireBase64, getBase64EncodedWireTransaction(signed));
  assert.equal(submission.lastValidBlockHeight, prepared.lifetime.lastValidBlockHeight);
  assert(["submitted", "unknown"].includes(submission.status));
  const submissionDeadline = Date.now() + 60_000;
  let preparedReceipt: Receipt | null = null; let resentAt = Date.now();
  while (Date.now() < submissionDeadline) {
    preparedReceipt = await rpc("getTransaction", [signature, { commitment: "confirmed", maxSupportedTransactionVersion: 0 }]);
    if (preparedReceipt?.meta) break;
    if (Date.now() - resentAt > 1_000) {
      await pin();
      assert.equal(await rpc("sendTransaction", [persisted[0].signedWireBase64,
        { encoding: "base64", skipPreflight: false, preflightCommitment: "confirmed", maxRetries: 0 }]), signature);
      resentAt = Date.now();
    }
    await delay(200);
  }
  assert(preparedReceipt?.meta); assert.equal(preparedReceipt.meta.err, null, JSON.stringify(preparedReceipt));
  const preparedEvent = removedEvent(preparedReceipt.meta.logMessages ?? []);
  assert.equal(preparedEvent.id, preparedOrder); assert.equal(preparedEvent.reason, 0);
  assert.equal(preparedEvent.nonce, prepared.expectedNonce); assert.equal(preparedEvent.cash, 24_693n);
  const afterPrepared = await state(m);
  assert.equal(afterPrepared.orders.length, 0);
  assert.deepEqual(afterPrepared.rows[3], { ...beforePrepared.rows[3], available: beforePrepared.rows[3].available + 24_693n,
    reserved: beforePrepared.rows[3].reserved - 24_693n, nonce: beforePrepared.rows[3].nonce + 1n });
  assert.deepEqual(afterPrepared.rows.slice(0, 3), beforePrepared.rows.slice(0, 3));
  assert.deepEqual([afterPrepared.accounted, afterPrepared.collateral, afterPrepared.fees],
    [beforePrepared.accounted, beforePrepared.collateral, beforePrepared.fees]);
  receipts.push({ name: "finalized prepareCancelOrder -> user signing -> persisted submitSignedWalletTransaction",
    signature, slot: preparedReceipt.slot, error: null, cu: preparedReceipt.meta.computeUnitsConsumed });
  console.log(`PASS finalized wallet-prepared cancellation: ${signature} (${preparedReceipt.meta.computeUnitsConsumed} CU)`);
  await finalized(signature);
  for (const verify of verifyFinalTerms) await verify();
  for (const market of [m, short]) {
    const final = await state(market, "finalized");
    const snapshot = (index: number, key: Address) => ({ address: key, owner: final.raw[index]!.owner,
      executable: final.raw[index]!.executable, data: bytes(final.raw[index]) });
    const verified = await readCanonicalOrderBook({ programAddress: PROGRAM, marketId: market.marketId,
      market: snapshot(0, market.market), seats: snapshot(1, market.seats), book: snapshot(2, market.book) });
    assert.equal(verified.orders.length, 0); assert(verified.reservesReconciled);
  }
  assert.equal(receipts.length - termsEvidence.length * 4 - admissionCases, 94, "Original cancellation baseline changed");
  console.log(JSON.stringify({ result: "PASS", scope: "Actual compiled-program cancellation/cleanup RPC integration",
    rpc: endpoint.toString(), genesis, program: PROGRAM, validator: await rpc("getVersion"), transactionCaseCount: receipts.length,
    originalCancellationBaselineCases: 94, termsSetupTransactionCases: termsEvidence.length * 4, termsAdmissionCases: admissionCases, termsEvidence,
    payout: PAYOUT, feeBps: FEE, realFunding: "authorized SPL mint claims -> wallet-signed deposits -> actual order fills",
    finalizedSignature: signature, baselineEvidence: "/tmp/goosey-solana-runner-MtYRJq/program-e2e.log (88 cases, commit2608d10; retained unchanged)",
    additionalChecks: ["two independently enrolled nontrading reviewers; allowance1 each, no claims", "canonical retained test-only manifest bound to actual ledger/economics/reviewers",
      "independent exact-digest reviewer signatures and creator seal before resolution/trading", "sealed terms reverified after finality", "resolution initialized before trading",
      "finalized preparation nonce/hint", "wallet-only signing", "durable pre-send receipt", "exact-message submission and exact-signature finality"], receipts,
    gaps: ["full 1024-order onchain cleanup CU stress (covered by host heap tests)", "restart/fork recovery", "permissionless multi-order batch instruction (one target per invocation)",
      "nonce-overflow/corrupt reserve states are not injected", "resolution approval/redemption is owned by its separate suite"] },
    (_, v: unknown) => typeof v === "bigint" ? v.toString() : v, 2));
}
main().catch((error: unknown) => { console.error(error instanceof Error ? error.message : "Cancellation RPC suite failed"); process.exitCode = 1; });
