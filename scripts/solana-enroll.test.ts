import { generateKeyPairSync } from "node:crypto";
import { mkdtemp, readFile, realpath, rm, stat, symlink, writeFile, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { address, appendTransactionMessageInstructions, blockhash, createKeyPairSignerFromBytes, createTransactionMessage,
  getBase64EncodedWireTransaction, getSignatureFromTransaction, pipe, setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash, signTransactionMessageWithSigners } from "@solana/kit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildAuthorizeEnrollmentInstruction } from "../src/lib/solana/program-client";
import { enrollmentRuntime, loadEnrollmentAuthority, parseEnrollmentArguments, persistEnrollmentReceipt,
  readPrivateEnrollmentFile, requireNewEnrollmentReceipt, runEnrollmentCli, validateEnrollmentReceipt } from "./solana-enroll";

const mocks = vi.hoisted(() => ({ prepare: vi.fn(), send: vi.fn(), genesis: vi.fn(), statuses: vi.fn() }));
vi.mock("../src/lib/solana/prepare-enrollment", () => ({ prepareEnrollment: mocks.prepare }));
vi.mock("@solana/kit", async original => ({ ...await original<typeof import("@solana/kit")>(), createSolanaRpc: () => ({
  getGenesisHash: () => ({ send: mocks.genesis }), getBlockHeight: () => ({ send: async () => 10n }),
  sendTransaction: (wire: string) => ({ send: () => mocks.send(wire) }), getSignatureStatuses: () => ({ send: mocks.statuses }),
}) }));
const env = { GOOSEY_SOLANA_CLUSTER: "localnet", GOOSEY_SOLANA_RPC_URL: "http://127.0.0.1:18999",
  GOOSEY_SOLANA_PROGRAM_ID: "CgEGAD3EGLm63YaSx58sRiNPQmmxg8RqvqcxE3xThX8Q",
  GOOSEY_SOLANA_GENESIS_HASH: "Bax5P2GmYBb2P6UjJFmEVys7cpRzY4A85ncAJqtgvSsm" };
const runtime = enrollmentRuntime(env), wallet = address("B65XrNy82H9MeHnxxBihjUnwaRM9fXiMfTsCBuw2GvDo");
let directory: string;
const receiptFile = () => path.join(directory, "receipt.json");
const keyfile = () => path.join(directory, "issuer.json");
const args = () => ["submit", "--authority-keyfile", keyfile(), "--wallet", wallet, "--identity-digest", "12".repeat(32),
  "--allowance", "1000", "--expires-at", "200", "--receipt", receiptFile()];
async function fixture() {
  const jwk = generateKeyPairSync("ed25519").privateKey.export({ format: "jwk" });
  const secret = Buffer.concat([Buffer.from(jwk.d!, "base64url"), Buffer.from(jwk.x!, "base64url")]);
  try { await writeFile(keyfile(), JSON.stringify([...secret]), { flag: "wx", mode: 0o600 }); }
  finally { secret.fill(0); delete jwk.d; }
  const signer = await loadEnrollmentAuthority(keyfile());
  const identityDigest = new Uint8Array(32).fill(0x12), allowance = 1000n, expiresAt = 200n;
  const plan = await buildAuthorizeEnrollmentInstruction({ programAddress: runtime.programAddress,
    enrollmentAuthority: signer, wallet, identityDigest, allowance, expiresAt });
  const lifetime = { blockhash: blockhash(runtime.genesisHash), lastValidBlockHeight: 100n };
  const message = pipe(createTransactionMessage({ version: 0 }), m => setTransactionMessageFeePayerSigner(signer, m),
    m => setTransactionMessageLifetimeUsingBlockhash(lifetime, m), m => appendTransactionMessageInstructions([plan.instruction], m));
  const prepared = { message, sender: signer.address, cluster: runtime.cluster, genesisHash: runtime.genesisHash,
    wallet, identityDigest, allowance, expiresAt, lifetime };
  const signed = await signTransactionMessageWithSigners(message);
  const receipt = { version: 1, kind: "goosey-enrollment", cluster: runtime.cluster, genesisHash: runtime.genesisHash,
    programAddress: runtime.programAddress, authority: signer.address, wallet, identityDigestHex: "12".repeat(32),
    allowance: "1000", expiresAt: "200", blockhash: lifetime.blockhash, lastValidBlockHeight: "100",
    signature: getSignatureFromTransaction(signed), signedWireBase64: getBase64EncodedWireTransaction(signed) };
  return { prepared, receipt };
}
beforeEach(async () => {
  vi.resetAllMocks(); directory = await realpath(await mkdtemp(path.join(tmpdir(), "goosey-enroll-cli-")));
  await chmod(directory, 0o700); mocks.genesis.mockResolvedValue(runtime.genesisHash);
  vi.spyOn(console, "log").mockImplementation(() => undefined);
});
afterEach(async () => { vi.restoreAllMocks(); process.exitCode = 0; await rm(directory, { recursive: true, force: true }); });

describe("operator enrollment CLI: private disposable files and mocked RPC", () => {
  it("parses explicit exact arguments and read-only status", () => {
    expect(parseEnrollmentArguments(args())).toMatchObject({ mode: "submit", wallet, allowance: 1000n, expiresAt: 200n,
      identityDigest: new Uint8Array(32).fill(0x12) });
    expect(parseEnrollmentArguments(["status", "--receipt", receiptFile()])).toEqual({ mode: "status", receiptPath: receiptFile() });
  });
  it.each(["missing", "duplicate", "unknown", "zero", "float", "exponent", "overflow", "digest", "relative"])("rejects %s arguments", change => {
    const value = args();
    if (change === "missing") value.splice(1, 2);
    if (change === "duplicate") value.push("--receipt", receiptFile());
    if (change === "unknown") value.push("--fund", "1");
    if (["zero", "float", "exponent", "overflow"].includes(change)) value[value.indexOf("--allowance") + 1] =
      ({ zero: "0", float: "1.2", exponent: "1e3", overflow: "18446744073709551616" } as Record<string, string>)[change];
    if (change === "digest") value[value.indexOf("--identity-digest") + 1] = "00".repeat(32);
    if (change === "relative") value[value.indexOf("--receipt") + 1] = "relative.json";
    expect(() => parseEnrollmentArguments(value)).toThrow();
  });
  it.each(Object.keys(env))("requires explicit runtime field %s", field => {
    const value: Record<string, string | undefined> = { ...env }; delete value[field]; expect(() => enrollmentRuntime(value)).toThrow();
  });
  it("help performs no preparation or send", async () => {
    await runEnrollmentCli(["--help"], {}); expect(mocks.prepare).not.toHaveBeenCalled(); expect(mocks.send).not.toHaveBeenCalled();
  });
  it("retains exact private bytes exclusively and refuses replacement", async () => {
    await requireNewEnrollmentReceipt(receiptFile());
    await persistEnrollmentReceipt(receiptFile(), "private receipt bytes\n");
    expect(await readPrivateEnrollmentFile(receiptFile(), 128)).toEqual(Buffer.from("private receipt bytes\n"));
    expect((await stat(receiptFile())).mode & 0o777).toBe(0o600);
    await expect(requireNewEnrollmentReceipt(receiptFile())).rejects.toThrow("already exists");
    await expect(persistEnrollmentReceipt(receiptFile(), "replacement")).rejects.toThrow();
    expect(await readFile(receiptFile(), "utf8")).toBe("private receipt bytes\n");
  });
  it("rejects symlink destinations, nonprivate parents/files and oversized reads", async () => {
    await writeFile(keyfile(), "key-placeholder", { mode: 0o600 });
    await symlink(keyfile(), receiptFile());
    await expect(persistEnrollmentReceipt(receiptFile(), "overwrite")).rejects.toThrow();
    await expect(readPrivateEnrollmentFile(receiptFile(), 100)).rejects.toThrow();
    await expect(readPrivateEnrollmentFile(keyfile(), 2)).rejects.toThrow();
    await chmod(keyfile(), 0o644); await expect(readPrivateEnrollmentFile(keyfile(), 100)).rejects.toThrow();
    await chmod(directory, 0o755); await expect(requireNewEnrollmentReceipt(path.join(directory, "new.json"))).rejects.toThrow();
  });
  it("loads a real CLI keypair and rejects malformed byte arrays", async () => {
    const f = await fixture(); expect((await loadEnrollmentAuthority(keyfile())).address).toBe(f.receipt.authority);
    await writeFile(path.join(directory, "invalid.json"), "[1,2,3]", { mode: 0o600 });
    await expect(loadEnrollmentAuthority(path.join(directory, "invalid.json"))).rejects.toThrow("byte array");
    // Public half mismatch is checked by the shipping signer parser.
    const bytes = new Uint8Array(64).fill(1);
    await expect(createKeyPairSignerFromBytes(bytes)).rejects.toThrow();
  });
  it("validates a real signed wire against exact intent and retained signature", async () => {
    const f = await fixture(); expect(await validateEnrollmentReceipt(JSON.stringify(f.receipt), runtime)).toMatchObject({
      signature: f.receipt.signature, lastValidBlockHeight: 100n });
    for (const patch of [{ allowance: "1001" }, { wallet: runtime.programAddress }, { identityDigestHex: "13".repeat(32) },
      { blockhash: wallet }, { genesisHash: wallet }, { signedWireBase64: "AAAA" }, { extra: "unexpected" }]) {
      await expect(validateEnrollmentReceipt(JSON.stringify({ ...f.receipt, ...patch }), runtime)).rejects.toThrow();
    }
  });
  it("persists the authentic receipt before its one send and does not infer finality", async () => {
    const f = await fixture(); mocks.prepare.mockResolvedValue(f.prepared);
    mocks.send.mockImplementation(async wire => {
      const saved = await validateEnrollmentReceipt(await readFile(receiptFile(), "utf8"), runtime);
      expect(saved.signedWireBase64).toBe(wire); expect(saved.signature).toBe(f.receipt.signature);
      expect((await stat(receiptFile())).mode & 0o777).toBe(0o600);
      return saved.signature;
    });
    await runEnrollmentCli(args(), env);
    expect(mocks.send).toHaveBeenCalledTimes(1);
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('"status":"submitted"'));
    await expect(runEnrollmentCli(args(), env)).rejects.toThrow("already exists");
    expect(mocks.prepare).toHaveBeenCalledTimes(1); expect(mocks.send).toHaveBeenCalledTimes(1);
  });
  it("never sends if receipt persistence loses an exclusive-create race", async () => {
    const f = await fixture(); mocks.prepare.mockImplementation(async () => {
      await writeFile(receiptFile(), "other writer", { flag: "wx", mode: 0o600 }); return f.prepared;
    });
    await expect(runEnrollmentCli(args(), env)).rejects.toThrow(); expect(mocks.send).not.toHaveBeenCalled();
    expect(await readFile(receiptFile(), "utf8")).toBe("other writer");
  });
  it("retains unknown outcomes without re-signing or retrying", async () => {
    const f = await fixture(); mocks.prepare.mockResolvedValue(f.prepared); mocks.send.mockRejectedValue(new Error("connection lost"));
    await runEnrollmentCli(args(), env);
    expect(process.exitCode).toBe(2); expect(mocks.send).toHaveBeenCalledTimes(1);
    expect(await validateEnrollmentReceipt(await readFile(receiptFile(), "utf8"), runtime)).toMatchObject({ signature: f.receipt.signature });
  });
  it("status validates retained intent and checks finality without key loading or sending", async () => {
    const f = await fixture(); await persistEnrollmentReceipt(receiptFile(), JSON.stringify(f.receipt));
    await rm(keyfile());
    mocks.statuses.mockResolvedValue({ context: { slot: 20n }, value: [{ slot: 15n, confirmations: null, confirmationStatus: "finalized", err: null }] });
    await runEnrollmentCli(["status", "--receipt", receiptFile()], env);
    expect(mocks.prepare).not.toHaveBeenCalled(); expect(mocks.send).not.toHaveBeenCalled();
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('"status":"finalized"'));
  });
});
