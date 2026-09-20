/**
 * Resumable localhost bootstrap for one real retained-localnet market.
 *
 * This operator never starts/resets a validator, never contacts a public Solana
 * cluster, and never writes SQL balances/fills. Every financial state change is
 * a signed transaction against the pinned port-20999 ledger. Importing this file
 * performs no I/O.
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
  createSolanaRpc, createTransactionMessage, getAddressDecoder, getBase64Encoder, getPublicKeyFromAddress, getSignatureFromTransaction,
  getTransactionDecoder, pipe, setTransactionMessageFeePayerSigner, setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners, verifySignature, type Instruction, type TransactionSigner,
} from "@solana/kit";
import { getTransferSolInstruction } from "@solana-program/system";
import { buildDepositInstruction, buildRegisterSeatInstruction, deriveGooseySeatAddresses } from "../src/lib/solana/escrow-client";
import { readGooseyConfiguration } from "../src/lib/solana/configuration";
import { readGooseyEscrow } from "../src/lib/solana/escrow-read";
import { ingestFinalizedProgramPage } from "../src/lib/solana/ingestion-worker";
import { readIngestionCursor } from "../src/lib/solana/ingestion-cursor";
import { localnetManifestSchema } from "../src/lib/solana/localnet-manifest";
import { encodeMarketTerms, hashMarketTerms, type MarketTerms } from "../src/lib/solana/market-terms";
import { buildAcceptMarketTermsInstruction, readMarketTermsAccount } from "../src/lib/solana/market-terms-client";
import { buildClaimFeathersInstructions, deriveGooseyEnrollmentAddresses,
  deriveGooseyProgramAddresses } from "../src/lib/solana/program-client";
import { resolveSolanaRuntime, type SolanaRuntime } from "../src/lib/solana/runtime";
import { submitSignedWalletTransaction } from "../src/lib/solana/submit-transfer";
import { trackTransactionStatus } from "../src/lib/solana/transaction-status";
import { validateEnrollmentReceipt } from "./solana-enroll";

const exec = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const RPC = "http://127.0.0.1:20999/";
const STATE_VERSION = 1 as const;
const MARKET_SLUG = "goosey-htn-localnet-first-match";
const RECEIPT_LIMIT = 16_384;
let activeBootstrapStage = "startup";

export const localBootstrapHelp = `Usage:
  node --import tsx scripts/solana-local-development-bootstrap.ts run \\
    --operator-directory /absolute/private/retained-localnet \\
    --state /absolute/private/goosey-market-bootstrap \\
    --terms-directory /absolute/private/localhost-terms-store \\
    --actor-user-id EXISTING_ACTIVE_ADMIN_ID

Creates/resumes exactly one real Goosey market on the already-running retained
local validator at 127.0.0.1:20999. It never starts, resets or replaces that
validator and refuses devnet/testnet/mainnet. The configured application DB is
used only for verified SOLANA catalog registration/publication and indexing;
no SQL balance, order, fill or position is created. Private keys and signed wire
receipts remain in the 0700 state directory and are never printed.

The first run creates dedicated local-only reviewer/participant keys, funds only
their localnet transaction fees, enrolls creator/two reviewers/participant,
claims the participant's real SPL feathers, publishes terms through two actual
reviewer acceptances, activates the market, registers/deposits the participant,
indexes finalized program receipts, then registers and publishes the catalog.
Rerun the exact command to reconcile retained receipts and resume safely.`;

export type LocalBootstrapOptions = { mode: "run"; operatorDirectory: string; stateDirectory: string;
  termsDirectory: string; actorUserId: string };
function absolute(value: string) {
  assert(path.isAbsolute(value) && path.normalize(value) === value && value !== path.parse(value).root && !/[\0\r\n]/.test(value),
    "Expected normalized absolute path");
  return value;
}
export function parseLocalBootstrapArguments(args: readonly string[]): LocalBootstrapOptions | { mode: "help" } {
  if (args.length === 1 && ["--help", "-h"].includes(args[0])) return { mode: "help" };
  assert(args[0] === "run", "Expected run; use --help");
  const names = ["--operator-directory", "--state", "--terms-directory", "--actor-user-id"] as const;
  const values = new Map<string, string>();
  for (let i = 1; i < args.length; i += 2) {
    const key = args[i], value = args[i + 1];
    assert(names.includes(key as typeof names[number]) && !values.has(key) && value && !value.startsWith("--"),
      "Unknown, duplicate or incomplete option");
    values.set(key, value);
  }
  assert(values.size === names.length && names.every(name => values.has(name)), "All options are required exactly once");
  const actorUserId = values.get("--actor-user-id")!;
  assert(/^[A-Za-z0-9_-]{1,128}$/.test(actorUserId), "Invalid actor user ID");
  const operatorDirectory = absolute(values.get("--operator-directory")!);
  const stateDirectory = absolute(values.get("--state")!);
  const termsDirectory = absolute(values.get("--terms-directory")!);
  const directories = [operatorDirectory, stateDirectory, termsDirectory];
  for (const a of directories) for (const b of directories) if (a !== b) {
    assert(!a.startsWith(`${b}${path.sep}`), "Operator, bootstrap state and serving terms store must be separate and non-nested");
  }
  assert(new Set(directories).size === directories.length, "Operator, bootstrap state and terms store must be distinct");
  return { mode: "run", operatorDirectory, stateDirectory, termsDirectory, actorUserId };
}

type BootstrapState = {
  version: 1; genesisHash: string; programAddress: string; marketId: string;
  createdAt: string; closesAt: string; resolvesAt: string; allowance: string;
  proposer: string; approver: string; participant: string;
};

export function deriveLocalBootstrapMarketId(genesisHash: string) {
  const bytes = createHash("sha256").update("goosey:local-development-market:v1\0").update(genesisHash).digest();
  const value = bytes.readBigUInt64LE(0);
  return value === 0n ? 1n : value;
}
export function localBootstrapSlug(genesisHash: string) {
  return `${MARKET_SLUG}-${createHash("sha256").update(genesisHash).digest("hex").slice(0, 10)}`;
}

export function localBootstrapIndexingMode(
  cursor: Readonly<{ coverageStartSignature: string }> | null,
  bootstrapBoundary: string,
) {
  return cursor === null || cursor.coverageStartSignature === bootstrapBoundary
    ? "index-bootstrap-boundary" as const
    : "retain-existing-boundary" as const;
}

export function localBootstrapReviewerAcceptanceComplete(acceptanceBits: number, reviewerBit: 1 | 2) {
  assert(Number.isInteger(acceptanceBits) && acceptanceBits >= 0 && acceptanceBits <= 3,
    "Invalid reviewer acceptance bits");
  return (acceptanceBits & reviewerBit) === reviewerBit;
}

export function validateLocalBootstrapState(value: unknown): BootstrapState {
  assert(value && typeof value === "object" && !Array.isArray(value));
  const state = value as Record<string, unknown>;
  assert.deepEqual(Object.keys(state).sort(), ["version", "genesisHash", "programAddress", "marketId", "createdAt", "closesAt",
    "resolvesAt", "allowance", "proposer", "approver", "participant"].sort());
  assert(state.version === 1 && typeof state.genesisHash === "string" && typeof state.programAddress === "string");
  address(state.genesisHash); address(state.programAddress);
  for (const key of ["marketId", "createdAt", "closesAt", "resolvesAt", "allowance"] as const) {
    assert(typeof state[key] === "string" && /^(0|[1-9][0-9]{0,19})$/.test(state[key] as string), `Invalid ${key}`);
  }
  assert(BigInt(state.marketId as string) <= (1n << 64n) - 1n && BigInt(state.allowance as string) > 0n
    && BigInt(state.createdAt as string) < BigInt(state.closesAt as string)
    && BigInt(state.closesAt as string) <= BigInt(state.resolvesAt as string));
  const proposer = address(state.proposer as string), approver = address(state.approver as string), participant = address(state.participant as string);
  assert(new Set([proposer, approver, participant]).size === 3, "Bootstrap wallets must be distinct");
  return { version: 1, genesisHash: state.genesisHash, programAddress: state.programAddress,
    marketId: state.marketId as string, createdAt: state.createdAt as string, closesAt: state.closesAt as string,
    resolvesAt: state.resolvesAt as string, allowance: state.allowance as string, proposer, approver, participant };
}

export async function buildLocalBootstrapTerms(input: {
  runtime: SolanaRuntime; state: BootstrapState; creator: string;
}): Promise<Uint8Array> {
  const { runtime, state } = input, marketId = BigInt(state.marketId);
  const base = await deriveGooseyProgramAddresses(runtime.programAddress);
  const creator = address(input.creator), proposer = address(state.proposer), approver = address(state.approver);
  const market = await deriveGooseySeatAddresses({ programAddress: runtime.programAddress, marketId, wallet: creator });
  const proposerSeat = await deriveGooseySeatAddresses({ programAddress: runtime.programAddress, marketId, wallet: proposer });
  const approverSeat = await deriveGooseySeatAddresses({ programAddress: runtime.programAddress, marketId, wallet: approver });
  const terms: MarketTerms = {
    version: 1,
    binding: { cluster: "localnet", genesisHash: runtime.genesisHash, program: runtime.programAddress,
      config: base.config, market: market.market, marketId: state.marketId, creator, featherMint: base.featherMint },
    question: "Will Goosey record at least one matched on-chain trade in this Hack the North localnet market before it closes?",
    rules: {
      yes: "Resolve YES if the finalized Goosey program history for this exact market ID contains at least one successful matched trade before closesAt.",
      no: "Resolve NO if the complete finalized Goosey program history for this exact market ID contains no successful matched trade before closesAt.",
      void: "Resolve VOID only if the pinned retained-localnet history required to distinguish YES from NO is unavailable or internally unverifiable after the observation window.",
    },
    observation: { startsAt: state.createdAt, endsAt: state.closesAt, timezone: "UTC" },
    sources: [{ id: "goosey-program", uri: "https://github.com/aryan-cs/goosey/tree/master/chain/programs/goosey-exchange",
      selection: "Use finalized receipts from the pinned localnet genesis and Goosey program, filtered to the exact market ID; a verified matched-trade event before closesAt establishes YES.", snapshotSha256: null }],
    sourcePolicy: { priority: "array-order-first-authoritative",
      missing: "Wait for the designated reviewers while retained finalized history is recoverable; use VOID only when complete verification is no longer possible.",
      revisions: "The committed program/genesis/market bindings and pre-close finalized receipts control; later documentation edits do not alter the outcome." },
    economics: { payoutMilli: "1000", feeBps: "100", closesAt: state.closesAt, resolvesAt: state.resolvesAt, decimals: 3 },
    oracle: { kind: "two-reviewer-no-fallback-v1",
      proposer: { wallet: proposer, enrollment: proposerSeat.enrollment },
      approver: { wallet: approver, enrollment: approverSeat.enrollment },
      unavailable: "wait-for-designated-reviewers", replacement: "none", automaticVoid: false },
  };
  return encodeMarketTerms(terms);
}

async function privateDirectory(directory: string, create = false) {
  absolute(directory);
  const parent = path.dirname(directory);
  assert.equal(await realpath(parent), parent, "Directory parent must be canonical");
  if (create) await mkdir(directory, { mode: 0o700 });
  const stat = await lstat(directory);
  assert(stat.isDirectory() && !stat.isSymbolicLink() && stat.uid === process.getuid?.() && (stat.mode & 0o077) === 0,
    "Directory must be owned and private");
  assert.equal(await realpath(directory), directory, "Directory must be canonical");
}
async function privateRead(file: string, maximum = 65_536) {
  const stat = await lstat(file);
  assert(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1 && stat.uid === process.getuid?.()
    && (stat.mode & 0o077) === 0 && stat.size > 0 && stat.size <= maximum, "Unsafe private file");
  return readFile(file);
}
async function exclusive(file: string, bytes: string | Uint8Array) {
  const fd = await open(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { await fd.writeFile(bytes); await fd.sync(); } finally { await fd.close(); }
  const parent = await open(path.dirname(file), constants.O_RDONLY | constants.O_NOFOLLOW);
  try { await parent.sync(); } finally { await parent.close(); }
}
async function exists(file: string) {
  try { await lstat(file); return true; } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
}
async function loadSigner(file: string) {
  const bytes = await privateRead(file, 4096); let raw: unknown;
  try {
    raw = JSON.parse(bytes.toString("utf8"));
    assert(Array.isArray(raw) && raw.length === 64 && raw.every(n => Number.isInteger(n) && n >= 0 && n <= 255), "Invalid key file");
    const secret = Uint8Array.from(raw); try { return await createKeyPairSignerFromBytes(secret); } finally { secret.fill(0); }
  } finally { bytes.fill(0); if (Array.isArray(raw)) raw.fill(0); }
}
async function createSigner(file: string) {
  const jwk = generateKeyPairSync("ed25519").privateKey.export({ format: "jwk" });
  assert(jwk.d && jwk.x); const secret = Buffer.concat([Buffer.from(jwk.d, "base64url"), Buffer.from(jwk.x, "base64url")]); delete jwk.d;
  try { await exclusive(file, JSON.stringify([...secret])); } finally { secret.fill(0); }
  return loadSigner(file);
}
async function chainTime(rpc: ReturnType<typeof createSolanaRpc>, signal: AbortSignal) {
  const clock = await rpc.getAccountInfo(address("SysvarC1ock11111111111111111111111111111111"),
    { encoding: "base64", commitment: "finalized" }).send({ abortSignal: signal });
  assert(clock.value?.owner === "Sysvar1111111111111111111111111111111111111");
  const bytes = Buffer.from(clock.value.data[0], "base64"); assert.equal(bytes.length, 40);
  return bytes.readBigInt64LE(32);
}

type ExactReceipt = { version: 1; kind: string; genesisHash: string; signer: string; signature: string;
  blockhash: string; lastValidBlockHeight: string; signedWireBase64: string };
export async function validateLocalBootstrapReceipt(value: unknown, input: {
  kind: string; runtime: SolanaRuntime; payer: TransactionSigner; instructions: readonly Instruction[];
}) {
  assert(value && typeof value === "object" && !Array.isArray(value)); const receipt = value as ExactReceipt;
  assert.deepEqual(Object.keys(receipt).sort(), ["version", "kind", "genesisHash", "signer", "signature", "blockhash", "lastValidBlockHeight", "signedWireBase64"].sort());
  assert(receipt.version === 1 && receipt.kind === input.kind && receipt.genesisHash === input.runtime.genesisHash
    && receipt.signer === input.payer.address && /^(0|[1-9][0-9]{0,19})$/.test(receipt.lastValidBlockHeight));
  const lifetime = { blockhash: blockhash(receipt.blockhash), lastValidBlockHeight: BigInt(receipt.lastValidBlockHeight) };
  const message = pipe(createTransactionMessage({ version: 0 }), m => setTransactionMessageFeePayerSigner(input.payer, m),
    m => setTransactionMessageLifetimeUsingBlockhash(lifetime, m), m => appendTransactionMessageInstructions(input.instructions, m));
  const expected = compileTransaction(message), actual = getTransactionDecoder().decode(getBase64Encoder().encode(receipt.signedWireBase64));
  assert.deepEqual(new Uint8Array(actual.messageBytes), new Uint8Array(expected.messageBytes), "Receipt intent changed");
  assert.equal(getSignatureFromTransaction(actual), receipt.signature, "Receipt signature changed");
  assert.deepEqual(Object.keys(actual.signatures), [input.payer.address], "Unexpected receipt signer set");
  const retainedSignature = actual.signatures[input.payer.address];
  assert(retainedSignature && await verifySignature(await getPublicKeyFromAddress(input.payer.address), retainedSignature, actual.messageBytes),
    "Receipt signature is invalid");
  return { receipt, message, lifetime };
}
async function exactTransaction(input: { kind: string; file: string; runtime: SolanaRuntime; payer: TransactionSigner;
  instructions: readonly Instruction[]; complete: () => Promise<boolean>; signal: AbortSignal }) {
  const rpc = createSolanaRpc(input.runtime.rpcUrl);
  const already = await input.complete(), retained = await exists(input.file);
  if (already && !retained) throw new Error(`${input.kind} state exists without its retained receipt`);
  if (retained) {
    const parsed = JSON.parse((await privateRead(input.file, RECEIPT_LIMIT)).toString("utf8"));
    const { receipt, lifetime } = await validateLocalBootstrapReceipt(parsed, input);
    if (already) return receipt.signature;
    const status = await trackTransactionStatus(rpc, { signature: receipt.signature, lastValidBlockHeight: lifetime.lastValidBlockHeight,
      commitment: "finalized", timeoutMs: 90_000, signal: input.signal });
    assert.equal(status.status, "finalized", `${input.kind} retained transaction is not finalized`);
    // A successful exact transaction is sufficient on resume: later legitimate
    // activity may have evolved balances/nonces beyond this stage's snapshot.
    return receipt.signature;
  }
  const latest = await rpc.getLatestBlockhash({ commitment: "finalized" }).send({ abortSignal: input.signal });
  const message = pipe(createTransactionMessage({ version: 0 }), m => setTransactionMessageFeePayerSigner(input.payer, m),
    m => setTransactionMessageLifetimeUsingBlockhash(latest.value, m), m => appendTransactionMessageInstructions(input.instructions, m));
  const signed = await signTransactionMessageWithSigners(message);
  const result = await submitSignedWalletTransaction({ runtime: input.runtime,
    prepared: { message, sender: input.payer.address, cluster: "localnet", genesisHash: input.runtime.genesisHash }, signed,
    signal: input.signal, onPrepared: async r => exclusive(input.file, JSON.stringify({ version: 1, kind: input.kind,
      genesisHash: input.runtime.genesisHash, signer: input.payer.address, blockhash: latest.value.blockhash,
      signature: r.signature, lastValidBlockHeight: r.lastValidBlockHeight.toString(), signedWireBase64: r.signedWireBase64 })) });
  const status = await trackTransactionStatus(rpc, { signature: result.signature, lastValidBlockHeight: result.lastValidBlockHeight,
    commitment: "finalized", timeoutMs: 90_000, signal: input.signal });
  assert.equal(status.status, "finalized", `${input.kind} transaction requires receipt reconciliation`);
  assert(await input.complete(), `${input.kind} finalized without expected state`); return result.signature;
}

async function command(args: string[], env: NodeJS.ProcessEnv, signal: AbortSignal) {
  await exec(process.execPath, args, { cwd: root, env, signal, timeout: 600_000, maxBuffer: 1024 * 1024 });
}

export function validateFinalizedEnrollmentAccounts(input: {
  programAddress: string; wallet: string; identityDigestHex: string; allowance: string; expiresAt: string;
  addresses: Readonly<{ config: string; enrollment: string; identity: string; enrollmentBump: number }>;
  observedSlot: bigint; enrollmentAccount: Readonly<{ owner: string; executable: boolean; data: readonly [string, string] }> | null;
  identityAccount: Readonly<{ owner: string; executable: boolean; data: readonly [string, string] }> | null;
}) {
  const wallet = address(input.wallet), digest = Buffer.from(input.identityDigestHex, "hex");
  assert.equal(digest.length, 32);
  const { enrollmentAccount, identityAccount, addresses } = input;
  if (!enrollmentAccount || !identityAccount || enrollmentAccount.owner !== input.programAddress
    || identityAccount.owner !== input.programAddress || enrollmentAccount.executable || identityAccount.executable) return null;
  const enrollment = Buffer.from(enrollmentAccount.data[0], "base64"), identity = Buffer.from(identityAccount.data[0], "base64");
  const enrollmentDiscriminator = createHash("sha256").update("account:Enrollment").digest().subarray(0, 8);
  const identityDiscriminator = createHash("sha256").update("account:EnrollmentIdentity").digest().subarray(0, 8);
  if (enrollment.length !== 129 || identity.length !== 104
    || !enrollment.subarray(0, 8).equals(enrollmentDiscriminator) || !identity.subarray(0, 8).equals(identityDiscriminator)
    || getAddressDecoder().decode(enrollment.subarray(8, 40)) !== addresses.config
    || getAddressDecoder().decode(identity.subarray(8, 40)) !== addresses.config
    || getAddressDecoder().decode(enrollment.subarray(40, 72)) !== wallet
    || getAddressDecoder().decode(identity.subarray(40, 72)) !== wallet
    || !enrollment.subarray(72, 104).equals(digest) || !identity.subarray(72, 104).equals(digest)
    || enrollment.readBigUInt64LE(104).toString() !== input.allowance
    || enrollment.readBigUInt64LE(112) !== 0n || enrollment.readBigInt64LE(120).toString() !== input.expiresAt
    || enrollment[128] !== addresses.enrollmentBump) return null;
  return { observedSlot: input.observedSlot.toString(), enrollment: addresses.enrollment, identity: addresses.identity };
}

async function finalizedEnrollmentState(input: { runtime: SolanaRuntime; wallet: string; identityDigestHex: string;
  allowance: string; expiresAt: string; signal: AbortSignal }) {
  const wallet = address(input.wallet), digest = Buffer.from(input.identityDigestHex, "hex");
  assert.equal(digest.length, 32);
  const addresses = await deriveGooseyEnrollmentAddresses({ programAddress: input.runtime.programAddress,
    wallet, identityDigest: digest });
  const response = await createSolanaRpc(input.runtime.rpcUrl).getMultipleAccounts([addresses.enrollment, addresses.identity],
    { commitment: "finalized", encoding: "base64" }).send({ abortSignal: input.signal });
  const [enrollmentAccount, identityAccount] = response.value;
  return validateFinalizedEnrollmentAccounts({ programAddress: input.runtime.programAddress, wallet,
    identityDigestHex: digest.toString("hex"), allowance: input.allowance, expiresAt: input.expiresAt, addresses,
    observedSlot: response.context.slot, enrollmentAccount, identityAccount });
}

async function run(options: LocalBootstrapOptions) {
  activeBootstrapStage = "validate-operator";
  await privateDirectory(options.operatorDirectory);
  await privateDirectory(options.termsDirectory);
  const operator = localnetManifestSchema.parse(JSON.parse((await privateRead(path.join(options.operatorDirectory, "manifest.json"))).toString("utf8")));
  assert.equal(operator.rpcPort, 20999, "Only the retained port-20999 localnet is allowed");
  assert.equal(operator.program, "CgEGAD3EGLm63YaSx58sRiNPQmmxg8RqvqcxE3xThX8Q");
  const rpc = createSolanaRpc(RPC), controller = new AbortController(), stop = () => controller.abort();
  process.once("SIGINT", stop); process.once("SIGTERM", stop);
  const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(1_800_000)]);
  const genesisHash = await rpc.getGenesisHash().send({ abortSignal: signal });
  const retainedGenesis = JSON.parse((await privateRead(path.join(options.operatorDirectory, "genesis.json"))).toString("utf8"));
  assert.equal(genesisHash, retainedGenesis.genesis, "Running validator does not match retained genesis");
  const runtime = resolveSolanaRuntime({ GOOSEY_SOLANA_CLUSTER: "localnet", GOOSEY_SOLANA_RPC_URL: RPC,
    GOOSEY_SOLANA_PROGRAM_ID: operator.program, GOOSEY_SOLANA_GENESIS_HASH: genesisHash });
  const config = await readGooseyConfiguration(runtime, signal);
  assert.equal(config.admin, operator.admin); assert.equal(config.enrollmentAuthority, operator.enrollment);

  if (!await exists(options.stateDirectory)) await privateDirectory(options.stateDirectory, true);
  else await privateDirectory(options.stateDirectory);
  const lock = path.join(options.stateDirectory, "operator.lock"); await exclusive(lock, JSON.stringify({ pid: process.pid }));
  try {
    const keys = path.join(options.stateDirectory, "keys"), receipts = path.join(options.stateDirectory, "receipts");
    if (!await exists(keys)) await privateDirectory(keys, true); else await privateDirectory(keys);
    if (!await exists(receipts)) await privateDirectory(receipts, true); else await privateDirectory(receipts);
    const keyFiles = { proposer: path.join(keys, "reviewer-proposer.json"), approver: path.join(keys, "reviewer-approver.json"), participant: path.join(keys, "participant.json") };
    const proposer = await (await exists(keyFiles.proposer) ? loadSigner(keyFiles.proposer) : createSigner(keyFiles.proposer));
    const approver = await (await exists(keyFiles.approver) ? loadSigner(keyFiles.approver) : createSigner(keyFiles.approver));
    const participant = await (await exists(keyFiles.participant) ? loadSigner(keyFiles.participant) : createSigner(keyFiles.participant));
    const admin = await loadSigner(path.join(options.operatorDirectory, "admin.json"));
    const enrollment = await loadSigner(path.join(options.operatorDirectory, "enrollment.json"));
    assert.equal(new Set([admin.address, enrollment.address, proposer.address, approver.address, participant.address]).size, 5,
      "Bootstrap roles require distinct keys");

    const stateFile = path.join(options.stateDirectory, "bootstrap.json"); let state: BootstrapState;
    if (await exists(stateFile)) state = validateLocalBootstrapState(JSON.parse((await privateRead(stateFile)).toString("utf8")));
    else {
      const now = await chainTime(rpc, signal), remaining = config.campaignCap - config.totalAuthorized;
      // Four grants are consumed here. Reserve one equal fifth grant for the
      // companion's dedicated counterparty; the existing participant becomes
      // the other side of that internal-custody matched trade.
      const allowance = [config.perWalletCap, remaining / 5n, 100_000n].reduce((a, b) => a < b ? a : b);
      assert(allowance >= 10_000n, "Retained localnet lacks issuance capacity for five real bootstrap enrollments");
      state = { version: STATE_VERSION, genesisHash, programAddress: runtime.programAddress,
        marketId: deriveLocalBootstrapMarketId(genesisHash).toString(), createdAt: now.toString(),
        closesAt: (now + 31_536_000n).toString(), resolvesAt: (now + 32_140_800n).toString(), allowance: allowance.toString(),
        proposer: proposer.address, approver: approver.address, participant: participant.address };
      state = validateLocalBootstrapState(state); await exclusive(stateFile, JSON.stringify(state, null, 2));
    }
    assert.equal(state.genesisHash, genesisHash); assert.equal(state.programAddress, runtime.programAddress);
    assert.equal(state.proposer, proposer.address); assert.equal(state.approver, approver.address); assert.equal(state.participant, participant.address);
    assert.equal(state.marketId, deriveLocalBootstrapMarketId(genesisHash).toString());

    const fundingTargets = [enrollment, proposer, approver, participant] as const, feeLamports = 200_000_000n;
    const enrollmentAccounts = await Promise.all([admin, proposer, approver, participant].map(actor =>
      deriveGooseySeatAddresses({ programAddress: runtime.programAddress, marketId: BigInt(state.marketId), wallet: actor.address })));
    const fundingInstructions = fundingTargets.map(target => getTransferSolInstruction({ source: admin, destination: target.address, amount: feeLamports }));
    activeBootstrapStage = "fund-local-fees";
    await exactTransaction({ kind: "localnet-fee-funding", file: path.join(receipts, "fee-funding.json"), runtime, payer: admin,
      instructions: fundingInstructions, signal, complete: async () => {
        const values = await rpc.getMultipleAccounts(fundingTargets.map(v => v.address), { commitment: "finalized", encoding: "base64" }).send({ abortSignal: signal });
        if (values.value.every(account => account !== null && account.lamports >= 100_000_000n)) return true;
        const enrolled = await rpc.getMultipleAccounts(enrollmentAccounts.map(value => value.enrollment),
          { commitment: "finalized", encoding: "base64" }).send({ abortSignal: signal });
        return enrolled.value.every(account => account?.owner === runtime.programAddress && Buffer.from(account.data[0], "base64").length === 129);
      } });

    const env = { ...process.env, GOOSEY_SOLANA_CLUSTER: "localnet", GOOSEY_SOLANA_RPC_URL: RPC,
      GOOSEY_SOLANA_PROGRAM_ID: runtime.programAddress, GOOSEY_SOLANA_GENESIS_HASH: runtime.genesisHash };
    const expiresAt = state.closesAt, enrollmentTargets = [
      ["creator", admin.address, state.allowance], ["reviewer-proposer", proposer.address, state.allowance],
      ["reviewer-approver", approver.address, state.allowance], ["participant", participant.address, state.allowance],
    ] as const;
    for (const [index, [name, wallet, allowance]] of enrollmentTargets.entries()) {
      activeBootstrapStage = `enrollment-${name}`;
      const receipt = path.join(receipts, `enrollment-${name}.json`);
      const recovery = path.join(receipts, `enrollment-${name}-state-recovery.json`);
      const digest = createHash("sha256").update(`goosey:local-bootstrap:${genesisHash}:${name}:${wallet}`).digest("hex");
      if (await exists(receipt)) {
        const retained = await validateEnrollmentReceipt((await privateRead(receipt, RECEIPT_LIMIT)).toString("utf8"), runtime);
        assert.equal(retained.wallet, wallet); assert.equal(retained.allowance, allowance); assert.equal(retained.expiresAt, expiresAt);
        assert.equal(retained.identityDigestHex, digest);
        const account = await rpc.getAccountInfo(enrollmentAccounts[index].enrollment,
          { commitment: "finalized", encoding: "base64" }).send({ abortSignal: signal });
        assert(account.value?.owner === runtime.programAddress && !account.value.executable, "Missing finalized enrollment");
        const bytes = Buffer.from(account.value.data[0], "base64"); assert.equal(bytes.length, 129);
        assert.equal(getAddressDecoder().decode(bytes.subarray(40, 72)), wallet); assert.equal(bytes.subarray(72, 104).toString("hex"), digest);
        assert.equal(bytes.readBigUInt64LE(104).toString(), allowance); assert.equal(bytes.readBigInt64LE(120).toString(), expiresAt);
      } else {
        const recovered = await finalizedEnrollmentState({ runtime, wallet, identityDigestHex: digest, allowance,
          expiresAt, signal });
        if (recovered) {
          const evidence = { version: 1, kind: "goosey-enrollment-finalized-state-recovery", genesisHash,
            programAddress: runtime.programAddress, wallet, identityDigestHex: digest, allowance, expiresAt,
            enrollment: recovered.enrollment, identity: recovered.identity, observedSlot: recovered.observedSlot,
            limitation: "Exact signed transaction receipt was unavailable; finalized program-owned account state was verified." };
          if (await exists(recovery)) assert.deepEqual(JSON.parse((await privateRead(recovery)).toString("utf8")), evidence);
          else await exclusive(recovery, JSON.stringify(evidence, null, 2));
          continue;
        }
        await command(["--import", "tsx", "scripts/solana-enroll.ts", "submit", "--authority-keyfile", path.join(options.operatorDirectory, "enrollment.json"),
          "--wallet", wallet, "--identity-digest", digest, "--allowance", allowance, "--expires-at", expiresAt, "--receipt", receipt], env, signal);
        await command(["--import", "tsx", "scripts/solana-enroll.ts", "status", "--receipt", receipt], env, signal);
      }
    }

    activeBootstrapStage = "participant-feather-claim";
    const participantPlan = await buildClaimFeathersInstructions({ programAddress: runtime.programAddress, wallet: participant, createAta: true });
    await exactTransaction({ kind: "participant-feather-claim", file: path.join(receipts, "participant-feather-claim.json"), runtime,
      payer: participant, instructions: participantPlan.instructions, signal, complete: async () => {
        const account = await rpc.getAccountInfo(participantPlan.enrollment, { encoding: "base64", commitment: "finalized" }).send({ abortSignal: signal });
        if (!account.value || account.value.owner !== runtime.programAddress) return false;
        const bytes = Buffer.from(account.value.data[0], "base64");
        return bytes.length === 129 && bytes.readBigUInt64LE(112) === BigInt(state.allowance);
      } });

    activeBootstrapStage = "market-publication";
    const runtimeFile = path.join(options.stateDirectory, "runtime.json"), manifestFile = path.join(options.stateDirectory, "market-terms.json");
    const termsDirectory = options.termsDirectory, publicationState = path.join(options.stateDirectory, "publication");
    const terms = await buildLocalBootstrapTerms({ runtime, state, creator: admin.address });
    if (!await exists(runtimeFile)) await exclusive(runtimeFile, JSON.stringify(runtime));
    else assert.deepEqual(JSON.parse((await privateRead(runtimeFile)).toString("utf8")), runtime);
    if (!await exists(manifestFile)) await exclusive(manifestFile, terms);
    else assert.deepEqual(await privateRead(manifestFile), Buffer.from(terms));
    const publish = async (stage: string) => command(["--import", "tsx", "scripts/solana-publish-market.ts", stage,
      "--runtime", runtimeFile, "--manifest", manifestFile, "--state", publicationState, "--terms-directory", termsDirectory,
      ...(["status", "review-instructions"].includes(stage) ? [] : ["--admin-key", path.join(options.operatorDirectory, "admin.json")])], env, signal);
    if (!await exists(publicationState)) { activeBootstrapStage = "market-prepare"; await publish("prepare"); }
    activeBootstrapStage = "market-init";
    await publish("init");
    const seats = address(JSON.parse((await privateRead(path.join(publicationState, "seats-address.json"))).toString("utf8")).address);
    const digest = Buffer.from(await hashMarketTerms(terms), "hex");
    for (const [role, reviewer, bit] of [["proposer", proposer, 1], ["approver", approver, 2]] as const) {
      activeBootstrapStage = `market-terms-${role}-acceptance`;
      const acceptance = await buildAcceptMarketTermsInstruction({ programAddress: runtime.programAddress, marketId: BigInt(state.marketId), seats,
        reviewer, expectedDigest: digest });
      await exactTransaction({ kind: `market-terms-${role}-acceptance`, file: path.join(receipts, `market-terms-${role}-acceptance.json`),
        runtime, payer: reviewer, instructions: [acceptance.instruction], signal, complete: async () => {
          const response = await rpc.getAccountInfo(acceptance.terms,
            { commitment: "finalized", encoding: "base64" }).send({ abortSignal: signal });
          if (!response.value) return false;
          const account = await readMarketTermsAccount({ programAddress: runtime.programAddress,
            marketId: BigInt(state.marketId), config: acceptance.config, market: acceptance.market,
            creator: admin.address,
            proposer: { wallet: proposer.address, enrollment: enrollmentAccounts[1].enrollment },
            approver: { wallet: approver.address, enrollment: enrollmentAccounts[2].enrollment } },
          { address: acceptance.terms, owner: response.value.owner, executable: response.value.executable,
            data: new Uint8Array(getBase64Encoder().encode(response.value.data[0])) });
          return localBootstrapReviewerAcceptanceComplete(account.acceptanceBits, bit);
        } });
    }
    activeBootstrapStage = "market-seal"; await publish("seal");
    activeBootstrapStage = "market-activate"; await publish("activate");
    activeBootstrapStage = "market-status"; await publish("status");

    activeBootstrapStage = "participant-seat-and-deposit";
    const snapshot = await readGooseyEscrow(runtime, { marketId: BigInt(state.marketId), wallet: participant.address }, { signal, includeMarketTerms: true });
    assert(snapshot.marketTerms?.sealed && snapshot.marketTerms.acceptanceBits === 3 && snapshot.resolution?.phase === 0 && snapshot.orderBook);
    const registration = await buildRegisterSeatInstruction({ programAddress: runtime.programAddress,
      marketId: BigInt(state.marketId), seats, wallet: participant, rentPayer: admin });
    await exactTransaction({ kind: "participant-seat-registration", file: path.join(receipts, "participant-seat-registration.json"), runtime,
      payer: admin, instructions: [registration.instruction], signal, complete: async () => {
        const value = await readGooseyEscrow(runtime, { marketId: BigInt(state.marketId), wallet: participant.address }, { signal }); return value.seat !== null;
      } });
    const depositAmount = BigInt(state.allowance) / 2n;
    const afterSeat = await readGooseyEscrow(runtime, { marketId: BigInt(state.marketId), wallet: participant.address }, { signal });
    assert(afterSeat.seat);
    const deposit = await buildDepositInstruction({ programAddress: runtime.programAddress, marketId: BigInt(state.marketId), seats,
      wallet: participant, amount: depositAmount, expectedNonce: 0n });
    await exactTransaction({ kind: "participant-escrow-deposit", file: path.join(receipts, "participant-escrow-deposit.json"), runtime,
      payer: participant, instructions: [deposit.instruction], signal, complete: async () => {
        const value = await readGooseyEscrow(runtime, { marketId: BigInt(state.marketId), wallet: participant.address }, { signal });
        return value.seat !== null && value.seat.nextNonce >= 1n;
      } });

    activeBootstrapStage = "index-finalized-events";
    const coverage = JSON.parse((await privateRead(path.join(receipts, "enrollment-creator.json"))).toString("utf8")).signature;
    const indexingMode = localBootstrapIndexingMode(await readIngestionCursor(runtime), coverage);
    if (indexingMode === "index-bootstrap-boundary") {
      for (let page = 0; page < 100; page++) {
        const result = await ingestFinalizedProgramPage(runtime, coverage, { pageSize: 100, signal });
        if (result.cursor.backfillComplete && (result.status === "window-complete" || result.status === "idle")) break;
        assert(page < 99, "Indexer did not reach the retained bootstrap boundary within 100 pages");
      }
    }
    activeBootstrapStage = "publish-catalog";
    const { db, requireDatabaseStartup } = await import("../src/lib/db");
    try {
      await requireDatabaseStartup();
      const service = await import("../src/lib/solana/market-catalog");
      const slug = localBootstrapSlug(genesisHash);
      const catalog = { actorUserId: options.actorUserId, runtime, termsDirectory, chainMarketId: BigInt(state.marketId), signal,
        metadata: { slug, shortTitle: "HTN localnet first match",
          description: "A genuine on-chain Goosey development market tracking whether this Hack the North local arena records a matched trade.", category: "Hack the North" } };
      await service.registerSolanaMarket(catalog); await service.publishSolanaMarket(catalog);
    } finally { await db.$disconnect(); }
    activeBootstrapStage = "final-verification";
    const final = await readGooseyEscrow(runtime, { marketId: BigInt(state.marketId), wallet: participant.address }, { signal, includeMarketTerms: true });
    assert(final.marketTerms?.sealed && final.resolution?.phase === 0 && final.seat);
    console.log(JSON.stringify({ event: "goosey_local_market_ready", cluster: "localnet", rpc: RPC,
      marketId: state.marketId, slug: localBootstrapSlug(genesisHash), participant: participant.address,
      indexing: indexingMode,
      note: "Private keys and exact signed receipts remain only in the private bootstrap state directory." }));
  } finally {
    await unlink(lock); const dir = await open(options.stateDirectory, constants.O_RDONLY); try { await dir.sync(); } finally { await dir.close(); }
    process.removeListener("SIGINT", stop); process.removeListener("SIGTERM", stop);
  }
}

export async function runLocalBootstrapCli(args: readonly string[]) {
  const options = parseLocalBootstrapArguments(args);
  if (options.mode === "help") { console.log(localBootstrapHelp); return 0; }
  try { await run(options); return 0; }
  catch {
    console.error(JSON.stringify({ event: "goosey_local_market_bootstrap_stopped",
      stage: activeBootstrapStage,
      message: "Bootstrap stopped safely. Inspect the private state and retained receipts, then rerun the exact same command; do not delete receipts or reset the validator." }));
    return 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void runLocalBootstrapCli(process.argv.slice(2)).then(code => { process.exitCode = code; });
}
