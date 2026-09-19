/** Fresh, owned localnet for real Wallet Standard browser tests. Never adopts a ledger. */
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { randomBytes, randomInt } from "node:crypto";
import { createSocket } from "node:dgram";
import { open, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { address, createSolanaRpc, lamports } from "@solana/kit";
import { readGooseyConfiguration } from "../../src/lib/solana/configuration";
import { localnetManifestSchema } from "../../src/lib/solana/localnet-manifest";
import { resolveSolanaRuntime } from "../../src/lib/solana/runtime";
import { trackTransactionStatus } from "../../src/lib/solana/transaction-status";
import { readGooseyWalletBalance } from "../../src/lib/solana/wallet-balance";
import { validateEnrollmentReceipt } from "../solana-enroll";

const execute = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const allowanceBaseUnits = 100_000n;

async function reservePortBlock() {
  for (let attempt = 0; attempt < 100; attempt++) {
    const base = randomInt(30_000, 59_000);
    const close: (() => Promise<void>)[] = [];
    try {
      for (let port = base; port <= base + 40; port++) {
        const tcp = createServer();
        await new Promise<void>((resolve, reject) => { tcp.once("error", reject); tcp.listen(port, "127.0.0.1", resolve); });
        close.push(() => new Promise(resolve => tcp.close(() => resolve())));
        const udp = createSocket("udp4");
        try { await new Promise<void>((resolve, reject) => { udp.once("error", reject); udp.bind(port, "127.0.0.1", resolve); }); }
        catch (error) { udp.close(); throw error; }
        close.push(() => new Promise(resolve => udp.close(resolve)));
      }
      return base;
    } catch { /* Try a different unused block; never attach to an existing RPC. */ }
    finally { await Promise.all(close.map(stop => stop())); }
  }
  throw new Error("Could not reserve a fresh localnet port block");
}

export async function startWalletBrowserChain(options: { walletAddress: string; recipientAddress: string }) {
  const wallet = address(options.walletAddress), recipient = address(options.recipientAddress);
  assert.notEqual(wallet, recipient, "Use distinct real signing keys");
  const parent = await mkdtemp(path.join(await realpath("/tmp"), "goosey-wallet-browser-"));
  const directory = path.join(parent, "chain");
  const port = await reservePortBlock();
  const cli = path.join(root, "scripts/solana-localnet.ts");
  await execute(process.execPath, ["--import", "tsx", cli, "create", "--directory", directory,
    "--rpc-port", String(port), "--per-wallet-cap", allowanceBaseUnits.toString(), "--campaign-cap", allowanceBaseUnits.toString()],
  { cwd: root, env: process.env, timeout: 30_000, maxBuffer: 65536 });
  const log = await open(path.join(parent, "operator.log"), "wx", 0o600);
  const operator = spawn(process.execPath, ["--import", "tsx", cli, "start", "--directory", directory],
    { cwd: root, env: process.env, stdio: ["ignore", log.fd, log.fd] });
  let ended = false, spawnError: Error | undefined;
  const done = new Promise<void>(resolve => operator.once("close", () => { ended = true; resolve(); }));
  operator.once("error", error => { spawnError = error; });
  await log.close();
  let stopping: Promise<void> | undefined;
  const stop = () => stopping ??= (async () => {
    clearTimeout(deadline);
    process.removeListener("SIGINT", interrupt); process.removeListener("SIGTERM", interrupt);
    if (!ended) operator.kill("SIGTERM");
    // The operator owns its validator and has its own five-second escalation.
    await done;
  })();
  const interrupt = () => { void stop(); };
  process.once("SIGINT", interrupt); process.once("SIGTERM", interrupt);
  const deadline = setTimeout(interrupt, 20 * 60_000);
  const signal = AbortSignal.timeout(180_000);
  try {
    let genesis: string | undefined;
    while (!genesis) {
      signal.throwIfAborted(); assert(!ended && !spawnError, "Fresh localnet operator exited; inspect operator.log");
      try { genesis = JSON.parse(await readFile(path.join(directory, "genesis.json"), "utf8")).genesis; }
      catch { await delay(250, undefined, { signal }); }
    }
    const manifest = localnetManifestSchema.parse(JSON.parse(await readFile(path.join(directory, "manifest.json"), "utf8")));
    const env = { GOOSEY_SOLANA_CLUSTER: "localnet", GOOSEY_SOLANA_RPC_URL: `http://127.0.0.1:${port}`,
      GOOSEY_SOLANA_PROGRAM_ID: manifest.program, GOOSEY_SOLANA_GENESIS_HASH: genesis,
      GOOSEY_SOLANA_BROWSER_ENABLED: "true", GOOSEY_SOLANA_PUBLIC_RPC_URL: `http://127.0.0.1:${port}` };
    const runtime = resolveSolanaRuntime(env), rpc = createSolanaRpc(runtime.rpcUrl);
    while (true) {
      signal.throwIfAborted(); assert(!ended, "Fresh localnet operator exited during initialization");
      try {
        const configuration = await readGooseyConfiguration(runtime, signal);
        assert.equal(configuration.admin, manifest.admin); assert.equal(configuration.enrollmentAuthority, manifest.enrollment);
        assert.equal(configuration.perWalletCap, allowanceBaseUnits); assert.equal(configuration.campaignCap, allowanceBaseUnits);
        break;
      } catch { await delay(250, undefined, { signal }); }
    }
    assert.equal(await rpc.getGenesisHash().send({ abortSignal: signal }), genesis);
    // Real localnet faucet transactions only, on this freshly verified owned chain.
    const funding = [];
    for (const destination of [address(manifest.enrollment), wallet]) {
      const signature = await rpc.requestAirdrop(destination, lamports(2_000_000_000n), { commitment: "confirmed" }).send({ abortSignal: signal });
      while (true) {
        signal.throwIfAborted();
        const status = (await rpc.getSignatureStatuses([signature], { searchTransactionHistory: true }).send({ abortSignal: signal })).value[0];
        assert(!status?.err, "Localnet SOL funding transaction failed");
        if (status?.confirmationStatus === "finalized") break;
        await delay(250, undefined, { signal });
      }
      funding.push({ destination, signature });
    }
    const clock = await rpc.getAccountInfo(address("SysvarC1ock11111111111111111111111111111111"), { encoding: "base64", commitment: "finalized" }).send({ abortSignal: signal });
    assert(clock.value);
    const expiry = Buffer.from(clock.value.data[0], "base64").readBigInt64LE(32) + 3600n;
    const receiptPath = path.join(parent, "enrollment-receipt.json");
    await execute(process.execPath, ["--import", "tsx", path.join(root, "scripts/solana-enroll.ts"), "submit",
      "--authority-keyfile", path.join(directory, "enrollment.json"), "--wallet", wallet,
      "--identity-digest", randomBytes(32).toString("hex"), "--allowance", allowanceBaseUnits.toString(),
      "--expires-at", expiry.toString(), "--receipt", receiptPath],
    { cwd: root, env: { ...process.env, ...env }, timeout: 60_000, maxBuffer: 65536 });
    const receipt = await validateEnrollmentReceipt(await readFile(receiptPath, "utf8"), runtime);
    assert.equal((await trackTransactionStatus(rpc, { signature: receipt.signature, lastValidBlockHeight: receipt.lastValidBlockHeight, signal, timeoutMs: 60_000 })).status, "finalized");
    const before = await readGooseyWalletBalance({ runtime, wallet, signal });
    const recipientBefore = await readGooseyWalletBalance({ runtime, wallet: recipient, signal });
    assert.equal(before.featherAmount, 0n); assert.equal(before.featherAccountStatus, "absent");
    assert.equal(recipientBefore.featherAmount, 0n); assert.equal(recipientBefore.featherAccountStatus, "absent");
    assert.equal(recipientBefore.solLamports, 0n);
    await writeFile(path.join(parent, "bootstrap-evidence.json"), JSON.stringify({ runtime, wallet, recipient,
      allowanceBaseUnits: allowanceBaseUnits.toString(), funding, enrollmentSignature: receipt.signature,
      artifactSha256: manifest.artifactSha256, senderAtaInitiallyAbsent: true, recipientAtaInitiallyAbsent: true }, null, 2), { flag: "wx", mode: 0o600 });
    return { env, runtime, directory: parent, allowanceBaseUnits, stop };
  } catch (error) { await stop(); throw error; }
}
