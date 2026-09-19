/** Actual CLI proof, exclusively inside the fresh isolated runner contract. */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash, generateKeyPairSync, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { readFile, realpath, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { address, appendTransactionMessageInstructions, createSolanaRpc, createTransactionMessage,
  generateKeyPairSigner, getAddressDecoder, getBase64EncodedWireTransaction, getSignatureFromTransaction, pipe,
  setTransactionMessageFeePayerSigner, setTransactionMessageLifetimeUsingBlockhash, signTransactionMessageWithSigners } from "@solana/kit";
import { buildInitializeInstruction, deriveGooseyEnrollmentAddresses, deriveGooseyProgramAddresses } from "../src/lib/solana/program-client";
import { resolveSolanaRuntime } from "../src/lib/solana/runtime";
import { trackTransactionStatus } from "../src/lib/solana/transaction-status";
import { loadEnrollmentAuthority, validateEnrollmentReceipt } from "./solana-enroll";

const execute = promisify(execFile);
const PROGRAM = address("CgEGAD3EGLm63YaSx58sRiNPQmmxg8RqvqcxE3xThX8Q");
const CLOCK = address("SysvarC1ock11111111111111111111111111111111");
const hash = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest();

async function main() {
  const adminPath = await realpath(process.env.GOOSEY_SOLANA_TEST_ADMIN_KEYPAIR ?? "missing-admin");
  const directory = path.dirname(adminPath), temporaryRoot = await realpath("/tmp");
  const relative = path.relative(temporaryRoot, adminPath).split(path.sep);
  assert(relative.length === 2 && /^goosey-solana-runner-[A-Za-z0-9]+$/.test(relative[0])
    && relative[1] === "goosey-admin-keypair.json", "Fresh isolated-runner key required");
  const manifest = JSON.parse(await readFile(path.join(directory, "manifest.json"), "utf8"));
  assert.equal(manifest.suite, "enrollment");
  const runtime = resolveSolanaRuntime({ GOOSEY_SOLANA_CLUSTER: "localnet", GOOSEY_SOLANA_RPC_URL: process.env.GOOSEY_SOLANA_RPC_URL,
    GOOSEY_SOLANA_PROGRAM_ID: PROGRAM, GOOSEY_SOLANA_GENESIS_HASH: process.env.GOOSEY_SOLANA_GENESIS_HASH });
  assert.equal(runtime.rpcUrl.replace(/\/$/, ""), manifest.rpc);
  assert.equal(runtime.genesisHash, manifest.genesis);
  assert(Number(new URL(runtime.rpcUrl).port) >= 30000, "Only fresh runner port allowed");
  const artifactPath = await realpath(manifest.loadedArtifact);
  assert.equal(path.dirname(artifactPath), directory);
  const artifactHash = hash(await readFile(artifactPath)).toString("hex");
  assert.equal(artifactHash, manifest.artifactSha256);
  const rpc = createSolanaRpc(runtime.rpcUrl), admin = await loadEnrollmentAuthority(adminPath);
  assert.equal(admin.address, manifest.admin);
  assert.equal(await rpc.getGenesisHash().send(), runtime.genesisHash);
  const pdas = await deriveGooseyProgramAddresses(PROGRAM);
  const initial = await rpc.getMultipleAccounts([PROGRAM, pdas.programData, pdas.config, pdas.featherMint], { commitment: "confirmed", encoding: "base64" }).send();
  assert(initial.value[0]?.executable && initial.value[0].owner === "BPFLoaderUpgradeab1e11111111111111111111111");
  const programBytes = Buffer.from(initial.value[0].data[0], "base64");
  assert.equal(programBytes.readUInt32LE(0), 2); assert.equal(getAddressDecoder().decode(programBytes.subarray(4, 36)), pdas.programData);
  assert.equal(initial.value[1]?.owner, initial.value[0].owner);
  const deployed = Buffer.from(initial.value[1]!.data[0], "base64");
  assert.equal(deployed.readUInt32LE(0), 3); assert.equal(deployed[12], 1);
  assert.equal(getAddressDecoder().decode(deployed.subarray(13, 45)), admin.address);
  assert.equal(initial.value[2], null); assert.equal(initial.value[3], null);
  const initialization = await buildInitializeInstruction({ programAddress: PROGRAM, admin, environment: 1,
    genesisDomain: hash(runtime.genesisHash), enrollmentAuthority: admin.address, perWalletCap: 1000n, campaignCap: 1500n });
  const life = (await rpc.getLatestBlockhash({ commitment: "confirmed" }).send()).value;
  const message = pipe(createTransactionMessage({ version: 0 }), m => setTransactionMessageFeePayerSigner(admin, m),
    m => setTransactionMessageLifetimeUsingBlockhash(life, m), m => appendTransactionMessageInstructions([initialization.instruction], m));
  const signed = await signTransactionMessageWithSigners(message), initializationSignature = getSignatureFromTransaction(signed);
  assert.equal(await rpc.sendTransaction(getBase64EncodedWireTransaction(signed), { encoding: "base64", preflightCommitment: "confirmed", maxRetries: 0n }).send(), initializationSignature);
  assert.equal((await trackTransactionStatus(rpc, { signature: initializationSignature, lastValidBlockHeight: life.lastValidBlockHeight, timeoutMs: 60000 })).status, "finalized");
  const wallet = (await generateKeyPairSigner()).address, otherWallet = (await generateKeyPairSigner()).address;
  const identity = randomBytes(32), otherIdentity = randomBytes(32);
  const addresses = await deriveGooseyEnrollmentAddresses({ programAddress: PROGRAM, wallet, identityDigest: identity });
  const clock = await rpc.getAccountInfo(CLOCK, { commitment: "finalized", encoding: "base64" }).send();
  const expiry = Buffer.from(clock.value!.data[0], "base64").readBigInt64LE(32) + 3600n;
  const receiptPath = path.join(directory, "enrollment-cli-receipt.json");
  let pendingReceiptPath = receiptPath, sends = 0, persistedBeforeSend = false;
  let proxyFailure: unknown;
  // Transparent loopback RPC observer: all responses come from the actual validator.
  // At send interception verify durable file contents, then forward the exact bytes.
  const proxy = createServer(async (request, response) => {
    try {
      const chunks: Buffer[] = []; let size = 0;
      for await (const chunk of request) { size += chunk.length; assert(size < 65536); chunks.push(Buffer.from(chunk)); }
      const body = Buffer.concat(chunks), call = JSON.parse(body.toString());
      if (call.method === "sendTransaction") {
        const saved = await validateEnrollmentReceipt(await readFile(pendingReceiptPath, "utf8"), runtime);
        assert.equal(saved.signedWireBase64, call.params[0]);
        assert.equal((await stat(pendingReceiptPath)).mode & 0o777, 0o600);
        const prior = await rpc.getSignatureStatuses([saved.signature as Parameters<typeof rpc.getSignatureStatuses>[0][number]], { searchTransactionHistory: true }).send();
        assert.equal(prior.value[0], null, "Receipt must precede first execution");
        persistedBeforeSend = true; sends++;
      }
      const upstream = await fetch(runtime.rpcUrl, { method: "POST", headers: { "content-type": "application/json" }, body,
        signal: AbortSignal.timeout(15000) });
      response.writeHead(upstream.status, { "content-type": "application/json" }); response.end(await upstream.text());
    } catch (error) { proxyFailure = error; response.writeHead(500); response.end("RPC observer failed"); }
  });
  await new Promise<void>(resolve => proxy.listen(0, "127.0.0.1", resolve));
  const listener = proxy.address(); assert(listener && typeof listener !== "string");
  const cliEnv = { ...process.env, GOOSEY_SOLANA_CLUSTER: "localnet", GOOSEY_SOLANA_RPC_URL: `http://127.0.0.1:${listener.port}`,
    GOOSEY_SOLANA_PROGRAM_ID: PROGRAM, GOOSEY_SOLANA_GENESIS_HASH: runtime.genesisHash };
  const baseArgs = ["submit", "--authority-keyfile", adminPath, "--wallet", wallet, "--identity-digest", identity.toString("hex"),
    "--allowance", "1000", "--expires-at", expiry.toString(), "--receipt", receiptPath];
  const run = (args: string[]) => execute(process.execPath, ["--import", "tsx", "scripts/solana-enroll.ts", ...args],
    { env: cliEnv, timeout: 60000, maxBuffer: 65536 });
  const evidence: Record<string, unknown>[] = [];
  try {
    const output = await run(baseArgs); assert(!proxyFailure, "Proxy validation failed");
    const submission = JSON.parse(output.stdout); assert.equal(submission.status, "submitted"); assert.equal(sends, 1); assert(persistedBeforeSend);
    const savedBytes = await readFile(receiptPath), savedHash = hash(savedBytes).toString("hex");
    const receipt = await validateEnrollmentReceipt(savedBytes.toString(), runtime);
    assert.equal((await trackTransactionStatus(rpc, { signature: receipt.signature, lastValidBlockHeight: receipt.lastValidBlockHeight, timeoutMs: 60000 })).status, "finalized");
    const transaction = await rpc.getTransaction(receipt.signature as Parameters<typeof rpc.getTransaction>[0], { commitment: "finalized", encoding: "json", maxSupportedTransactionVersion: 0 }).send();
    assert(transaction?.meta); assert.equal(transaction.meta.err, null);
    assert(transaction.meta.logMessages?.some(line => line.includes(`Program ${PROGRAM} invoke`)));
    const state = await rpc.getMultipleAccounts([addresses.enrollment, addresses.identity, pdas.config], { encoding: "base64", commitment: "finalized" }).send();
    const bytes = state.value.map(value => { assert(value && value.owner === PROGRAM && !value.executable); return Buffer.from(value.data[0], "base64"); });
    assert.equal(bytes[0].length, 129); assert.equal(bytes[1].length, 104);
    for (const [index, name] of [[0, "Enrollment"], [1, "EnrollmentIdentity"]] as const) {
      assert.deepEqual(bytes[index].subarray(0, 8), hash(`account:${name}`).subarray(0, 8));
      assert.equal(getAddressDecoder().decode(bytes[index].subarray(8, 40)), pdas.config);
      assert.equal(getAddressDecoder().decode(bytes[index].subarray(40, 72)), wallet);
      assert.deepEqual(bytes[index].subarray(72, 104), identity);
    }
    assert.equal(bytes[0].readBigUInt64LE(104), 1000n); assert.equal(bytes[0].readBigUInt64LE(112), 0n);
    assert.equal(bytes[0].readBigInt64LE(120), expiry); assert.equal(bytes[0][128], addresses.enrollmentBump);
    assert.equal(bytes[2].readBigUInt64LE(156), 1000n); assert.equal(bytes[2].readBigUInt64LE(164), 0n);
    evidence.push({ case: "CLI submit finalized exact enrollment/identity/caps", signature: receipt.signature,
      slot: transaction.slot.toString(), persistedBeforeSend, receiptSha256: savedHash });
    const wrongJwk = generateKeyPairSync("ed25519").privateKey.export({ format: "jwk" });
    const wrongBytes = Buffer.concat([Buffer.from(wrongJwk.d!, "base64url"), Buffer.from(wrongJwk.x!, "base64url")]);
    const wrongPath = path.join(directory, "wrong-issuer.json");
    try { await writeFile(wrongPath, JSON.stringify([...wrongBytes]), { flag: "wx", mode: 0o600 }); }
    finally { wrongBytes.fill(0); delete wrongJwk.d; }
    const otherAddresses = await deriveGooseyEnrollmentAddresses({ programAddress: PROGRAM, wallet: otherWallet, identityDigest: otherIdentity });
    const watch = [admin.address, pdas.config, pdas.featherMint, addresses.enrollment, addresses.identity, otherAddresses.enrollment, otherAddresses.identity];
    const watchState = async () => (await rpc.getMultipleAccounts(watch, { commitment: "finalized", encoding: "base64" }).send()).value;
    for (const name of ["same-receipt", "wrong-issuer", "per-wallet-cap", "campaign-remaining", "identity-replay", "wallet-replay"] as const) {
      const args = [...baseArgs];
      const set = (flag: string, value: string) => { args[args.indexOf(flag) + 1] = value; };
      pendingReceiptPath = name === "same-receipt" ? receiptPath : path.join(directory, `rejected-${name}.json`);
      set("--receipt", pendingReceiptPath);
      if (name !== "same-receipt") { set("--wallet", otherWallet); set("--identity-digest", otherIdentity.toString("hex")); set("--allowance", "1"); }
      if (name === "wrong-issuer") set("--authority-keyfile", wrongPath);
      if (name === "per-wallet-cap") set("--allowance", "1001");
      if (name === "campaign-remaining") set("--allowance", "501");
      if (name === "identity-replay") set("--identity-digest", identity.toString("hex"));
      if (name === "wallet-replay") set("--wallet", wallet);
      const before = await watchState();
      let rejected = false;
      try { await run(args); } catch (error) { assert.equal((error as { code?: number }).code, 1); rejected = true; }
      assert(rejected, `${name} was not rejected`); assert.equal(sends, 1); assert.deepEqual(await watchState(), before);
      assert.equal(hash(await readFile(receiptPath)).toString("hex"), savedHash);
      if (name !== "same-receipt") await assert.rejects(stat(pendingReceiptPath), { code: "ENOENT" });
      evidence.push({ case: name, cliRejectedBeforeSend: true, watchedAccountsUnchanged: true });
    }
    const beforeStatus = await watchState();
    const statusOutput = await run(["status", "--receipt", receiptPath]);
    const status = JSON.parse(statusOutput.stdout); assert.equal(status.status, "finalized"); assert.equal(status.sent, false);
    assert.equal(status.signature, receipt.signature); assert.equal(sends, 1);
    assert.deepEqual(await watchState(), beforeStatus); assert.equal(hash(await readFile(receiptPath)).toString("hex"), savedHash);
    evidence.push({ case: "status is read-only and receipt immutable", signature: receipt.signature, finalized: true });
    assert.equal(hash(await readFile(artifactPath)).toString("hex"), artifactHash);
    await writeFile(path.join(directory, "enrollment-cli-evidence.json"), JSON.stringify({ artifactSha256: artifactHash,
      genesis: runtime.genesisHash, initializationSignature, rpc: runtime.rpcUrl, cases: evidence }, null, 2), { flag: "wx", mode: 0o600 });
    console.log(`PASS actual enrollment CLI: ${evidence.length} cases, finalized ${receipt.signature}, artifact ${artifactHash}`);
  } finally {
    proxy.closeAllConnections(); await new Promise<void>((resolve, reject) => proxy.close(error => error ? reject(error) : resolve()));
  }
}
void main().catch(() => { console.error("Enrollment isolated proof failed; inspect retained private logs/state. No automatic retry."); process.exitCode = 1; });
