/** Foreground persistent LOCALNET operator; no web process, participant grants, or resets. */
import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { generateKeyPairSync, randomUUID } from "node:crypto";
import { createSocket } from "node:dgram";
import { constants } from "node:fs";
import { lstat, mkdir, open, readFile, realpath, unlink } from "node:fs/promises";
import { createServer } from "node:net";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { appendTransactionMessageInstruction, createKeyPairSignerFromBytes, createSolanaRpc,
  createTransactionMessage, getAddressDecoder, pipe,
  setTransactionMessageFeePayerSigner, setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners } from "@solana/kit";
import { elfHash, localnetManifestSchema, localnetLedgerArguments, parseLocalnetLedgerShreds, privateDirectory, verifyLocalnetProgramData } from "../src/lib/solana/localnet-manifest";
import { buildInitializeInstruction, deriveGooseyProgramAddresses } from "../src/lib/solana/program-client";
import { readGooseyConfiguration } from "../src/lib/solana/configuration";
import { resolveSolanaRuntime } from "../src/lib/solana/runtime";
import { submitSignedWalletTransaction } from "../src/lib/solana/submit-transfer";
import { trackTransactionStatus } from "../src/lib/solana/transaction-status";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
let stage = "arguments and validator";
const help = `Usage:
  node --import tsx scripts/solana-localnet.ts create --directory /absolute/new-directory --rpc-port PORT --per-wallet-cap BASE_UNITS --campaign-cap BASE_UNITS [--ledger-shreds COUNT]
  node --import tsx scripts/solana-localnet.ts start --directory /absolute/existing-directory
Create retains private keys and an immutable ELF snapshot; it does not start a validator.
Start resumes the private ledger, bootstraps only config/mint, and stays foreground until Ctrl-C.
Uses GOOSEY_SOLANA_VALIDATOR_BIN or GOOSEY_SOLANA_BIN_DIR; artifact override GOOSEY_SOLANA_PROGRAM_ARTIFACT.
Ledger retention: default 1000000 shreds, explicit range 10000..10000000; persisted on create.
Legacy manifests without a limit use 1000000 on restart, without rewriting the manifest.
Bounded rolling history, NOT archival storage or a total-disk quota. Pruned history cannot be restored.
No participant funding, enrollment, markets, claims, resets, app changes, or public-network use.`;

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 1 && ["--help", "-h"].includes(args[0])) { console.log(help); return; }
  const mode = args.shift();
  assert(mode === "create" || mode === "start", "Expected create or start; use --help");
  const options: Record<string, string> = {};
  const required = mode === "create" ? ["--directory", "--rpc-port", "--per-wallet-cap", "--campaign-cap"] : ["--directory"];
  const allowed = mode === "create" ? [...required, "--ledger-shreds"] : required;
  while (args.length) {
    const name = args.shift()!, value = args.shift();
    assert(allowed.includes(name) && value && !options[name], "Unknown, repeated, or incomplete option");
    options[name] = value;
  }
  assert(required.every(name => options[name]), "All mode options are required");
  const requestedLedgerShreds = parseLocalnetLedgerShreds(options["--ledger-shreds"]);
  const directory = privateDirectory(options["--directory"]);
  // Resolve ancestors before creation: do not follow symlinked state directories.
  assert.equal(await realpath(path.dirname(directory)), path.dirname(directory), "Directory parent must be canonical");
  const bin = process.env.GOOSEY_SOLANA_VALIDATOR_BIN ?? (process.env.GOOSEY_SOLANA_BIN_DIR
    ? path.join(process.env.GOOSEY_SOLANA_BIN_DIR, "solana-test-validator") : "solana-test-validator");
  const version = spawnSync(bin, ["--version"], { encoding: "utf8", timeout: 10_000 });
  assert.equal(version.status, 0, "Cannot query validator version");
  const validatorHelp = spawnSync(bin, ["--help"], { encoding: "utf8", timeout: 10_000 });
  assert(validatorHelp.status === 0 && /--limit-ledger-size\s+<SHRED_COUNT>/.test(validatorHelp.stdout),
    "Validator must support explicit bounded ledger retention");
  async function syncDirectory() { const fd = await open(directory, constants.O_RDONLY); try { await fd.sync(); } finally { await fd.close(); } }
  async function exclusive(name: string, bytes: string | Uint8Array, permissions = 0o600) {
    const fd = await open(path.join(directory, name), "wx", permissions);
    try { await fd.writeFile(bytes); await fd.sync(); } finally { await fd.close(); }
    await syncDirectory();
  }
  async function exists(name: string) {
    try { await lstat(path.join(directory, name)); return true; } catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return false; throw e; }
  }
  async function privateFile(name: string) {
    const file = path.join(directory, name), stat = await lstat(file);
    assert(stat.isFile() && (stat.mode & 0o077) === 0 && stat.uid === process.getuid?.(), "Unsafe retained file ownership/type/permissions");
    assert(stat.size <= 64 * 1024 * 1024, "Retained file exceeds size bound");
    return readFile(file);
  }
  if (mode === "create") {
    const artifact = await readFile(process.env.GOOSEY_SOLANA_PROGRAM_ARTIFACT ?? path.join(root, "chain/target/deploy/goosey_exchange.so"));
    assert(artifact.length <= 64 * 1024 * 1024 && artifact.subarray(0, 4).toString("hex") === "7f454c46", "Expected bounded compiled ELF");
    function keypair() {
      const jwk = generateKeyPairSync("ed25519").privateKey.export({ format: "jwk" });
      assert(jwk.d && jwk.x);
      const publicBytes = Buffer.from(jwk.x, "base64url");
      const secret = Buffer.concat([Buffer.from(jwk.d, "base64url"), publicBytes]); delete jwk.d;
      return { address: getAddressDecoder().decode(publicBytes), secret };
    }
    const admin = keypair(), enrollment = keypair();
    const manifest = localnetManifestSchema.parse({ version: 1,
      program: "CgEGAD3EGLm63YaSx58sRiNPQmmxg8RqvqcxE3xThX8Q", admin: admin.address, enrollment: enrollment.address,
      validatorVersion: version.stdout.trim(), artifactSha256: elfHash(artifact), rpcPort: Number(options["--rpc-port"]),
      perWalletCap: options["--per-wallet-cap"], campaignCap: options["--campaign-cap"], ledgerShredLimit: requestedLedgerShreds });
    await mkdir(directory, { mode: 0o700 }); // No recursive creation/adoption/overwrite.
    try {
      await exclusive("admin.json", JSON.stringify([...admin.secret]));
      await exclusive("enrollment.json", JSON.stringify([...enrollment.secret]));
      await exclusive("program.so", artifact, 0o400);
      await exclusive("cli.yml", `json_rpc_url: http://127.0.0.1:${manifest.rpcPort}\nwebsocket_url: ws://127.0.0.1:${manifest.rpcPort + 1}\nkeypair_path: ${JSON.stringify(path.join(directory, "admin.json"))}\naddress_labels: {}\ncommitment: finalized\n`);
      await exclusive("manifest.json", JSON.stringify(manifest, null, 2), 0o400);
      const parent = await open(path.dirname(directory), constants.O_RDONLY); try { await parent.sync(); } finally { await parent.close(); }
    } finally { admin.secret.fill(0); enrollment.secret.fill(0); }
    console.log("Private localnet instance created. Run start explicitly; no validator or transactions started."); return;
  }
  stage = "retained directory and manifest";
  const stat = await lstat(directory);
  assert(stat.isDirectory() && (stat.mode & 0o077) === 0 && stat.uid === process.getuid?.(), "Unsafe instance directory");
  const manifest = localnetManifestSchema.parse(JSON.parse((await privateFile("manifest.json")).toString()));
  assert.equal(version.stdout.trim(), manifest.validatorVersion, "Validator version differs from retained instance");
  const elf = await privateFile("program.so"); assert.equal(elfHash(elf), manifest.artifactSha256, "Pinned ELF changed");
  stage = "retained keys";
  const loadSigner = async (name: string) => {
    const raw: unknown = JSON.parse((await privateFile(name)).toString());
    assert(Array.isArray(raw) && raw.length === 64 && raw.every(n => Number.isInteger(n) && n >= 0 && n <= 255), "Invalid retained key");
    const secret = Uint8Array.from(raw); try { return await createKeyPairSignerFromBytes(secret); } finally { secret.fill(0); }
  };
  const admin = await loadSigner("admin.json"), enrollment = await loadSigner("enrollment.json");
  assert.equal(admin.address, manifest.admin); assert.equal(enrollment.address, manifest.enrollment);
  stage = "ledger and lock";
  await privateFile("cli.yml");
  const pinned = await exists("genesis.json");
  if (pinned) assert(await exists("ledger/genesis.bin"), "Pinned ledger is missing; refusing to regenerate genesis");
  if (await exists("ledger")) {
    const ledger = await lstat(path.join(directory, "ledger")); assert(ledger.isDirectory() && !ledger.isSymbolicLink(), "Unsafe ledger");
  }
  await exclusive("operator.lock", JSON.stringify({ pid: process.pid }));
  const abort = new AbortController(), cancel = () => abort.abort();
  process.once("SIGINT", cancel); process.once("SIGTERM", cancel);
  const reservations: (() => Promise<void>)[] = [];
  let child: ChildProcess | undefined, done: Promise<void> | undefined, closed = false;
  const release = async () => { await Promise.all(reservations.splice(0).map(close => close())); };
  try {
    stage = "port reservations";
    for (let port = manifest.rpcPort; port <= manifest.rpcPort + 40; port++) {
      const tcp = createServer();
      await new Promise<void>((resolve, reject) => { tcp.once("error", reject); tcp.listen(port, "127.0.0.1", resolve); });
      reservations.push(() => new Promise(resolve => tcp.close(() => resolve())));
      const udp = createSocket("udp4");
      try { await new Promise<void>((resolve, reject) => { udp.once("error", reject); udp.bind(port, "127.0.0.1", resolve); }); }
      catch (e) { udp.close(); throw e; }
      reservations.push(() => new Promise(resolve => udp.close(resolve)));
    }
    stage = "validator startup";
    const log = await open(path.join(directory, `validator-${randomUUID()}.log`), "wx", 0o600);
    const base = manifest.rpcPort;
    await release(); abort.signal.throwIfAborted();
    try {
      child = spawn(bin, ["--config", path.join(directory, "cli.yml"), "--ledger", path.join(directory, "ledger"),
        "--bind-address", "127.0.0.1", "--rpc-port", String(base), "--faucet-port", String(base + 2),
        "--gossip-port", String(base + 3), "--dynamic-port-range", `${base + 4}-${base + 40}`,
        "--mint", admin.address, "--upgradeable-program", manifest.program, path.join(directory, "program.so"), admin.address,
        ...localnetLedgerArguments(manifest),
        "--quiet"], { cwd: directory, stdio: ["ignore", log.fd, log.fd] });
      child.once("error", cancel);
      done = new Promise(resolve => child!.once("close", () => { closed = true; resolve(); }));
    } finally { await log.close(); }
    const rpcUrl = `http://127.0.0.1:${base}`, rpc = createSolanaRpc(rpcUrl);
    const signal = AbortSignal.any([abort.signal, AbortSignal.timeout(120_000)]);
    while (true) {
      signal.throwIfAborted(); assert(!closed, "Owned validator exited during startup");
      try { if (await rpc.getSlot({ commitment: "finalized" }).send({ abortSignal: AbortSignal.any([signal, AbortSignal.timeout(2000)]) }) > 0n) break; } catch { /* bounded readiness */ }
      await delay(250, undefined, { signal });
    }
    stage = "genesis and program verification";
    const genesis = await rpc.getGenesisHash().send({ abortSignal: signal });
    const runtime = resolveSolanaRuntime({ GOOSEY_SOLANA_CLUSTER: "localnet", GOOSEY_SOLANA_RPC_URL: rpcUrl,
      GOOSEY_SOLANA_PROGRAM_ID: manifest.program, GOOSEY_SOLANA_GENESIS_HASH: genesis });
    if (pinned) assert.equal(JSON.parse((await privateFile("genesis.json")).toString()).genesis, genesis, "Retained genesis mismatch");
    const pdas = await deriveGooseyProgramAddresses(runtime.programAddress);
    const deployed = await rpc.getMultipleAccounts([runtime.programAddress, pdas.programData], { encoding: "base64", commitment: "finalized" }).send({ abortSignal: signal });
    const [program, data] = deployed.value, loader = "BPFLoaderUpgradeab1e11111111111111111111111";
    assert(program?.executable && program.owner === loader && data && !data.executable && data.owner === loader, "Unexpected deployed program accounts");
    const programBytes = Buffer.from(program.data[0], "base64");
    assert(programBytes.length === 36 && programBytes.readUInt32LE(0) === 2
      && getAddressDecoder().decode(programBytes.subarray(4)) === pdas.programData, "Wrong ProgramData binding");
    verifyLocalnetProgramData(Buffer.from(data.data[0], "base64"), admin.address, elf);
    assert(!closed, "Owned validator exited before verification");
    if (!pinned) await exclusive("genesis.json", JSON.stringify({ genesis }), 0o400);
    stage = "configuration initialization/recovery";
    const config = await rpc.getAccountInfo(pdas.config, { commitment: "finalized", encoding: "base64" }).send({ abortSignal: signal });
    if (!config.value) {
      if (await exists("initialize-receipt.json")) {
        // Never replace/re-sign an ambiguous transaction. Read-only recovery may
        // discover finalization; absent/pruned/expired outcomes require operator review.
        const receipt = JSON.parse((await privateFile("initialize-receipt.json")).toString());
        const result = await trackTransactionStatus(rpc, { signature: receipt.signature,
          lastValidBlockHeight: BigInt(receipt.lastValidBlockHeight), signal, timeoutMs: 60_000 });
        assert.equal(result.status, "finalized", "Retained initialization unresolved; no replacement sent");
      } else {
        const initialization = await buildInitializeInstruction({ programAddress: runtime.programAddress, admin,
          environment: 1, genesisDomain: new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(genesis))),
          enrollmentAuthority: enrollment.address, perWalletCap: BigInt(manifest.perWalletCap), campaignCap: BigInt(manifest.campaignCap) });
        const { value: lifetime } = await rpc.getLatestBlockhash({ commitment: "finalized" }).send({ abortSignal: signal });
        const message = pipe(createTransactionMessage({ version: 0 }), m => setTransactionMessageFeePayerSigner(admin, m),
          m => setTransactionMessageLifetimeUsingBlockhash(lifetime, m), m => appendTransactionMessageInstruction(initialization.instruction, m));
        const signed = await signTransactionMessageWithSigners(message);
        const receipt = await submitSignedWalletTransaction({ runtime, prepared: { message, sender: admin.address, cluster: "localnet", genesisHash: genesis }, signed, signal,
          onPrepared: async receipt => exclusive("initialize-receipt.json", JSON.stringify({ ...receipt, lastValidBlockHeight: receipt.lastValidBlockHeight.toString() })) });
        const result = await trackTransactionStatus(rpc, { ...receipt, signal, timeoutMs: 60_000 });
        assert.equal(result.status, "finalized", "Initialization unresolved; retained receipt requires reconciliation");
      }
    }
    stage = "finalized configuration verification";
    const verified = await readGooseyConfiguration(runtime, signal);
    assert.equal(verified.admin, admin.address); assert.equal(verified.enrollmentAuthority, enrollment.address);
    assert.equal(verified.perWalletCap, BigInt(manifest.perWalletCap)); assert.equal(verified.campaignCap, BigInt(manifest.campaignCap));
    console.log(`GOOSEY_SOLANA_CLUSTER=localnet\nGOOSEY_SOLANA_RPC_URL=${rpcUrl}\nGOOSEY_SOLANA_PROGRAM_ID=${manifest.program}\nGOOSEY_SOLANA_GENESIS_HASH=${genesis}`);
    console.log("Verified foundation only; no participants funded or markets created. Foreground validator: Ctrl-C to stop.");
    console.log(`Rolling ledger retention: ${manifest.ledgerShredLimit} shreds. Start durable indexing before activity; this is not an archive and cannot restore pruned history.`);
    while (!abort.signal.aborted && !closed) await delay(250);
    if (!abort.signal.aborted) throw new Error("Owned validator exited unexpectedly");
  } finally {
    await release();
    if (child && done) {
      if (!closed) child.kill("SIGTERM");
      const timer = setTimeout(() => { if (!closed) child?.kill("SIGKILL"); }, 5000);
      await done; clearTimeout(timer);
    }
    await unlink(path.join(directory, "operator.lock")); await syncDirectory();
    process.removeListener("SIGINT", cancel); process.removeListener("SIGTERM", cancel);
  }
}
main().catch(() => { console.error(`Localnet operator stopped at: ${stage}. Inspect private logs/configuration. Completed durable steps are retained; no automatic reset/retry.`); process.exitCode = 1; });
