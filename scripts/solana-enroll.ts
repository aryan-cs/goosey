/** Explicit operator enrollment. Importing this module performs no I/O. */
import assert from "node:assert/strict";
import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { address, appendTransactionMessageInstructions, blockhash, compileTransaction, createKeyPairSignerFromBytes,
  createNoopSigner, createSolanaRpc, createTransactionMessage, getBase64Encoder, getTransactionDecoder, pipe,
  setTransactionMessageFeePayerSigner, setTransactionMessageLifetimeUsingBlockhash, signTransactionMessageWithSigners } from "@solana/kit";
import { prepareEnrollment } from "../src/lib/solana/prepare-enrollment";
import { buildAuthorizeEnrollmentInstruction } from "../src/lib/solana/program-client";
import { resolveSolanaRuntime, type SolanaRuntime } from "../src/lib/solana/runtime";
import { submitSignedWalletTransaction } from "../src/lib/solana/submit-transfer";
import { createTransferReceiptStore } from "../src/lib/solana/transfer-receipts";
import { trackTransactionStatus } from "../src/lib/solana/transaction-status";

export const enrollmentHelp = `Usage:
  node --import tsx scripts/solana-enroll.ts submit --authority-keyfile /absolute/issuer.json --wallet ADDRESS --identity-digest 64_HEX_CHARACTERS --allowance BASE_UNITS --expires-at UNIX_SECONDS --receipt /absolute/private/new-receipt.json
  node --import tsx scripts/solana-enroll.ts status --receipt /absolute/private/existing-receipt.json
Require all four GOOSEY_SOLANA_CLUSTER/RPC_URL/PROGRAM_ID/GENESIS_HASH environment values explicitly.
Localnet/devnet only. submit explicitly authorizes ONE enrollment and signs with the issuer keyfile.
The issuer pays rent/fees from existing SOL. No funding, eligibility inference, claims, replacement or resend.
Receipt parent must already be canonical, owned by you, and private (0700). Receipt creation is exclusive (0600).
status is read-only and needs no keyfile. Never replace an uncertain transaction; inspect its retained signature.`;

const unsignedDecimal = /^(0|[1-9][0-9]{0,19})$/;
function integer(value: string, maximum: bigint, positive = true) {
  assert(unsignedDecimal.test(value), "Expected canonical decimal integer");
  const result = BigInt(value);
  assert(result >= (positive ? 1n : 0n) && result <= maximum, "Integer outside allowed range");
  return result;
}
function absolute(value: string) {
  assert(path.isAbsolute(value) && path.normalize(value) === value && value !== path.parse(value).root,
    "Expected normalized absolute file path");
  return value;
}
export function parseEnrollmentArguments(args: readonly string[]) {
  const [mode, ...rest] = args;
  assert(mode === "submit" || mode === "status", "Expected submit or status; use --help");
  const allowed = mode === "submit" ? ["--authority-keyfile", "--wallet", "--identity-digest", "--allowance", "--expires-at", "--receipt"] : ["--receipt"];
  const values = new Map<string, string>();
  for (let i = 0; i < rest.length; i += 2) {
    const name = rest[i], value = rest[i + 1];
    assert(allowed.includes(name) && !values.has(name) && value && !value.startsWith("--"), "Unknown, duplicate or incomplete option");
    values.set(name, value);
  }
  assert(allowed.every(name => values.has(name)), "Every mode option is required; no default grants");
  const receiptPath = absolute(values.get("--receipt")!);
  if (mode === "status") return { mode, receiptPath } as const;
  const identityDigestHex = values.get("--identity-digest")!;
  assert(/^[0-9a-fA-F]{64}$/.test(identityDigestHex) && !/^0+$/.test(identityDigestHex), "Expected explicit nonzero 32-byte hex identity digest");
  const wallet = address(values.get("--wallet")!);
  assert(wallet !== "11111111111111111111111111111111", "Target wallet must be nonzero");
  const authorityKeyfile = absolute(values.get("--authority-keyfile")!);
  assert(authorityKeyfile !== receiptPath, "Receipt must not be the authority keyfile");
  return { mode, receiptPath, authorityKeyfile, wallet, identityDigest: Uint8Array.from(Buffer.from(identityDigestHex, "hex")),
    allowance: integer(values.get("--allowance")!, (1n << 64n) - 1n),
    expiresAt: integer(values.get("--expires-at")!, (1n << 63n) - 1n) } as const;
}
export function enrollmentRuntime(env: Record<string, string | undefined>) {
  for (const name of ["GOOSEY_SOLANA_CLUSTER", "GOOSEY_SOLANA_RPC_URL", "GOOSEY_SOLANA_PROGRAM_ID", "GOOSEY_SOLANA_GENESIS_HASH"]) {
    assert(typeof env[name] === "string" && env[name]!.length > 0, `Explicit ${name} required`);
  }
  return resolveSolanaRuntime({ ...env });
}
async function privateParent(file: string) {
  absolute(file);
  const parent = path.dirname(file);
  assert.equal(await realpath(parent), parent, "File parent must be canonical, without symlink ancestors");
  const stat = await lstat(parent);
  assert(stat.isDirectory() && stat.uid === process.getuid?.() && (stat.mode & 0o077) === 0, "File parent must be owned and private");
  return parent;
}
export async function requireNewEnrollmentReceipt(file: string) {
  await privateParent(file);
  try { await lstat(file); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
  throw new Error("Receipt already exists; use status, never replace it");
}
export async function persistEnrollmentReceipt(file: string, text: string) {
  assert(Buffer.byteLength(text) <= 16_384, "Receipt exceeds bound");
  const parent = await privateParent(file);
  const fd = await open(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { await fd.writeFile(text); await fd.sync(); } finally { await fd.close(); }
  // Sync the directory entry too. Any persistence error prevents the sender callback returning.
  const directory = await open(parent, constants.O_RDONLY | constants.O_NOFOLLOW);
  try { await directory.sync(); } finally { await directory.close(); }
}
export async function readPrivateEnrollmentFile(file: string, maximumBytes: number) {
  await privateParent(file);
  const fd = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await fd.stat();
    assert(stat.isFile() && stat.nlink === 1 && stat.uid === process.getuid?.() && (stat.mode & 0o077) === 0
      && stat.size > 0 && stat.size <= maximumBytes, "Unsafe or oversized private file");
    // Bounded even if a different writer grows the file after fstat.
    const bytes = Buffer.alloc(maximumBytes + 1);
    let count = 0;
    while (count < bytes.length) {
      const result = await fd.read(bytes, count, bytes.length - count, null);
      if (result.bytesRead === 0) break;
      count += result.bytesRead;
    }
    assert(count <= maximumBytes, "Private file grew beyond bound");
    return bytes.subarray(0, count);
  } finally { await fd.close(); }
}
export async function loadEnrollmentAuthority(file: string) {
  const bytes = await readPrivateEnrollmentFile(file, 4096);
  let values: unknown;
  try {
    values = JSON.parse(bytes.toString("utf8"));
    assert(Array.isArray(values) && values.length === 64 && values.every(n => Number.isInteger(n) && n >= 0 && n <= 255), "Invalid Solana CLI keypair byte array");
    const secret = Uint8Array.from(values);
    try { return await createKeyPairSignerFromBytes(secret); } finally { secret.fill(0); }
  } finally { bytes.fill(0); if (Array.isArray(values)) values.fill(0); }
}

const receiptSchema = z.object({ version: z.literal(1), kind: z.literal("goosey-enrollment"),
  cluster: z.enum(["localnet", "devnet"]), genesisHash: z.string(), programAddress: z.string(), authority: z.string(),
  wallet: z.string(), identityDigestHex: z.string().regex(/^[0-9a-f]{64}$/), allowance: z.string().regex(unsignedDecimal),
  expiresAt: z.string().regex(unsignedDecimal), blockhash: z.string(), lastValidBlockHeight: z.string().regex(unsignedDecimal),
  signature: z.string(), signedWireBase64: z.string().max(1644),
}).strict();
export async function validateEnrollmentReceipt(text: string, runtime: SolanaRuntime) {
  assert(Buffer.byteLength(text) <= 16_384, "Receipt exceeds bound");
  const receipt = receiptSchema.parse(JSON.parse(text));
  assert(receipt.cluster === runtime.cluster && receipt.genesisHash === runtime.genesisHash && receipt.programAddress === runtime.programAddress,
    "Receipt network/program does not match explicit runtime");
  // Reuse the shipping signature/canonical-wire recovery validator via a private in-memory storage adapter.
  const entries = new Map<string, string>();
  const storage = { getItem: (key: string) => entries.get(key) ?? null, setItem: (key: string, value: string) => { entries.set(key, value); },
    key: (index: number) => [...entries.keys()][index] ?? null, get length() { return entries.size; } };
  const lastValidBlockHeight = integer(receipt.lastValidBlockHeight, (1n << 64n) - 1n, false);
  await createTransferReceiptStore(storage, { ...runtime, walletAddress: receipt.authority }).persist({
    signature: receipt.signature, signedWireBase64: receipt.signedWireBase64, lastValidBlockHeight });
  const signer = createNoopSigner(address(receipt.authority));
  const plan = await buildAuthorizeEnrollmentInstruction({ programAddress: runtime.programAddress, enrollmentAuthority: signer,
    wallet: address(receipt.wallet), identityDigest: Uint8Array.from(Buffer.from(receipt.identityDigestHex, "hex")),
    allowance: integer(receipt.allowance, (1n << 64n) - 1n), expiresAt: integer(receipt.expiresAt, (1n << 63n) - 1n) });
  const expected = compileTransaction(pipe(createTransactionMessage({ version: 0 }), m => setTransactionMessageFeePayerSigner(signer, m),
    m => setTransactionMessageLifetimeUsingBlockhash({ blockhash: blockhash(receipt.blockhash), lastValidBlockHeight }, m),
    m => appendTransactionMessageInstructions([plan.instruction], m)));
  const actual = getTransactionDecoder().decode(getBase64Encoder().encode(receipt.signedWireBase64));
  assert.deepEqual(new Uint8Array(actual.messageBytes), new Uint8Array(expected.messageBytes), "Signed receipt differs from enrollment intent");
  return { ...receipt, lastValidBlockHeight };
}

export async function runEnrollmentCli(args: readonly string[], env: Record<string, string | undefined> = process.env) {
  if (args.length === 1 && ["--help", "-h"].includes(args[0])) { console.log(enrollmentHelp); return; }
  const options = parseEnrollmentArguments(args), runtime = enrollmentRuntime(env);
  const signal = AbortSignal.timeout(45_000);
  if (options.mode === "status") {
    const receipt = await validateEnrollmentReceipt((await readPrivateEnrollmentFile(options.receiptPath, 16_384)).toString("utf8"), runtime);
    const rpc = createSolanaRpc(runtime.rpcUrl);
    assert.equal(await rpc.getGenesisHash().send({ abortSignal: signal }), runtime.genesisHash, "Status RPC genesis mismatch");
    const status = await trackTransactionStatus(rpc, { signature: receipt.signature, lastValidBlockHeight: receipt.lastValidBlockHeight,
      commitment: "finalized", timeoutMs: 15_000, signal });
    assert.equal(await rpc.getGenesisHash().send({ abortSignal: signal }), runtime.genesisHash, "Status RPC genesis changed");
    console.log(JSON.stringify({ status: status.status, signature: status.signature, commitment: status.commitment,
      historicalOutcome: status.historicalOutcome, sent: false }));
    if (status.status !== "finalized") process.exitCode = 2;
    return;
  }
  await requireNewEnrollmentReceipt(options.receiptPath);
  const enrollmentAuthority = await loadEnrollmentAuthority(options.authorityKeyfile);
  const prepared = await prepareEnrollment({ runtime, enrollmentAuthority, wallet: options.wallet, identityDigest: options.identityDigest,
    allowance: options.allowance, expiresAt: options.expiresAt, signal });
  const signed = await signTransactionMessageWithSigners(prepared.message);
  const result = await submitSignedWalletTransaction({ runtime, prepared, signed, signal, onPrepared: async receipt => {
    const text = JSON.stringify({ version: 1, kind: "goosey-enrollment", cluster: runtime.cluster, genesisHash: runtime.genesisHash,
      programAddress: runtime.programAddress, authority: enrollmentAuthority.address, wallet: prepared.wallet,
      identityDigestHex: Buffer.from(prepared.identityDigest).toString("hex"), allowance: prepared.allowance.toString(),
      expiresAt: prepared.expiresAt.toString(), blockhash: prepared.lifetime.blockhash,
      ...receipt, lastValidBlockHeight: receipt.lastValidBlockHeight.toString() }, null, 2) + "\n";
    await validateEnrollmentReceipt(text, runtime);
    await persistEnrollmentReceipt(options.receiptPath, text);
  } });
  console.log(JSON.stringify({ status: result.status, signature: result.signature,
    message: "Submission is not finality. Inspect this receipt using status; no replacement or retry was sent." }));
  if (result.status === "unknown") process.exitCode = 2;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void runEnrollmentCli(process.argv.slice(2)).catch(() => {
    // Do not echo arbitrary provider errors, key JSON, digests, private paths or signed wire.
    console.error("Enrollment command stopped. Check explicit arguments, private files, issuer/caps/chain state. If a receipt exists, inspect status; never replace an uncertain transaction.");
    process.exitCode = 1;
  });
}
