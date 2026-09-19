/** Real RPC verification of the Goosey foundation (market/escrow not exercised).
 * Requires a fresh, deployed, uninitialized program on a pinned loopback ledger.
 * GOOSEY_SOLANA_TEST_ADMIN_KEYPAIR must explicitly identify the newly created
 * test upgrade-authority key. Other signers exist only in memory. No key output.
 */
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  AccountRole, address, appendTransactionMessageInstructions, blockhash,
  createKeyPairSignerFromBytes, createTransactionMessage, generateKeyPairSigner,
  getAddressDecoder, getAddressEncoder, getBase64EncodedWireTransaction,
  getProgramDerivedAddress, getSignatureFromTransaction, pipe,
  setTransactionMessageFeePayerSigner, setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
  type Address, type AccountMeta, type Instruction, type TransactionSigner,
} from "@solana/kit";
import {
  ASSOCIATED_TOKEN_PROGRAM_ADDRESS, TOKEN_PROGRAM_ADDRESS,
  findAssociatedTokenPda, getCreateAssociatedTokenIdempotentInstruction,
  getMintDecoder, getTokenDecoder,
} from "@solana-program/token";
import { SYSTEM_PROGRAM_ADDRESS } from "@solana-program/system";
import { buildFeatherTransfer } from "../src/lib/solana/feather-transfer";

const PROGRAM = address("CgEGAD3EGLm63YaSx58sRiNPQmmxg8RqvqcxE3xThX8Q");
const LOADER = address("BPFLoaderUpgradeab1e11111111111111111111111");
const RENT = address("SysvarRent111111111111111111111111111111111");
const CLOCK = address("SysvarC1ock11111111111111111111111111111111");
type ChainAccount = { data: [string, string]; owner: string; executable: boolean; lamports: number };
type Context<T> = { context: { slot: number }; value: T };
type Receipt = { slot: number; meta: { err: unknown; fee: number; logMessages: string[] | null } | null };
const keyBytes = (key: Address) => Buffer.from(getAddressEncoder().encode(key));
const discriminator = (namespace: string, name: string) => createHash("sha256").update(`${namespace}:${name}`).digest().subarray(0, 8);
function u64(value: bigint) { const bytes = Buffer.alloc(8); bytes.writeBigUInt64LE(value); return bytes; }
function i64(value: bigint) { const bytes = Buffer.alloc(8); bytes.writeBigInt64LE(value); return bytes; }
const ro = (key: Address): AccountMeta => ({ address: key, role: AccountRole.READONLY });
const rw = (key: Address): AccountMeta => ({ address: key, role: AccountRole.WRITABLE });
const signer = (key: TransactionSigner, writable = true) => ({ address: key.address, role: writable ? AccountRole.WRITABLE_SIGNER : AccountRole.READONLY_SIGNER, signer: key });

async function main() {
  const endpoint = new URL(process.env.GOOSEY_SOLANA_RPC_URL ?? "");
  assert(["127.0.0.1", "[::1]"].includes(endpoint.hostname), "Foundation E2E requires literal loopback RPC");
  assert(["http:", "https:"].includes(endpoint.protocol) && !endpoint.username && !endpoint.password && !endpoint.hash && !endpoint.search, "Unsafe RPC URL");
  const genesis = process.env.GOOSEY_SOLANA_GENESIS_HASH;
  assert(genesis && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(genesis), "Explicit genesis pin required");
  assert(!["5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp", "EtWTRABZaYq6iMfeYKouRu166VU2xqa1", "4uhcVJyU9pJkvQyS88uRDiswHXSCkY3zQawwpjk2NsNY"].includes(genesis), "Public cluster prohibited");
  const adminPath = process.env.GOOSEY_SOLANA_TEST_ADMIN_KEYPAIR;
  assert(adminPath, "GOOSEY_SOLANA_TEST_ADMIN_KEYPAIR must explicitly name the new test-admin key");
  const actualAdminPath = await realpath(adminPath);
  const temporaryRoot = await realpath("/tmp");
  const relativeAdminPath = path.relative(temporaryRoot, actualAdminPath).split(path.sep);
  assert(relativeAdminPath.length === 2
    && /^goosey-solana-[A-Za-z0-9._-]+$/.test(relativeAdminPath[0]!)
    && relativeAdminPath[1] === "goosey-admin-keypair.json",
  "Only a newly generated goosey-admin-keypair.json in a dedicated /tmp/goosey-solana-* directory is allowed");
  let requestId = 0;
  async function rpc<T>(method: string, params: unknown[] = []): Promise<T> {
    const response = await fetch(endpoint, {
      method: "POST", redirect: "error", signal: AbortSignal.timeout(10_000),
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++requestId, method, params }),
    });
    assert(response.ok, `RPC HTTP ${response.status}`);
    const body = await response.json() as { result: T; error?: { code: number; message: string } };
    if (body.error) throw new Error(`RPC ${method}: ${body.error.code}: ${body.error.message}`);
    return body.result;
  }
  async function pin() { assert.equal(await rpc<string>("getGenesisHash"), genesis, "Genesis mismatch; no writes allowed"); }
  await pin();
  async function accounts(keys: readonly Address[]) {
    return (await rpc<Context<(ChainAccount | null)[]>>("getMultipleAccounts", [keys, { encoding: "base64", commitment: "confirmed" }])).value;
  }
  const bytes = (account: ChainAccount | null | undefined) => { assert(account, "Expected account missing"); return Buffer.from(account.data[0], "base64"); };
  const [programData] = await getProgramDerivedAddress({ programAddress: LOADER, seeds: [keyBytes(PROGRAM)] });
  const [config, configBump] = await getProgramDerivedAddress({ programAddress: PROGRAM, seeds: [Buffer.from("config")] });
  const [mintAuthority, mintBump] = await getProgramDerivedAddress({ programAddress: PROGRAM, seeds: [Buffer.from("mint_authority"), keyBytes(config)] });
  const [mint] = await getProgramDerivedAddress({ programAddress: PROGRAM, seeds: [Buffer.from("feather_mint"), keyBytes(config)] });
  const initial = await accounts([PROGRAM, programData, config, mint]);
  assert(initial[0]?.executable, "Program is not deployed yet; rerun after main completes deployment");
  assert.equal(initial[0].owner, LOADER);
  assert.equal(bytes(initial[0]).readUInt32LE(0), 2, "Expected upgradeable Program layout");
  assert.equal(getAddressDecoder().decode(bytes(initial[0]).subarray(4, 36)), programData);
  assert.equal(initial[1]?.owner, LOADER);
  const loaderData = bytes(initial[1]);
  assert.equal(loaderData.readUInt32LE(0), 3, "Expected ProgramData layout");
  assert.equal(loaderData[12], 1, "Program must have its test upgrade authority");
  assert.equal(initial[2], null, "Config already initialized: this destructive-capacity test requires a fresh deployment/ledger; do not reset the shared validator");
  assert.equal(initial[3], null, "Feather mint already exists");
  const secretArray: unknown = JSON.parse(await readFile(actualAdminPath, "utf8"));
  assert(Array.isArray(secretArray) && secretArray.length === 64 && secretArray.every((n: unknown) => Number.isInteger(n) && Number(n) >= 0 && Number(n) <= 255), "Invalid test key encoding");
  const secret = new Uint8Array(secretArray as number[]);
  const admin = await createKeyPairSignerFromBytes(secret);
  secret.fill(0);
  (secretArray as number[]).fill(0);
  assert.equal(getAddressDecoder().decode(loaderData.subarray(13, 45)), admin.address, "Test admin is not deployed upgrade authority");
  const issuer = await generateKeyPairSigner();
  const attacker = await generateKeyPairSigner();
  const wallet = await generateKeyPairSigner();
  const recipient = await generateKeyPairSigner();
  const expiring = await generateKeyPairSigner();
  const other = await generateKeyPairSigner();
  const receipts: Record<string, unknown>[] = [];
  async function confirmed(signature: string) {
    const deadline = Date.now() + 45_000;
    while (Date.now() < deadline) {
      const result = await rpc<Context<({ err: unknown; confirmationStatus: string } | null)[]>>("getSignatureStatuses", [[signature], { searchTransactionHistory: true }]);
      if (result.value[0] && ["confirmed", "finalized"].includes(result.value[0].confirmationStatus)) return result.value[0];
      await delay(200);
    }
    throw new Error(`Unknown transaction outcome after timeout: ${signature}`);
  }
  for (const fundee of [admin, issuer, attacker]) {
    await pin();
    const signature = await rpc<string>("requestAirdrop", [fundee.address, 1_000_000_000]);
    assert.equal((await confirmed(signature)).err, null);
  }
  let lastBlockhash = "";
  async function execute(name: string, instructions: readonly Instruction[], expectation: number | RegExp | null = null, watch: readonly Address[] = [config, mint]) {
    await pin();
    const before = expectation === null ? null : await accounts(watch);
    let latest: Context<{ blockhash: string; lastValidBlockHeight: number }>;
    const deadline = Date.now() + 15_000;
    do {
      latest = await rpc("getLatestBlockhash", [{ commitment: "confirmed" }]);
      if (latest.value.blockhash !== lastBlockhash) break;
      assert(Date.now() < deadline, "Validator blockhash did not advance");
      await delay(150);
    } while (true);
    lastBlockhash = latest.value.blockhash;
    const message = pipe(createTransactionMessage({ version: 0 }),
      (tx) => setTransactionMessageFeePayerSigner(admin, tx),
      (tx) => setTransactionMessageLifetimeUsingBlockhash({ blockhash: blockhash(latest.value.blockhash), lastValidBlockHeight: BigInt(latest.value.lastValidBlockHeight) }, tx),
      (tx) => appendTransactionMessageInstructions(instructions, tx));
    const signed = await signTransactionMessageWithSigners(message);
    const signature = getSignatureFromTransaction(signed);
    assert.equal(await rpc("sendTransaction", [getBase64EncodedWireTransaction(signed), { encoding: "base64", skipPreflight: true, maxRetries: 0 }]), signature);
    const status = await confirmed(signature);
    let transaction: Receipt | null = null;
    for (let i = 0; i < 30; i++) {
      transaction = await rpc("getTransaction", [signature, { commitment: "confirmed", maxSupportedTransactionVersion: 0 }]);
      if (transaction?.meta) break;
      await delay(200);
    }
    assert(transaction?.meta, `Missing execution receipt: ${name}`);
    const logs = transaction.meta.logMessages?.join("\n") ?? "";
    assert(logs.includes(`Program ${instructions[0].programAddress} invoke`), `${name}: no program execution`);
    assert.deepEqual(status.err, transaction.meta.err);
    if (expectation === null) assert.equal(transaction.meta.err, null, `${name}: ${JSON.stringify(transaction.meta.err)}\n${logs}`);
    else {
      assert.notEqual(transaction.meta.err, null, `${name}: unexpectedly succeeded`);
      if (typeof expectation === "number") assert.deepEqual(transaction.meta.err, { InstructionError: [0, { Custom: expectation }] }, `${name}: ${logs}`);
      else assert.match(logs, expectation, `${name}: rejection was not for the expected constraint`);
      assert.deepEqual(await accounts(watch), before, `${name}: rejected transaction changed economic/program accounts`);
    }
    receipts.push({ name, signature, slot: transaction.slot, error: transaction.meta.err, feeLamports: transaction.meta.fee });
    console.log(`PASS ${name}: ${signature}`);
  }
  const domain = createHash("sha256").update(genesis).digest();
  function instruction(name: string, metas: AccountMeta[], args: Uint8Array = new Uint8Array()): Instruction {
    return { programAddress: PROGRAM, accounts: metas, data: Buffer.concat([discriminator("global", name), args]) };
  }
  function initialize(authority: TransactionSigner, environment = 1, cap = 1_000_000n) {
    return instruction("initialize", [signer(authority), ro(PROGRAM), ro(programData), rw(config), ro(mintAuthority), rw(mint), ro(TOKEN_PROGRAM_ADDRESS), ro(SYSTEM_PROGRAM_ADDRESS), ro(RENT)],
      Buffer.concat([Buffer.from([environment]), domain, keyBytes(issuer.address), u64(cap), u64(2_000_000n)]));
  }
  await execute("wrong upgrade authority cannot bootstrap", [initialize(attacker)], 6007);
  await execute("mainnet environment rejected", [initialize(admin, 0)], 6000);
  await execute("zero wallet cap rejected", [initialize(admin, 1, 0n)], 6003);
  await execute("actual upgrade authority initializes config and PDA mint", [initialize(admin)]);
  function decodeConfig(account: ChainAccount | null) {
    assert.equal(account?.owner, PROGRAM);
    const data = bytes(account);
    assert.equal(data.length, 172);
    assert.deepEqual(data.subarray(0, 8), discriminator("account", "Config"));
    assert.deepEqual([...data.subarray(8, 12)], [1, 1, configBump, mintBump]);
    assert.deepEqual(data.subarray(12, 44), domain);
    assert.equal(getAddressDecoder().decode(data.subarray(44, 76)), admin.address);
    assert.equal(getAddressDecoder().decode(data.subarray(76, 108)), issuer.address);
    assert.equal(getAddressDecoder().decode(data.subarray(108, 140)), mint);
    assert.equal(data.readBigUInt64LE(140), 1_000_000n);
    assert.equal(data.readBigUInt64LE(148), 2_000_000n);
    return { authorized: data.readBigUInt64LE(156), minted: data.readBigUInt64LE(164) };
  }
  async function supply(authorized: bigint, minted: bigint) {
    const [configuration, mintAccount] = await accounts([config, mint]);
    assert.deepEqual(decodeConfig(configuration), { authorized, minted });
    assert.equal(mintAccount?.owner, TOKEN_PROGRAM_ADDRESS);
    const data = getMintDecoder().decode(bytes(mintAccount));
    assert.equal(data.decimals, 3);
    assert.equal(data.supply, minted);
    assert.equal(data.isInitialized, true);
    assert.deepEqual(data.mintAuthority, { __option: "Some", value: mintAuthority });
    assert.deepEqual(data.freezeAuthority, { __option: "None" });
  }
  await supply(0n, 0n);
  await execute("duplicate initialize cannot replace authority or mint", [initialize(admin)], /already in use|already initialized/i);
  const chainTime = async () => bytes((await accounts([CLOCK]))[0]).readBigInt64LE(32);
  async function enrollment(target: Address, digest = randomBytes(32)) {
    const [record, bump] = await getProgramDerivedAddress({ programAddress: PROGRAM, seeds: [Buffer.from("enrollment"), keyBytes(config), keyBytes(target)] });
    const [identity] = await getProgramDerivedAddress({ programAddress: PROGRAM, seeds: [Buffer.from("identity"), keyBytes(config), digest] });
    return { target, digest, record, bump, identity };
  }
  type Enrollment = Awaited<ReturnType<typeof enrollment>>;
  function authorize(item: Enrollment, allowance: bigint, expiry: bigint, authority: TransactionSigner = issuer) {
    return instruction("authorize_enrollment", [signer(authority), rw(config), rw(item.record), rw(item.identity), ro(SYSTEM_PROGRAM_ADDRESS)],
      Buffer.concat([keyBytes(item.target), item.digest, u64(allowance), i64(expiry)]));
  }
  const first = await enrollment(wallet.address);
  const expires = (await chainTime()) + 300n;
  const firstWatch = [config, mint, first.record, first.identity];
  await execute("wrong enrollment authority rejected", [authorize(first, 1_000_000n, expires, attacker)], 2001, firstWatch);
  await execute("per-wallet cap enforced", [authorize(first, 1_000_001n, expires)], 6003, firstWatch);
  await execute("expired authorization rejected", [authorize(first, 1n, (await chainTime()) - 1n)], 6005, firstWatch);
  await execute("authorize wallet and unique identity", [authorize(first, 1_000_000n, expires)]);
  const [enrollmentAccount, identityAccount] = await accounts([first.record, first.identity]);
  assert.equal(enrollmentAccount?.owner, PROGRAM);
  assert.equal(identityAccount?.owner, PROGRAM);
  const enrollmentData = bytes(enrollmentAccount);
  assert.equal(enrollmentData.length, 129);
  assert.deepEqual(enrollmentData.subarray(0, 8), discriminator("account", "Enrollment"));
  assert.deepEqual(enrollmentData.subarray(8, 104), Buffer.concat([keyBytes(config), keyBytes(wallet.address), first.digest]));
  assert.equal(enrollmentData.readBigUInt64LE(104), 1_000_000n);
  assert.equal(enrollmentData.readBigUInt64LE(112), 0n);
  assert.equal(enrollmentData.readBigInt64LE(120), expires);
  assert.equal(enrollmentData[128], first.bump);
  assert.deepEqual(bytes(identityAccount), Buffer.concat([discriminator("account", "EnrollmentIdentity"), keyBytes(config), keyBytes(wallet.address), first.digest]));
  const duplicateWallet = await enrollment(wallet.address);
  await execute("wallet cannot enroll with another identity", [authorize(duplicateWallet, 1n, expires)], /already in use|already initialized/i, [...firstWatch, duplicateWallet.identity]);
  const duplicateIdentity = await enrollment(other.address, first.digest);
  await execute("identity cannot enroll another wallet", [authorize(duplicateIdentity, 1n, expires)], /already in use|already initialized/i, [...firstWatch, duplicateIdentity.record]);
  const [walletAta] = await findAssociatedTokenPda({ mint, owner: wallet.address, tokenProgram: TOKEN_PROGRAM_ADDRESS });
  const createAta = (owner: Address, ata: Address) => getCreateAssociatedTokenIdempotentInstruction({ payer: admin, mint, owner, ata, tokenProgram: TOKEN_PROGRAM_ADDRESS });
  await execute("create claim wallet ATA through real ATA program", [createAta(wallet.address, walletAta)]);
  function claim(item: Enrollment, owner: TransactionSigner, ata: Address) {
    return instruction("claim_feathers", [signer(owner, false), rw(config), rw(item.record), ro(mintAuthority), rw(mint), rw(ata), ro(TOKEN_PROGRAM_ADDRESS), ro(ASSOCIATED_TOKEN_PROGRAM_ADDRESS)]);
  }
  await execute("another wallet cannot claim enrollment", [claim(first, attacker, walletAta)], 2006, [...firstWatch, walletAta]);
  await execute("wallet claims exactly authorized feathers via PDA mint CPI", [claim(first, wallet, walletAta)]);
  await supply(1_000_000n, 1_000_000n);
  assert.equal(bytes((await accounts([first.record]))[0]).readBigUInt64LE(112), 1_000_000n);
  const claimedSnapshot = await accounts([...firstWatch, walletAta]);
  await execute("fresh-signature repeated claim is an economic no-op", [claim(first, wallet, walletAta)]);
  assert.deepEqual(await accounts([...firstWatch, walletAta]), claimedSnapshot);
  const transfer = await buildFeatherTransfer({ mint, sender: wallet, recipient: recipient.address, payer: admin, amount: 123_456n });
  assert.equal(transfer.source, walletAta);
  await execute("application helper transfers actual claimed feathers", transfer.instructions);
  const [from, to] = await accounts([walletAta, transfer.destination]);
  for (const account of [from, to]) assert.equal(account?.owner, TOKEN_PROGRAM_ADDRESS);
  const sourceData = getTokenDecoder().decode(bytes(from));
  const destinationData = getTokenDecoder().decode(bytes(to));
  assert.equal(sourceData.owner, wallet.address);
  assert.equal(destinationData.owner, recipient.address);
  assert.equal(sourceData.mint, mint);
  assert.equal(destinationData.mint, mint);
  assert.equal(sourceData.amount, 876_544n);
  assert.equal(destinationData.amount, 123_456n);
  assert.equal(sourceData.amount + destinationData.amount, 1_000_000n);
  const afterTransfer = await accounts([...firstWatch, walletAta, transfer.destination]);
  await execute("transfer away does not reopen claim capacity", [claim(first, wallet, walletAta)]);
  assert.deepEqual(await accounts([...firstWatch, walletAta, transfer.destination]), afterTransfer);
  const timed = await enrollment(expiring.address);
  const timedExpiry = (await chainTime()) + 4n;
  await execute("authorize short-lived unpaid grant", [authorize(timed, 500_000n, timedExpiry)]);
  const [timedAta] = await findAssociatedTokenPda({ mint, owner: expiring.address, tokenProgram: TOKEN_PROGRAM_ADDRESS });
  await execute("create expiring wallet ATA", [createAta(expiring.address, timedAta)]);
  const expiryDeadline = Date.now() + 20_000;
  while (await chainTime() < timedExpiry) { assert(Date.now() < expiryDeadline, "Validator clock failed to reach grant expiry"); await delay(200); }
  await execute("unpaid claim rejected at/after actual validator-clock expiry", [claim(timed, expiring, timedAta)], 6005, [config, mint, timed.record, timed.identity, timedAta]);
  const finalEnrollment = await enrollment(other.address);
  await execute("authorize exact remaining campaign capacity", [authorize(finalEnrollment, 500_000n, expires)]);
  const overflow = await enrollment(recipient.address);
  await execute("campaign lifetime authorization cap enforced", [authorize(overflow, 1n, expires)], 6004, [config, mint, overflow.record, overflow.identity]);
  await supply(2_000_000n, 1_000_000n);
  console.log(JSON.stringify({ result: "PASS", rpc: endpoint.toString(), genesis, program: PROGRAM, programData,
    validator: await rpc("getVersion"), config, mint, mintAuthority, admin: admin.address, enrollmentAuthority: issuer.address,
    sourceAta: walletAta, recipientAta: transfer.destination, totalAuthorized: "2000000", totalMinted: "1000000",
    sourceUnits: "876544", recipientUnits: "123456", decimals: 3, receipts,
    scope: "Actual deployed Goosey initialize/authorize_enrollment/claim_feathers and real helper SPL transfer. Vault/market instructions are not exercised; escrow, matching, resolution, grant recovery and browser wallets are not tested. Validator left running. No keys written or printed.",
  }, null, 2));
}
main().catch((error: unknown) => { console.error(error instanceof Error ? error.message : "Foundation E2E failed"); process.exitCode = 1; });
