/** Actual RPC matcher integration. NEVER sets account data or seeds positions.
 * Run ONLY against a NEW isolated ledger containing the compiled Goosey program.
 * Same explicit loopback/genesis/temporary-admin contract as the isolated runner.
 * Does not launch, reset or stop any validator. See --help; no default endpoint.
 */
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
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

const PROGRAM = address("CgEGAD3EGLm63YaSx58sRiNPQmmxg8RqvqcxE3xThX8Q");
const LOADER = address("BPFLoaderUpgradeab1e11111111111111111111111");
const CLOCK = address("SysvarC1ock11111111111111111111111111111111");
const BOOK_BYTES = 69_720, STEP = 10_240, CAPACITY = 1024;
const PAYOUT = 1_000n, FEE_BPS = 100n, GRANT = 1_000_000n;
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
No cancellation/replacement/resolution instruction is claimed to be tested.`);
    return;
  }
  assert.equal(process.argv.length, 2, "Unknown arguments; use --help");
  const endpoint = new URL(process.env.GOOSEY_SOLANA_RPC_URL ?? "");
  assert(["127.0.0.1", "[::1]"].includes(endpoint.hostname) && ["http:", "https:"].includes(endpoint.protocol), "Literal loopback RPC required");
  assert(!endpoint.username && !endpoint.password && !endpoint.hash && !endpoint.search, "Unsafe RPC URL");
  assert(!["18999", "8080"].includes(endpoint.port), "Shared validator/app ports are prohibited");
  const genesis = process.env.GOOSEY_SOLANA_GENESIS_HASH;
  assert(genesis && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(genesis), "Explicit genesis pin required");
  assert(!["5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp", "EtWTRABZaYq6iMfeYKouRu166VU2xqa1", "4uhcVJyU9pJkvQyS88uRDiswHXSCkY3zQawwpjk2NsNY"].includes(genesis), "Public clusters prohibited");
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
  const accounts = async (keys: readonly Address[]) => (await rpc<Context<(ChainAccount | null)[]>>("getMultipleAccounts", [keys, { encoding: "base64", commitment: "confirmed" }])).value;
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
  const initialized = await buildInitializeInstruction({ programAddress: PROGRAM, admin, environment: 1,
    genesisDomain: createHash("sha256").update(genesis).digest(), enrollmentAuthority: admin.address,
    perWalletCap: GRANT, campaignCap: 4n * GRANT });
  await execute("initialize real program and 3-decimal feather mint", [initialized.instruction]);
  const actors = await Promise.all(Array.from({ length: 4 }, () => generateKeyPairSigner()));
  await execute("fund four ephemeral wallets with local SOL for account rent", actors.map(wallet => getTransferSolInstruction({ source: admin, destination: wallet.address, amount: 1_000_000_000n })));
  const walletTokens: Address[] = [], enrollments: Address[] = [];
  const closesAt = (await time()) + 900n;
  for (const [i, wallet] of actors.entries()) {
    const enrolled = await buildAuthorizeEnrollmentInstruction({ programAddress: PROGRAM, enrollmentAuthority: admin,
      wallet: wallet.address, identityDigest: randomBytes(32), allowance: GRANT, expiresAt: closesAt });
    await execute(`authorize real unique wallet ${i}`, [enrolled.instruction]);
    const claim = await buildClaimFeathersInstructions({ programAddress: PROGRAM, wallet, payer: admin, createAta: true });
    await execute(`wallet ${i} claims actual SPL feathers`, claim.instructions);
    walletTokens.push(claim.walletTokens); enrollments.push(claim.enrollment);
    watched.add(claim.walletTokens); watched.add(claim.enrollment); watched.add(enrolled.identity);
  }
  const seatsSigner = await generateKeyPairSigner();
  const market = await buildCreateMarketInstructions({ programAddress: PROGRAM, marketId: 1n, admin, seats: seatsSigner,
    seatsRentLamports: BigInt(await rpc<number>("getMinimumBalanceForRentExemption", [32_816])), payoutMilli: PAYOUT,
    feeBps: Number(FEE_BPS), closesAt, resolvesAt: closesAt });
  await execute("create real market, seats and SPL escrow vault", market.instructions);
  const [book] = await getProgramDerivedAddress({ programAddress: PROGRAM, seeds: ["order_book", keyBytes(market.market)] });
  for (const key of [market.market, market.seats, market.vault, book]) watched.add(key);
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
  const place = (owner: number, args: OrderArgs, keys?: AccountMeta[]) => instruction("place_order", keys ?? [signer(actors[owner]), ro(base.config), rw(market.market), rw(market.seats), ro(locators[owner]), ro(market.vault), rw(book)],
    Buffer.concat([u64(args.expectedNonce ?? 0n), u64(args.price), u64(args.quantity), Buffer.from([args.outcome, args.action, args.tif ?? 0, args.selfTrade ?? 0, args.postOnly ? 1 : 0]),
      args.expiresAt === undefined ? Buffer.from([0]) : Buffer.concat([Buffer.from([1]), i64(args.expiresAt)]), Buffer.from([args.touches ?? 0])]));
  await execute("wrong admin cannot create the canonical book", [setup("create_book", undefined, actors[0])], 2001);
  await execute("shipping builder creates canonical draft PDA at 10240 bytes", [await shippingSetup({ kind: "create" })]);
  assert.equal(bytes((await accounts([book]))[0]).length, STEP);
  assert.equal(bytes((await accounts([book]))[0]).subarray(0, 8).toString(), "GOOSEYI1");
  await execute("draft cannot be finalized early", [setup("finalize_book")], 7100);
  await execute("draft cannot accept placement", [place(0, { price: 400n, quantity: 1n, outcome: 0, action: 0 })], 7000);
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

  async function state() {
    const [m, s, b, vault, mint, ...tokens] = await accounts([market.market, market.seats, book, market.vault, base.featherMint, ...walletTokens]);
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
  function invariants(s: State) {
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
    assert.equal(s.walletAmounts.reduce((sum, n) => sum + n, s.vault), s.supply);
  }
  invariants(await state());
  for (const [i, wallet] of actors.entries()) {
    const deposit = await buildDepositInstruction({ programAddress: PROGRAM, marketId: 1n, wallet, seats: market.seats, amount: GRANT, expectedNonce: 0n });
    await execute(`wallet ${i} deposits only actual claimed SPL balance`, [deposit.instruction]); invariants(await state());
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
  await order("atomic FOK cannot consume available partial liquidity", 2, buyYes(700n, 3n, 2), { error: 7011 });
  const partialIoc = await order("partial IOC cancels remainder without leaving a reserve", 3, buyYes(700n, 5n, 1), { filled: 2n, canceled: 3n, rested: 0n, disposition: 4 });
  assert.equal(partialIoc.before.seats[3].available - partialIoc.after.seats[3].available, 1_414n);
  await order("empty IOC advances nonce but creates no order or fee", 3, buyYes(100n, 1n, 1), { filled: 0n, canceled: 1n, rested: 0n, disposition: 3 });
  await order("partial GTC maker setup", 0, sellYes(700n, 1n), { rested: 1n });
  const partialGtc = await order("partial GTC rests exact remaining telescoping reserve", 2, buyYes(710n, 3n), { filled: 1n, canceled: 0n, rested: 2n, disposition: 2 });
  assert.equal(partialGtc.after.seats[2].reserved, 1_435n);
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
  const wrongLocatorKeys = [signer(actors[0]), ro(base.config), rw(market.market), rw(market.seats), ro(locators[1]), ro(market.vault), rw(book)];
  await execute("another wallet locator cannot authorize a placement", [place(0, { ...buyYes(100n, 1n), expectedNonce: current.seats[0].nonce }, wrongLocatorKeys)], 2006);
  const wrongBookKeys = [signer(actors[0]), ro(base.config), rw(market.market), rw(market.seats), ro(locators[0]), ro(market.vault), rw(base.config)];
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
  const withdrawal = await buildWithdrawInstruction({ programAddress: PROGRAM, marketId: 1n, wallet: actors[0], seats: market.seats,
    amount: current.seats[0].available, expectedNonce: current.seats[0].nonce });
  await execute("withdraw real unreserved cash while minted positions remain collateralized", [withdrawal.instruction]);
  const final = await state(); invariants(final); assert.equal(final.orders.length, 0); assert.equal(final.seats[0].available, 0n);
  const finalSlot = Number(receipts.at(-1)!.slot), deadline = Date.now() + 60_000;
  while (await rpc<number>("getSlot", [{ commitment: "finalized" }]) < finalSlot) { assert(Date.now() < deadline, "Finality gate timed out"); await delay(200); }
  console.log(JSON.stringify({ result: "PASS", scope: "Actual RPC compiled-program exchange integration, not a host arithmetic simulation",
    rpc: endpoint.toString(), genesis, program: PROGRAM, validator: await rpc("getVersion"), market: market.market, seats: market.seats, book,
    bookBytes: BOOK_BYTES, bootstrapSizes: [10_240, 20_480, 30_720, 40_960, 51_200, 61_440, 69_720], transactionCaseCount: receipts.length,
    successBuilders: ["program-client.ts", "escrow-client.ts", "exchange-client.ts"],
    additionalChecks: ["identical signed transaction replay", "finalized completion", "heap/free-list and exact live-order reserves after every placement"],
    final: { accounted: final.accounted, vault: final.vault, collateral: final.collateral, fees: final.revenue, supply: final.supply, seats: final.seats },
    receipts, gaps: ["cancel/replace/resolution instruction lifecycle", "1024-order capacity exhaustion", "16 distinct maker seats/full-book CU stress",
      "fork/restart recovery and concurrent RPC sends", "browser wallets", "unreachable corrupt-account/nonce-overflow states are not fabricated", "market-close boundary"],
  }, (_, value: unknown) => typeof value === "bigint" ? value.toString() : value, 2));
}
main().catch((error: unknown) => { console.error(error instanceof Error ? error.message : "Exchange RPC suite failed"); process.exitCode = 1; });
