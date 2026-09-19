/**
 * Resumable companion for the retained-localnet market bootstrap.
 *
 * It reuses the first bootstrap's dedicated participant as maker, creates one
 * equally dedicated counterparty, and submits a real complementary BUY pair to
 * the Goosey order book. Importing this module performs no I/O.
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash, generateKeyPairSync } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readFile, realpath, unlink } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import {
  address, appendTransactionMessageInstructions, blockhash, compileTransaction, createKeyPairSignerFromBytes,
  createSolanaRpc, createTransactionMessage, getBase64Encoder, getPublicKeyFromAddress, getSignatureFromTransaction,
  getTransactionDecoder, pipe, setTransactionMessageFeePayerSigner, setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners, verifySignature, type Address, type Instruction, type TransactionSigner,
} from "@solana/kit";
import { getTransferSolInstruction } from "@solana-program/system";
import { buildDepositInstruction, buildRegisterSeatInstruction, deriveGooseySeatAddresses } from "../src/lib/solana/escrow-client";
import { readGooseyConfiguration } from "../src/lib/solana/configuration";
import { readGooseyEscrow } from "../src/lib/solana/escrow-read";
import { buildPlaceOrderInstruction } from "../src/lib/solana/exchange-client";
import { localnetManifestSchema } from "../src/lib/solana/localnet-manifest";
import { buildClaimFeathersInstructions } from "../src/lib/solana/program-client";
import { resolveSolanaRuntime, type SolanaRuntime } from "../src/lib/solana/runtime";
import { submitSignedWalletTransaction } from "../src/lib/solana/submit-transfer";
import { trackTransactionStatus } from "../src/lib/solana/transaction-status";
import { validateEnrollmentReceipt } from "./solana-enroll";

const exec = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const RPC = "http://127.0.0.1:20999/";
const PROGRAM = "CgEGAD3EGLm63YaSx58sRiNPQmmxg8RqvqcxE3xThX8Q";
const PROGRAM_ADDRESS = address(PROGRAM);
const MAX_RECEIPT = 32_768;
const QUANTITY = 10n;
const YES_PRICE = 400n;
const NO_PRICE = 600n;
let activeStage = "startup";

export const matchedTradeBootstrapHelp = `Usage:
  node --import tsx scripts/solana-local-matched-trade-bootstrap.ts run \\
    --operator-directory /absolute/private/retained-localnet \\
    --market-state /absolute/private/goosey-market-bootstrap \\
    --trade-state /absolute/private/goosey-matched-trade

Requires the primary retained-localnet bootstrap to have completed. This is
internal operator/custody and relayer infrastructure: it creates one dedicated
server-custodied counterparty, then uses that signer and the primary dedicated
participant to enroll, claim, register, deposit, and execute one real matched
order-book trade. It is not wallet-facing and requires no Phantom connection.
It never starts/resets a validator, contacts a public cluster, or inserts
financial SQL rows. Exact signed wire receipts stay in trade-state.`;

export type MatchedTradeOptions = { mode: "run"; operatorDirectory: string; marketStateDirectory: string; tradeStateDirectory: string };
function absolute(value: string) {
  assert(path.isAbsolute(value) && path.normalize(value) === value && value !== path.parse(value).root && !/[\0\r\n]/.test(value),
    "Expected normalized absolute path");
  return value;
}
export function parseMatchedTradeArguments(args: readonly string[]): MatchedTradeOptions | { mode: "help" } {
  if (args.length === 1 && ["--help", "-h"].includes(args[0]!)) return { mode: "help" };
  assert(args[0] === "run", "Expected run; use --help");
  const names = ["--operator-directory", "--market-state", "--trade-state"] as const;
  const values = new Map<string, string>();
  for (let index = 1; index < args.length; index += 2) {
    const name = args[index], value = args[index + 1];
    assert(names.includes(name as typeof names[number]) && !values.has(name!) && value && !value.startsWith("--"),
      "Unknown, duplicate or incomplete option");
    values.set(name!, value);
  }
  assert(values.size === names.length && names.every(name => values.has(name)), "All options are required exactly once");
  const directories = names.map(name => absolute(values.get(name)!));
  assert(new Set(directories).size === directories.length, "Directories must be distinct");
  for (const a of directories) for (const b of directories) if (a !== b) {
    assert(!a.startsWith(`${b}${path.sep}`), "Directories must be separate and non-nested");
  }
  return { mode: "run", operatorDirectory: directories[0]!, marketStateDirectory: directories[1]!, tradeStateDirectory: directories[2]! };
}

type PrimaryState = { version: 1; genesisHash: string; programAddress: string; marketId: string; closesAt: string;
  allowance: string; proposer: string; approver: string; participant: string };
export function validateMatchedTradePrimaryState(value: unknown): PrimaryState {
  assert(value && typeof value === "object" && !Array.isArray(value));
  const state = value as Record<string, unknown>;
  for (const key of ["version", "genesisHash", "programAddress", "marketId", "closesAt", "allowance", "proposer", "approver", "participant"]) {
    assert(Object.hasOwn(state, key), `Missing primary ${key}`);
  }
  assert(state.version === 1 && state.programAddress === PROGRAM);
  const genesisHash = address(state.genesisHash as string), programAddress = address(state.programAddress as string);
  const proposer = address(state.proposer as string), approver = address(state.approver as string), participant = address(state.participant as string);
  for (const key of ["marketId", "closesAt", "allowance"] as const) assert(typeof state[key] === "string" && /^(0|[1-9][0-9]{0,19})$/.test(state[key] as string));
  assert(BigInt(state.marketId as string) > 0n && BigInt(state.allowance as string) >= 10_000n && BigInt(state.closesAt as string) > 0n);
  assert(new Set([proposer, approver, participant]).size === 3);
  return { version: 1, genesisHash, programAddress, marketId: state.marketId as string, closesAt: state.closesAt as string,
    allowance: state.allowance as string, proposer, approver, participant };
}

export type TradePlan = { version: 1; genesisHash: Address; programAddress: Address; marketId: string; seats: Address;
  maker: Address; taker: Address; makerNonce: string; takerNonce: string; quantity: string; yesPrice: string; noPrice: string };
export function validateMatchedTradePlan(value: unknown, primary: PrimaryState): TradePlan {
  assert(value && typeof value === "object" && !Array.isArray(value)); const plan = value as Record<string, unknown>;
  assert.deepEqual(Object.keys(plan).sort(), ["version", "genesisHash", "programAddress", "marketId", "seats", "maker", "taker",
    "makerNonce", "takerNonce", "quantity", "yesPrice", "noPrice"].sort());
  assert(plan.version === 1 && plan.genesisHash === primary.genesisHash && plan.programAddress === primary.programAddress
    && plan.marketId === primary.marketId && plan.maker === primary.participant);
  const result = { version: 1 as const, genesisHash: address(plan.genesisHash as string), programAddress: address(plan.programAddress as string),
    marketId: plan.marketId as string, seats: address(plan.seats as string), maker: address(plan.maker as string), taker: address(plan.taker as string),
    makerNonce: plan.makerNonce as string, takerNonce: plan.takerNonce as string, quantity: plan.quantity as string,
    yesPrice: plan.yesPrice as string, noPrice: plan.noPrice as string };
  for (const key of ["marketId", "makerNonce", "takerNonce", "quantity", "yesPrice", "noPrice"] as const) {
    assert(/^(0|[1-9][0-9]{0,19})$/.test(result[key]), `Invalid ${key}`);
  }
  assert(result.maker !== result.taker && BigInt(result.quantity) === QUANTITY && BigInt(result.yesPrice) === YES_PRICE
    && BigInt(result.noPrice) === NO_PRICE && YES_PRICE + NO_PRICE === 1000n);
  return result;
}

async function privateDirectory(directory: string, create = false) {
  absolute(directory); const parent = path.dirname(directory); assert.equal(await realpath(parent), parent, "Directory parent must be canonical");
  if (create) await mkdir(directory, { mode: 0o700 });
  const stat = await lstat(directory);
  assert(stat.isDirectory() && !stat.isSymbolicLink() && stat.uid === process.getuid?.() && (stat.mode & 0o077) === 0,
    "Directory must be owned and private");
  assert.equal(await realpath(directory), directory, "Directory must be canonical");
}
async function exists(file: string) { try { await lstat(file); return true; } catch (error) {
  if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error;
} }
async function privateRead(file: string, maximum = 65_536) {
  const stat = await lstat(file); assert(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1
    && stat.uid === process.getuid?.() && (stat.mode & 0o077) === 0 && stat.size > 0 && stat.size <= maximum, "Unsafe private file");
  return readFile(file);
}
async function exclusive(file: string, value: string | Uint8Array) {
  const handle = await open(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { await handle.writeFile(value); await handle.sync(); } finally { await handle.close(); }
  const parent = await open(path.dirname(file), constants.O_RDONLY | constants.O_NOFOLLOW);
  try { await parent.sync(); } finally { await parent.close(); }
}
async function loadSigner(file: string) {
  const bytes = await privateRead(file, 4096); let raw: unknown;
  try { raw = JSON.parse(bytes.toString("utf8")); assert(Array.isArray(raw) && raw.length === 64
    && raw.every(value => Number.isInteger(value) && value >= 0 && value <= 255), "Invalid key file");
    const secret = Uint8Array.from(raw); try { return await createKeyPairSignerFromBytes(secret); } finally { secret.fill(0); }
  } finally { bytes.fill(0); if (Array.isArray(raw)) raw.fill(0); }
}
async function createSigner(file: string) {
  const jwk = generateKeyPairSync("ed25519").privateKey.export({ format: "jwk" }); assert(jwk.d && jwk.x);
  const secret = Buffer.concat([Buffer.from(jwk.d, "base64url"), Buffer.from(jwk.x, "base64url")]); delete jwk.d;
  try { await exclusive(file, JSON.stringify([...secret])); } finally { secret.fill(0); }
  return loadSigner(file);
}

type ExactReceipt = { version: 1; kind: string; genesisHash: string; signer: string; signature: string;
  blockhash: string; lastValidBlockHeight: string; signedWireBase64: string };
async function exactTransaction(input: { kind: string; file: string; runtime: SolanaRuntime; payer: TransactionSigner;
  instructions: readonly Instruction[]; complete: () => Promise<boolean>; signal: AbortSignal }) {
  const rpc = createSolanaRpc(input.runtime.rpcUrl), complete = await input.complete();
  if (complete && !await exists(input.file)) throw new Error(`${input.kind} state exists without its retained receipt`);
  if (await exists(input.file)) {
    const receipt = JSON.parse((await privateRead(input.file, MAX_RECEIPT)).toString("utf8")) as ExactReceipt;
    assert.deepEqual(Object.keys(receipt).sort(), ["version", "kind", "genesisHash", "signer", "signature", "blockhash", "lastValidBlockHeight", "signedWireBase64"].sort());
    assert(receipt.version === 1 && receipt.kind === input.kind && receipt.genesisHash === input.runtime.genesisHash && receipt.signer === input.payer.address
      && /^(0|[1-9][0-9]{0,19})$/.test(receipt.lastValidBlockHeight));
    const lifetime = { blockhash: blockhash(receipt.blockhash), lastValidBlockHeight: BigInt(receipt.lastValidBlockHeight) };
    const message = pipe(createTransactionMessage({ version: 0 }), value => setTransactionMessageFeePayerSigner(input.payer, value),
      value => setTransactionMessageLifetimeUsingBlockhash(lifetime, value), value => appendTransactionMessageInstructions(input.instructions, value));
    const expected = compileTransaction(message), actual = getTransactionDecoder().decode(getBase64Encoder().encode(receipt.signedWireBase64));
    assert.deepEqual(new Uint8Array(actual.messageBytes), new Uint8Array(expected.messageBytes), "Receipt intent changed");
    assert.equal(getSignatureFromTransaction(actual), receipt.signature);
    assert.deepEqual(Object.keys(actual.signatures), [input.payer.address], "Unexpected receipt signer set");
    const signature = actual.signatures[input.payer.address];
    assert(signature && await verifySignature(await getPublicKeyFromAddress(input.payer.address), signature, actual.messageBytes), "Invalid receipt signature");
    if (!complete) {
      const status = await trackTransactionStatus(rpc, { signature: receipt.signature, lastValidBlockHeight: lifetime.lastValidBlockHeight,
        commitment: "finalized", timeoutMs: 90_000, signal: input.signal });
      assert.equal(status.status, "finalized", `${input.kind} retained transaction is not finalized`);
      assert(await input.complete(), `${input.kind} finalized without expected state`);
    }
    return receipt.signature;
  }
  const latest = await rpc.getLatestBlockhash({ commitment: "finalized" }).send({ abortSignal: input.signal });
  const message = pipe(createTransactionMessage({ version: 0 }), value => setTransactionMessageFeePayerSigner(input.payer, value),
    value => setTransactionMessageLifetimeUsingBlockhash(latest.value, value), value => appendTransactionMessageInstructions(input.instructions, value));
  const signed = await signTransactionMessageWithSigners(message);
  const submitted = await submitSignedWalletTransaction({ runtime: input.runtime,
    prepared: { message, sender: input.payer.address, cluster: "localnet", genesisHash: input.runtime.genesisHash }, signed, signal: input.signal,
    onPrepared: receipt => exclusive(input.file, JSON.stringify({ version: 1, kind: input.kind, genesisHash: input.runtime.genesisHash,
      signer: input.payer.address, signature: receipt.signature, blockhash: latest.value.blockhash,
      lastValidBlockHeight: receipt.lastValidBlockHeight.toString(), signedWireBase64: receipt.signedWireBase64 })) });
  const status = await trackTransactionStatus(rpc, { signature: submitted.signature, lastValidBlockHeight: submitted.lastValidBlockHeight,
    commitment: "finalized", timeoutMs: 90_000, signal: input.signal });
  assert.equal(status.status, "finalized", `${input.kind} requires receipt reconciliation`);
  assert(await input.complete(), `${input.kind} finalized without expected state`); return submitted.signature;
}

function computeBudgetInstruction() {
  const data = new Uint8Array(5); data[0] = 2; new DataView(data.buffer).setUint32(1, 1_400_000, true);
  return { programAddress: address("ComputeBudget111111111111111111111111111111"), accounts: [], data } satisfies Instruction;
}
async function command(args: string[], env: NodeJS.ProcessEnv, signal: AbortSignal) {
  await exec(process.execPath, args, { cwd: root, env, signal, timeout: 600_000, maxBuffer: 1024 * 1024 });
}

async function run(options: MatchedTradeOptions) {
  activeStage = "validate-retained-state";
  await privateDirectory(options.operatorDirectory); await privateDirectory(options.marketStateDirectory);
  const operator = localnetManifestSchema.parse(JSON.parse((await privateRead(path.join(options.operatorDirectory, "manifest.json"))).toString("utf8")));
  assert.equal(operator.rpcPort, 20999); assert.equal(operator.program, PROGRAM);
  const rpc = createSolanaRpc(RPC), controller = new AbortController(), stop = () => controller.abort();
  process.once("SIGINT", stop); process.once("SIGTERM", stop);
  const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(1_800_000)]);
  const genesisHash = await rpc.getGenesisHash().send({ abortSignal: signal });
  const retainedGenesis = JSON.parse((await privateRead(path.join(options.operatorDirectory, "genesis.json"))).toString("utf8"));
  assert.equal(genesisHash, retainedGenesis.genesis, "Running validator does not match retained genesis");
  const runtime = resolveSolanaRuntime({ GOOSEY_SOLANA_CLUSTER: "localnet", GOOSEY_SOLANA_RPC_URL: RPC,
    GOOSEY_SOLANA_PROGRAM_ID: PROGRAM, GOOSEY_SOLANA_GENESIS_HASH: genesisHash });
  const primary = validateMatchedTradePrimaryState(JSON.parse((await privateRead(path.join(options.marketStateDirectory, "bootstrap.json"))).toString("utf8")));
  assert.equal(primary.genesisHash, genesisHash);
  const config = await readGooseyConfiguration(runtime, signal); assert.equal(config.admin, operator.admin); assert.equal(config.enrollmentAuthority, operator.enrollment);
  if (!await exists(options.tradeStateDirectory)) await privateDirectory(options.tradeStateDirectory, true); else await privateDirectory(options.tradeStateDirectory);
  const lock = path.join(options.tradeStateDirectory, "operator.lock"); await exclusive(lock, JSON.stringify({ pid: process.pid }));
  try {
    const keys = path.join(options.tradeStateDirectory, "keys"), receipts = path.join(options.tradeStateDirectory, "receipts");
    if (!await exists(keys)) await privateDirectory(keys, true); else await privateDirectory(keys);
    if (!await exists(receipts)) await privateDirectory(receipts, true); else await privateDirectory(receipts);
    const maker = await loadSigner(path.join(options.marketStateDirectory, "keys", "participant.json"));
    const takerFile = path.join(keys, "counterparty.json");
    const taker = await (await exists(takerFile) ? loadSigner(takerFile) : createSigner(takerFile));
    const admin = await loadSigner(path.join(options.operatorDirectory, "admin.json"));
    assert.equal(maker.address, primary.participant); assert(new Set([maker.address, taker.address, admin.address, primary.proposer, primary.approver]).size === 5);
    const publication = path.join(options.marketStateDirectory, "publication");
    const seats = address(JSON.parse((await privateRead(path.join(publication, "seats-address.json"))).toString("utf8")).address);
    const marketId = BigInt(primary.marketId), env = { ...process.env, GOOSEY_SOLANA_CLUSTER: "localnet", GOOSEY_SOLANA_RPC_URL: RPC,
      GOOSEY_SOLANA_PROGRAM_ID: PROGRAM, GOOSEY_SOLANA_GENESIS_HASH: genesisHash };

    activeStage = "fund-counterparty-fees";
    await exactTransaction({ kind: "counterparty-fee-funding", file: path.join(receipts, "counterparty-fee-funding.json"), runtime, payer: admin,
      instructions: [getTransferSolInstruction({ source: admin, destination: taker.address, amount: 200_000_000n })], signal,
      complete: async () => (await rpc.getBalance(taker.address, { commitment: "finalized" }).send({ abortSignal: signal })).value >= 100_000_000n });

    activeStage = "enroll-counterparty";
    const enrollmentReceipt = path.join(receipts, "counterparty-enrollment.json");
    const identityDigest = createHash("sha256").update(`goosey:local-matched-trade:${genesisHash}:${taker.address}`).digest("hex");
    if (await exists(enrollmentReceipt)) {
      const retained = await validateEnrollmentReceipt((await privateRead(enrollmentReceipt, MAX_RECEIPT)).toString("utf8"), runtime);
      assert.equal(retained.wallet, taker.address); assert.equal(retained.identityDigestHex, identityDigest);
      assert.equal(retained.allowance, primary.allowance); assert.equal(retained.expiresAt, primary.closesAt);
    } else {
      const addresses = await deriveGooseySeatAddresses({ programAddress: PROGRAM_ADDRESS, marketId, wallet: taker.address });
      const account = await rpc.getAccountInfo(addresses.enrollment, { commitment: "finalized", encoding: "base64" }).send({ abortSignal: signal });
      assert.equal(account.value, null, "Counterparty enrollment exists without retained receipt");
      await command(["--import", "tsx", "scripts/solana-enroll.ts", "submit", "--authority-keyfile", path.join(options.operatorDirectory, "enrollment.json"),
        "--wallet", taker.address, "--identity-digest", identityDigest, "--allowance", primary.allowance, "--expires-at", primary.closesAt,
        "--receipt", enrollmentReceipt], env, signal);
      await command(["--import", "tsx", "scripts/solana-enroll.ts", "status", "--receipt", enrollmentReceipt], env, signal);
    }

    activeStage = "claim-counterparty-feathers";
    const claim = await buildClaimFeathersInstructions({ programAddress: PROGRAM_ADDRESS, wallet: taker, createAta: true });
    await exactTransaction({ kind: "counterparty-feather-claim", file: path.join(receipts, "counterparty-feather-claim.json"), runtime, payer: taker,
      instructions: claim.instructions, signal, complete: async () => {
        const account = await rpc.getAccountInfo(claim.enrollment, { commitment: "finalized", encoding: "base64" }).send({ abortSignal: signal });
        return !!account.value && Buffer.from(account.value.data[0], "base64").readBigUInt64LE(112) === BigInt(primary.allowance);
      } });
    activeStage = "register-counterparty-seat";
    const registration = await buildRegisterSeatInstruction({ programAddress: PROGRAM_ADDRESS, marketId, seats, wallet: taker });
    await exactTransaction({ kind: "counterparty-seat-registration", file: path.join(receipts, "counterparty-seat-registration.json"), runtime, payer: taker,
      instructions: [registration.instruction], signal, complete: async () => (await readGooseyEscrow(runtime, { marketId, wallet: taker.address }, { signal })).seat !== null });
    const beforeDeposit = await readGooseyEscrow(runtime, { marketId, wallet: taker.address }, { signal }); assert(beforeDeposit.seat);
    activeStage = "deposit-counterparty-feathers";
    // The complementary NO buy reserves 600 * 10 plus its fee. Three quarters
    // of the minimum 10,000-base-unit grant covers that without overfunding the
    // market with the counterparty's entire claimed balance.
    const depositAmount = BigInt(primary.allowance) * 3n / 4n;
    const deposit = await buildDepositInstruction({ programAddress: PROGRAM_ADDRESS, marketId, seats, wallet: taker,
      amount: depositAmount, expectedNonce: beforeDeposit.seat.nextNonce });
    await exactTransaction({ kind: "counterparty-escrow-deposit", file: path.join(receipts, "counterparty-escrow-deposit.json"), runtime, payer: taker,
      instructions: [deposit.instruction], signal, complete: async () => {
        const value = await readGooseyEscrow(runtime, { marketId, wallet: taker.address }, { signal });
        return !!value.seat && value.seat.nextNonce > beforeDeposit.seat!.nextNonce;
      } });

    activeStage = "freeze-trade-plan";
    const planFile = path.join(options.tradeStateDirectory, "trade-plan.json"); let plan: TradePlan;
    if (await exists(planFile)) plan = validateMatchedTradePlan(JSON.parse((await privateRead(planFile)).toString("utf8")), primary);
    else {
      const [makerState, takerState] = await Promise.all([
        readGooseyEscrow(runtime, { marketId, wallet: maker.address }, { signal, includeOrderBook: true, includeResolution: true, includeMarketTerms: true }),
        readGooseyEscrow(runtime, { marketId, wallet: taker.address }, { signal, includeOrderBook: true, includeResolution: true, includeMarketTerms: true }),
      ]);
      assert(makerState.seat && takerState.seat && makerState.orderBook && takerState.orderBook);
      assert.equal(makerState.orderBook.revision, takerState.orderBook.revision); assert.equal(makerState.orderBook.orders.length, 0,
        "Trade bootstrap requires a pristine dedicated market order book");
      assert(!makerState.seat.everTraded && !takerState.seat.everTraded && makerState.seat.yes === 0n && makerState.seat.no === 0n
        && takerState.seat.yes === 0n && takerState.seat.no === 0n, "Dedicated participant state is not pristine");
      const draft = { version: 1 as const, genesisHash: address(genesisHash), programAddress: address(PROGRAM), marketId: primary.marketId, seats,
        maker: maker.address, taker: taker.address, makerNonce: makerState.seat.nextNonce.toString(), takerNonce: takerState.seat.nextNonce.toString(),
        quantity: QUANTITY.toString(), yesPrice: YES_PRICE.toString(), noPrice: NO_PRICE.toString() };
      plan = validateMatchedTradePlan(draft, primary); await exclusive(planFile, JSON.stringify(plan, null, 2));
    }
    assert.equal(plan.taker, taker.address); assert.equal(plan.seats, seats);
    const makerOrder = await buildPlaceOrderInstruction({ programAddress: PROGRAM_ADDRESS, marketId, seats, wallet: maker,
      expectedNonce: BigInt(plan.makerNonce), price: YES_PRICE, quantity: QUANTITY, outcome: "YES", action: "BUY",
      timeInForce: "GTC", selfTrade: "CANCEL_AGGRESSOR", postOnly: true, touches: 0 });
    activeStage = "place-resting-maker-order";
    await exactTransaction({ kind: "maker-resting-yes-buy", file: path.join(receipts, "maker-resting-yes-buy.json"), runtime, payer: maker,
      instructions: [computeBudgetInstruction(), makerOrder.instruction], signal, complete: async () => {
        const value = await readGooseyEscrow(runtime, { marketId, wallet: maker.address }, { signal, includeOrderBook: true });
        if (!value.seat || value.seat.nextNonce <= BigInt(plan.makerNonce) || !value.orderBook) return false;
        const resting = value.orderBook.orders.some(order => order.wallet === maker.address && order.outcome === "YES"
          && order.action === "BUY" && order.limitPrice === YES_PRICE && order.remaining === QUANTITY);
        // On a later resume, the genuine taker transaction may already have
        // consumed this order. Its finalized position is then stronger proof.
        return resting || (value.seat.everTraded && value.seat.yes === QUANTITY && value.seat.no === 0n);
      } });
    const takerOrder = await buildPlaceOrderInstruction({ programAddress: PROGRAM_ADDRESS, marketId, seats, wallet: taker,
      expectedNonce: BigInt(plan.takerNonce), price: NO_PRICE, quantity: QUANTITY, outcome: "NO", action: "BUY",
      timeInForce: "IOC", selfTrade: "CANCEL_AGGRESSOR", touches: 16 });
    activeStage = "execute-crossing-taker-order";
    const tradeSignature = await exactTransaction({ kind: "taker-crossing-no-buy", file: path.join(receipts, "taker-crossing-no-buy.json"), runtime, payer: taker,
      instructions: [computeBudgetInstruction(), takerOrder.instruction], signal, complete: async () => {
        const [makerState, takerState] = await Promise.all([
          readGooseyEscrow(runtime, { marketId, wallet: maker.address }, { signal, includeOrderBook: true }),
          readGooseyEscrow(runtime, { marketId, wallet: taker.address }, { signal, includeOrderBook: true }),
        ]);
        return !!makerState.seat && !!takerState.seat && makerState.seat.everTraded && takerState.seat.everTraded
          && makerState.seat.yes === QUANTITY && makerState.seat.no === 0n && takerState.seat.no === QUANTITY && takerState.seat.yes === 0n
          && makerState.orderBook?.orders.length === 0 && takerState.orderBook?.orders.length === 0;
      } });

    console.log(JSON.stringify({ event: "goosey_local_matched_trade_ready", cluster: "localnet", marketId: primary.marketId,
      maker: maker.address, taker: taker.address, quantity: QUANTITY.toString(), price: YES_PRICE.toString(), signature: tradeSignature,
      note: "Internal custody proof only. All financial state is on chain; exact signed receipts remain in the private trade state directory." }));
  } finally {
    await unlink(lock); const directory = await open(options.tradeStateDirectory, constants.O_RDONLY);
    try { await directory.sync(); } finally { await directory.close(); }
    process.removeListener("SIGINT", stop); process.removeListener("SIGTERM", stop);
  }
}

export async function runMatchedTradeBootstrapCli(args: readonly string[]) {
  const options = parseMatchedTradeArguments(args); if (options.mode === "help") { console.log(matchedTradeBootstrapHelp); return 0; }
  try { await run(options); return 0; } catch {
    console.error(JSON.stringify({ event: "goosey_local_matched_trade_bootstrap_stopped", stage: activeStage,
      message: "Stopped safely. Preserve all keys/receipts and rerun the exact command; never reset the retained validator." })); return 1;
  }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void runMatchedTradeBootstrapCli(process.argv.slice(2)).then(code => { process.exitCode = code; });
}
