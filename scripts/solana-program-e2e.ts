/** Real RPC verification of Goosey issuance and market escrow.
 * Requires a fresh, deployed, uninitialized program on a pinned loopback ledger.
 * GOOSEY_SOLANA_TEST_ADMIN_KEYPAIR must explicitly identify the newly created
 * test upgrade-authority key. Other signers exist only in memory. No key output.
 */
import assert from "node:assert/strict";
import { DEVNET_GENESIS_HASH, MAINNET_GENESIS_HASH, TESTNET_GENESIS_HASH } from "../src/lib/solana/runtime";
import { createHash, randomBytes } from "node:crypto";
import { open, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  AccountRole, address, appendTransactionMessageInstructions, blockhash,
  createKeyPairSignerFromBytes, createTransactionMessage, generateKeyPairSigner,
  getAddressDecoder, getAddressEncoder, getBase58Encoder, getBase64EncodedWireTransaction,
  getProgramDerivedAddress, getSignatureFromTransaction, getSignersFromTransactionMessage, pipe,
  setTransactionMessageFeePayerSigner, setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
  type Address, type AccountMeta, type Instruction, type TransactionSigner,
} from "@solana/kit";
import {
  ASSOCIATED_TOKEN_PROGRAM_ADDRESS, TOKEN_PROGRAM_ADDRESS,
  findAssociatedTokenPda, getCreateAssociatedTokenIdempotentInstruction,
  getMintDecoder, getTokenDecoder, getTransferCheckedInstruction,
} from "@solana-program/token";
import { SYSTEM_PROGRAM_ADDRESS, getCreateAccountInstruction, getTransferSolInstruction } from "@solana-program/system";
import { buildFeatherTransfer } from "../src/lib/solana/feather-transfer";
import { buildCreateMarketInstructions, buildRegisterSeatInstruction, buildDepositInstruction, buildWithdrawInstruction } from "../src/lib/solana/escrow-client";
import { readGooseyEscrow } from "../src/lib/solana/escrow-read";
import { prepareFeatherTransfer } from "../src/lib/solana/prepare-transfer";
import { prepareFeatherClaim } from "../src/lib/solana/prepare-feather-claim";
import { submitSignedFeatherTransfer, submitSignedWalletTransaction, type TransferSubmission } from "../src/lib/solana/submit-transfer";

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
function u16(value: number) { const bytes = Buffer.alloc(2); bytes.writeUInt16LE(value); return bytes; }
const ro = (key: Address): AccountMeta => ({ address: key, role: AccountRole.READONLY });
const rw = (key: Address): AccountMeta => ({ address: key, role: AccountRole.WRITABLE });
const signer = (key: TransactionSigner, writable = true) => ({ address: key.address, role: writable ? AccountRole.WRITABLE_SIGNER : AccountRole.READONLY_SIGNER, signer: key });

async function main() {
  const endpoint = new URL(process.env.GOOSEY_SOLANA_RPC_URL ?? "");
  assert(["127.0.0.1", "[::1]"].includes(endpoint.hostname), "Foundation E2E requires literal loopback RPC");
  assert(["http:", "https:"].includes(endpoint.protocol) && !endpoint.username && !endpoint.password && !endpoint.hash && !endpoint.search, "Unsafe RPC URL");
  const genesis = process.env.GOOSEY_SOLANA_GENESIS_HASH;
  assert(genesis && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(genesis), "Explicit genesis pin required");
  address(genesis);
  assert(![MAINNET_GENESIS_HASH, DEVNET_GENESIS_HASH, TESTNET_GENESIS_HASH].includes(genesis), "Public cluster prohibited");
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
  const preparedSubmissions: Record<string, unknown>[] = [];
  async function confirmed(signature: string, wire?: string) {
    const deadline = Date.now() + 45_000;
    let lastResend = Date.now();
    while (Date.now() < deadline) {
      const result = await rpc<Context<({ err: unknown; confirmationStatus: string } | null)[]>>("getSignatureStatuses", [[signature], { searchTransactionHistory: true }]);
      if (result.value[0] && ["confirmed", "finalized"].includes(result.value[0].confirmationStatus)) return result.value[0];
      // A new validator's TPU may not yet be reachable when RPC first becomes
      // healthy. Retry the identical signed bytes, never a fresh economic intent.
      if (!result.value[0] && wire && Date.now() - lastResend > 1_000) {
        await pin();
        assert.equal(await rpc("sendTransaction", [wire, { encoding: "base64", skipPreflight: true, maxRetries: 5 }]), signature);
        lastResend = Date.now();
      }
      await delay(200);
    }
    throw new Error(`Unknown transaction outcome after timeout: ${signature}`);
  }
  const adminBalance = await rpc<Context<number>>("getBalance", [admin.address, { commitment: "confirmed" }]);
  if (adminBalance.value < 5_000_000_000) {
    await pin();
    const signature = await rpc<string>("requestAirdrop", [admin.address, 5_000_000_000]);
    assert.equal((await confirmed(signature)).err, null);
  }
  let lastBlockhash = "";
  async function execute(name: string, instructions: readonly Instruction[], expectation: number | RegExp | null = null, watch: readonly Address[] = [config, mint], errorIndex = 0, prepared?: Awaited<ReturnType<typeof prepareFeatherTransfer>>) {
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
    // A prepared wallet message must be signed unchanged, including its payer
    // and finalized blockhash lifetime; never replace it with our admin message.
    const signed = await signTransactionMessageWithSigners(prepared?.message ?? message);
    const signature = getSignatureFromTransaction(signed);
    const wire = getBase64EncodedWireTransaction(signed);
    if (prepared) {
      const saved: Omit<TransferSubmission, "status">[] = [];
      const submitted = await submitSignedFeatherTransfer({
        runtime: { cluster: "localnet", rpcUrl: endpoint.toString(), genesisHash: genesis!, programAddress: PROGRAM },
        prepared, signed,
        onPrepared: async receipt => {
          // Persist in test memory before sending. At this point this unique
          // signed intent must not have reached the ledger yet.
          saved.push(receipt);
          const status = await rpc<Context<(unknown | null)[]>>("getSignatureStatuses", [[receipt.signature], { searchTransactionHistory: true }]);
          assert.equal(status.value[0], null);
        },
      });
      assert.equal(saved.length, 1);
      assert.equal(saved[0].signature, signature);
      assert.equal(saved[0].signedWireBase64, wire);
      assert.equal(saved[0].lastValidBlockHeight, prepared.lifetime.lastValidBlockHeight);
      assert.equal(submitted.signature, signature);
      assert.equal(submitted.signedWireBase64, wire);
      assert(["submitted", "unknown"].includes(submitted.status));
      preparedSubmissions.push({ signature, status: submitted.status, persistedBeforeSend: true });
    } else {
      assert.equal(await rpc("sendTransaction", [wire, { encoding: "base64", skipPreflight: true, maxRetries: 5 }]), signature);
    }
    // Submission status is never treated as chain confirmation; reconcile the
    // saved signature and only rebroadcast its identical bytes if necessary.
    const status = await confirmed(signature, wire);
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
      if (typeof expectation === "number") assert.deepEqual(transaction.meta.err, { InstructionError: [errorIndex, { Custom: expectation }] }, `${name}: ${logs}`);
      else assert.match(logs, expectation, `${name}: rejection was not for the expected constraint`);
      assert.deepEqual(await accounts(watch), before, `${name}: rejected transaction changed economic/program accounts`);
    }
    receipts.push({ name, signature, slot: transaction.slot, error: transaction.meta.err, feeLamports: transaction.meta.fee });
    console.log(`PASS ${name}: ${signature}`);
  }
  await execute("fund ephemeral transaction/account payers with local SOL", [issuer, attacker, wallet].map((fundee) =>
    getTransferSolInstruction({ source: admin, destination: fundee.address, amount: 1_000_000_000n })));
  // Match the shipping configuration verifier's SHA-256(genesis string) domain.
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
  const claimSlot = Number(receipts.at(-1)!.slot);
  const claimFinalityDeadline = Date.now() + 45_000;
  while (await rpc<number>("getSlot", [{ commitment: "finalized" }]) < claimSlot) {
    assert(Date.now() < claimFinalityDeadline, "Claim finality gate timed out");
    await delay(200);
  }
  const transfer = await prepareFeatherTransfer({
    runtime: { cluster: "localnet", rpcUrl: endpoint.toString(), genesisHash: genesis, programAddress: PROGRAM },
    sender: wallet, recipient: recipient.address, displayAmount: "123.456",
  });
  assert.equal(transfer.source, walletAta);
  assert.equal(transfer.mint, mint);
  assert.equal(transfer.amount, 123_456n);
  assert.equal(transfer.finalizedBalance, 1_000_000n);
  assert(transfer.observedSlot >= BigInt(claimSlot));
  assert.equal(transfer.message.feePayer.address, wallet.address);
  assert.deepEqual(transfer.message.lifetimeConstraint, transfer.lifetime);
  await execute("prepare + submit shipping helpers transfer finalized claimed feathers with wallet signature", transfer.message.instructions, null, [], 0, transfer);
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

  // Market and escrow tests precede campaign exhaustion. Every account is created
  // by real instructions; no account mutation RPC or synthetic seat funding.
  const marketClose = (await chainTime()) + 600n;
  const seatsRent = await rpc<number>("getMinimumBalanceForRentExemption", [32_816]);
  async function marketFixture(id: bigint) {
    const seats = await generateKeyPairSigner();
    const [market, bump] = await getProgramDerivedAddress({ programAddress: PROGRAM, seeds: [Buffer.from("market"), keyBytes(config), u64(id)] });
    const [vault] = await findAssociatedTokenPda({ mint, owner: market, tokenProgram: TOKEN_PROGRAM_ADDRESS });
    const [locator, locatorBump] = await getProgramDerivedAddress({ programAddress: PROGRAM, seeds: [Buffer.from("seat"), keyBytes(market), keyBytes(wallet.address)] });
    return { id, seats, market, bump, vault, locator, locatorBump };
  }
  type MarketFixture = Awaited<ReturnType<typeof marketFixture>>;
  function createMarket(item: MarketFixture, authority = admin, payout = 100_000n, fee = 25, closes = marketClose, resolves = marketClose + 60n) {
    return [getCreateAccountInstruction({ payer: admin, newAccount: item.seats, lamports: BigInt(seatsRent), space: 32_816n, programAddress: PROGRAM }),
      instruction("create_market", [signer(authority), ro(config), rw(item.market), rw(item.seats.address), ro(mint), rw(item.vault), ro(TOKEN_PROGRAM_ADDRESS), ro(ASSOCIATED_TOKEN_PROGRAM_ADDRESS), ro(SYSTEM_PROGRAM_ADDRESS)],
        Buffer.concat([u64(item.id), u64(payout), u16(fee), i64(closes), i64(resolves)]))];
  }
  const book = await marketFixture(1n);
  const secondBook = await marketFixture(2n);
  const marketWatch = [config, mint, book.market, book.seats.address, book.vault, book.locator, walletAta, transfer.destination];
  await execute("non-admin market creation rolls back seats allocation", createMarket(book, attacker), 2001, marketWatch, 1);
  await execute("invalid payout rolls back market vault and seats", createMarket(book, admin, 1n), 6008, marketWatch, 1);
  await execute("excessive market fee rejected atomically", createMarket(book, admin, 100_000n, 10_001), 6008, marketWatch, 1);
  await execute("past market close rejected atomically", createMarket(book, admin, 100_000n, 25, (await chainTime()) - 1n), 6008, marketWatch, 1);
  await execute("resolution before close rejected atomically", createMarket(book, admin, 100_000n, 25, marketClose, marketClose - 1n), 6008, marketWatch, 1);
  for (const item of [book, secondBook]) {
    const built = await buildCreateMarketInstructions({ programAddress: PROGRAM, marketId: item.id, admin, seats: item.seats,
      seatsRentLamports: BigInt(seatsRent), payoutMilli: 100_000n, feeBps: 25, closesAt: marketClose, resolvesAt: marketClose + 60n });
    assert.equal(built.market, item.market);
    assert.equal(built.vault, item.vault);
    await execute(`shipping builder creates market ${item.id}, large seats account and PDA ATA vault`, built.instructions);
  }
  function register(item: MarketFixture, owner = wallet, enrollmentAddress = first.record) {
    return instruction("register_seat", [signer(owner, false), signer(admin), ro(config), ro(enrollmentAddress),
      ro(item.market), rw(item.seats.address), rw(item.locator), ro(SYSTEM_PROGRAM_ADDRESS)]);
  }
  await execute("foreign wallet cannot register another enrollment", [register(book, attacker)], 2006, marketWatch);
  const clientSeat = await buildRegisterSeatInstruction({ programAddress: PROGRAM, marketId: book.id,
    wallet, rentPayer: admin, seats: book.seats.address });
  assert.equal(clientSeat.locator, book.locator);
  await execute("shipping builder registers wallet seat with zero initial cash", [clientSeat.instruction]);
  await execute("duplicate registration cannot allocate another seat", [register(book)], /already in use|already initialized/i, marketWatch);
  const locatorBytes = bytes((await accounts([book.locator]))[0]);
  assert.deepEqual(locatorBytes, Buffer.concat([discriminator("account", "SeatLocator"), keyBytes(book.market), keyBytes(wallet.address), Buffer.alloc(4), Buffer.from([book.locatorBump])]));
  const move = (name: "deposit" | "withdraw", amount: bigint, nonce: bigint,
    options: { owner?: TransactionSigner; tokens?: Address; vault?: Address; seats?: Address; locator?: Address } = {}) =>
    instruction(name, [signer(options.owner ?? wallet, false), ro(config), rw(book.market), rw(options.seats ?? book.seats.address), ro(options.locator ?? book.locator), ro(mint), rw(options.tokens ?? walletAta), rw(options.vault ?? book.vault), ro(TOKEN_PROGRAM_ADDRESS)], Buffer.concat([u64(amount), u64(nonce)]));
  async function escrowState(available: bigint, nonce: bigint, vaultAmount: bigint, walletAmount: bigint) {
    const [marketAccount, seatsAccount, vaultAccount, walletAccount, recipientAccount] = await accounts([book.market, book.seats.address, book.vault, walletAta, transfer.destination]);
    assert.equal(marketAccount?.owner, PROGRAM);
    assert.equal(seatsAccount?.owner, PROGRAM);
    const marketData = bytes(marketAccount);
    assert.equal(marketData.length, 195);
    assert.deepEqual(marketData.subarray(0, 8), discriminator("account", "Market"));
    assert.deepEqual(marketData.subarray(8, 136), Buffer.concat([keyBytes(config), keyBytes(admin.address), keyBytes(book.seats.address), keyBytes(book.vault)]));
    assert.equal(marketData.readBigUInt64LE(136), book.id);
    assert.equal(marketData.readBigUInt64LE(144), 100_000n);
    assert.equal(marketData.readBigInt64LE(152), marketClose);
    assert.equal(marketData.readBigInt64LE(160), marketClose + 60n);
    assert.equal(marketData.readBigUInt64LE(168), available);
    assert.equal(marketData.readBigUInt64LE(176), 0n); // no positions/collateral
    assert.equal(marketData.readBigUInt64LE(184), 0n); // no trade fees
    assert.equal(marketData.readUInt16LE(192), 25);
    assert.equal(marketData[194], book.bump);
    const seatData = bytes(seatsAccount);
    assert.equal(seatData.length, 32_816);
    assert.deepEqual(seatData.subarray(0, 8), discriminator("account", "Seats"));
    assert.deepEqual(seatData.subarray(8, 40), keyBytes(book.market));
    assert.equal(seatData.readUInt32LE(40), 1);
    assert.deepEqual(seatData.subarray(48, 112), Buffer.concat([keyBytes(wallet.address), keyBytes(first.record)]));
    assert.equal(seatData.readBigUInt64LE(112), available);
    assert.deepEqual(seatData.subarray(120, 160), Buffer.alloc(40)); // reserved cash and all positions
    assert.equal(seatData.readBigUInt64LE(160), nonce);
    assert.deepEqual(seatData.subarray(168), Buffer.alloc(32_816 - 168)); // no trading / other seats
    for (const account of [vaultAccount, walletAccount, recipientAccount]) assert.equal(account?.owner, TOKEN_PROGRAM_ADDRESS);
    const vaultData = getTokenDecoder().decode(bytes(vaultAccount));
    assert.equal(vaultData.owner, book.market);
    assert.equal(vaultData.mint, mint);
    assert.equal(vaultData.amount, vaultAmount);
    assert.deepEqual(vaultData.delegate, { __option: "None" });
    assert.deepEqual(vaultData.closeAuthority, { __option: "None" });
    const walletData = getTokenDecoder().decode(bytes(walletAccount));
    const recipientData = getTokenDecoder().decode(bytes(recipientAccount));
    assert.equal(walletData.amount, walletAmount);
    assert.equal(recipientData.amount, 123_456n);
    assert.equal(walletData.amount + recipientData.amount + vaultData.amount, 1_000_000n);
    assert(vaultAmount >= available, "Vault must cover seat liabilities");
    await supply(1_000_000n, 1_000_000n);
  }
  await escrowState(0n, 0n, 0n, 876_544n);
  await execute("zero deposit rejected", [move("deposit", 0n, 0n)], 6012, marketWatch);
  await execute("insufficient token deposit CPI rolls back cash and nonce", [move("deposit", 876_545n, 0n)], 1, marketWatch);
  await execute("deposit rejects skipped nonce", [move("deposit", 1n, 1n)], 6011, marketWatch);
  const clientDeposit = await buildDepositInstruction({ programAddress: PROGRAM, marketId: book.id, wallet, seats: book.seats.address, amount: 400_000n, expectedNonce: 0n });
  await execute("shipping builder deposits claimed wallet tokens into escrow", [clientDeposit.instruction]);
  await escrowState(400_000n, 1n, 400_000n, 476_544n);
  await execute("fresh-signature deposit replay cannot double credit", [move("deposit", 400_000n, 0n)], 6011, marketWatch);
  await execute("foreign wallet cannot withdraw owner's seat", [move("withdraw", 1n, 1n, { owner: attacker })], 2006, marketWatch);
  await execute("withdraw cannot redirect to another wallet ATA", [move("withdraw", 1n, 1n, { tokens: transfer.destination })], 2015, marketWatch);
  await execute("wrong vault rejected", [move("withdraw", 1n, 1n, { vault: secondBook.vault })], 2001, [...marketWatch, secondBook.vault]);
  await execute("foreign market seats rejected", [move("deposit", 1n, 1n, { seats: secondBook.seats.address })], 2001, [...marketWatch, secondBook.seats.address]);
  await execute("zero withdrawal rejected", [move("withdraw", 0n, 1n)], 6012, marketWatch);
  await execute("withdrawal above available rejected", [move("withdraw", 400_001n, 1n)], 6012, marketWatch);
  await execute("later failure rolls back successful deposit CPI and nonce", [move("deposit", 100n, 1n), move("withdraw", 500_000n, 2n)], 6012, marketWatch, 1);
  await escrowState(400_000n, 1n, 400_000n, 476_544n);
  await execute("admin cannot directly transfer PDA vault tokens", [getTransferCheckedInstruction({ source: book.vault, destination: walletAta, mint, authority: admin, amount: 1n, decimals: 3 })], 4, marketWatch);
  const clientWithdrawal = await buildWithdrawInstruction({ programAddress: PROGRAM, marketId: book.id, wallet, seats: book.seats.address, amount: 150_000n, expectedNonce: 1n });
  await execute("shipping builder withdraws through market PDA to owner ATA", [clientWithdrawal.instruction]);
  await escrowState(250_000n, 2n, 250_000n, 626_544n);
  await execute("fresh-signature withdrawal replay cannot double pay", [move("withdraw", 150_000n, 1n)], 6011, marketWatch);
  const donation = await buildFeatherTransfer({ mint, sender: wallet, recipient: book.market, payer: admin, amount: 1_000n });
  assert.equal(donation.destination, book.vault);
  await execute("unsolicited real token vault donation", donation.instructions);
  await escrowState(250_000n, 2n, 251_000n, 625_544n);
  await execute("vault surplus does not grant extra withdrawable cash", [move("withdraw", 250_001n, 2n)], 6012, marketWatch);
  const clientFinalWithdrawal = await buildWithdrawInstruction({ programAddress: PROGRAM, marketId: book.id, wallet, seats: book.seats.address, amount: 250_000n, expectedNonce: 2n });
  await execute("shipping builder withdraws exact remaining available cash", [clientFinalWithdrawal.instruction]);
  await escrowState(0n, 3n, 1_000n, 875_544n);
  await execute("empty seat cannot withdraw donated surplus", [move("withdraw", 1n, 3n)], 6012, marketWatch);
  await execute("final withdrawal nonce remains consumed", [move("withdraw", 250_000n, 2n)], 6011, marketWatch);

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
  const finalReceiptSlot = Number(receipts.at(-1)!.slot);
  const finalityDeadline = Date.now() + 45_000;
  while (await rpc<number>("getSlot", [{ commitment: "finalized" }]) < finalReceiptSlot) {
    assert(Date.now() < finalityDeadline, "Finalized reader gate timed out");
    await delay(200);
  }
  const shippingRead = await readGooseyEscrow({ cluster: "localnet", rpcUrl: endpoint.toString(), genesisHash: genesis, programAddress: PROGRAM }, { marketId: book.id, wallet: wallet.address });
  assert.equal(shippingRead.registered, true);
  assert.equal(shippingRead.seat?.availableCash, 0n);
  assert.equal(shippingRead.seat?.nextNonce, 3n);
  assert.equal(shippingRead.vaultAmount, 1_000n);
  assert.equal(shippingRead.vaultSurplus, 1_000n);
  assert.equal(shippingRead.walletTokenAmount, 875_544n);
  assert.equal(shippingRead.exchangeVerified, false);
  console.log("PASS shipping readGooseyEscrow verifies real finalized accounts and donation surplus");

  // Preserve every original foundation case and its original issuance assertions.
  // The previously authorized final wallet now exercises the shipping grant path;
  // no new capacity, account injection, or replacement of the original 53 cases.
  assert.equal(receipts.length, 53, "Original foundation transaction baseline changed");
  const baselineTransactionCaseCount = receipts.length;
  const runtime = { cluster: "localnet" as const, rpcUrl: endpoint.toString(), genesisHash: genesis, programAddress: PROGRAM };
  async function finalized(signature: string) {
    const deadline = Date.now() + 45_000;
    while (Date.now() < deadline) {
      const status = (await rpc<Context<({ err: unknown; confirmationStatus: string } | null)[]>>(
        "getSignatureStatuses", [[signature], { searchTransactionHistory: true }])).value[0];
      if (status?.confirmationStatus === "finalized") { assert.equal(status.err, null); return; }
      await delay(200);
    }
    throw new Error(`Exact-signature finality timed out: ${signature}`);
  }
  await execute("fund authorized grant wallet as sole transaction and ATA rent payer", [
    getTransferSolInstruction({ source: admin, destination: other.address, amount: 100_000_000n }),
  ]);
  await finalized(String(receipts.at(-1)!.signature));
  const [grantAta] = await findAssociatedTokenPda({ mint, owner: other.address, tokenProgram: TOKEN_PROGRAM_ADDRESS });
  const grantKeys = [config, mint, finalEnrollment.record, finalEnrollment.identity, grantAta, CLOCK] as const;
  const beforeGrant = await rpc<Context<(ChainAccount | null)[]>>("getMultipleAccounts", [grantKeys, { encoding: "base64", commitment: "finalized" }]);
  assert.equal(beforeGrant.value[4], null, "Grant helper must exercise actual missing ATA creation");
  assert.equal(bytes(beforeGrant.value[2]).readBigUInt64LE(112), 0n);
  assert.deepEqual(decodeConfig(beforeGrant.value[0]), { authorized: 2_000_000n, minted: 1_000_000n });
  const grant = await prepareFeatherClaim({ runtime, wallet: other });
  const afterPrepareClock = await rpc<Context<ChainAccount | null>>("getAccountInfo", [CLOCK,
    { encoding: "base64", commitment: "finalized", minContextSlot: Number(grant.observedSlot) }]);
  assert(grant.observedSlot >= BigInt(beforeGrant.context.slot));
  assert(grant.observedSlot <= BigInt(afterPrepareClock.context.slot));
  assert(grant.chainTimestamp >= bytes(beforeGrant.value[5]).readBigInt64LE(32));
  assert(grant.chainTimestamp <= bytes(afterPrepareClock.value).readBigInt64LE(32));
  assert(grant.chainTimestamp < grant.expiresAt);
  assert.equal(grant.expiresAt, bytes(beforeGrant.value[2]).readBigInt64LE(120));
  assert.equal(bytes(afterPrepareClock.value).readBigUInt64LE(0), BigInt(afterPrepareClock.context.slot));
  assert.equal(grant.amount, 500_000n);
  assert.equal(grant.claimed, 0n);
  assert.equal(grant.observedBalance, 0n);
  assert.equal(grant.createsAta, true);
  assert.equal(grant.enrollment, finalEnrollment.record);
  assert.equal(grant.identity, finalEnrollment.identity);
  assert.equal(grant.walletTokens, grantAta);
  assert.equal(grant.mint, mint);
  assert.equal(grant.sender, other.address);
  assert.equal(grant.message.feePayer.address, other.address);
  assert.deepEqual(getSignersFromTransactionMessage(grant.message).map(s => s.address), [other.address]);
  assert.deepEqual(grant.message.lifetimeConstraint, grant.lifetime);
  assert.equal(grant.message.instructions.length, 2);
  assert.equal(grant.message.instructions[0].programAddress, ASSOCIATED_TOKEN_PROGRAM_ADDRESS);
  assert.deepEqual(new Uint8Array(grant.message.instructions[0].data!), new Uint8Array([1]));
  assert.equal(grant.message.instructions[1].programAddress, PROGRAM);
  assert.deepEqual(Buffer.from(grant.message.instructions[1].data!), discriminator("global", "claim_feathers"));
  // The old short-lived grant must also be rejected by the shipping preparer
  // using real finalized Clock, without signing or submitting another intent.
  await assert.rejects(prepareFeatherClaim({ runtime, wallet: expiring }), /expired.*chain Clock/);
  const signedGrant = await signTransactionMessageWithSigners(grant.message);
  assert.deepEqual(Object.keys(signedGrant.signatures), [other.address]);
  const grantSignature = getSignatureFromTransaction(signedGrant), grantWire = getBase64EncodedWireTransaction(signedGrant);
  const submissionPath = path.join(path.dirname(actualAdminPath), "prepared-feather-claim-submission.json");
  let persistedCount = 0;
  const grantSubmission = await submitSignedWalletTransaction({ runtime, prepared: grant, signed: signedGrant,
    onPrepared: async receipt => {
      assert.equal(receipt.signature, grantSignature);
      assert.equal(receipt.signedWireBase64, grantWire);
      assert.equal(receipt.lastValidBlockHeight, grant.lifetime.lastValidBlockHeight);
      const status = await rpc<Context<(unknown | null)[]>>("getSignatureStatuses", [[receipt.signature], { searchTransactionHistory: true }]);
      assert.equal(status.value[0], null, "Claim reached ledger before persistence callback");
      const persisted = JSON.stringify(receipt, (_, value) => typeof value === "bigint" ? value.toString() : value);
      const file = await open(submissionPath, "wx", 0o600);
      try { await file.writeFile(persisted); await file.sync(); } finally { await file.close(); }
      assert.equal(await readFile(submissionPath, "utf8"), persisted);
      persistedCount++;
    },
  });
  assert.equal(persistedCount, 1);
  assert.equal(grantSubmission.signature, grantSignature);
  assert.equal(grantSubmission.signedWireBase64, grantWire);
  assert(["submitted", "unknown"].includes(grantSubmission.status));
  assert.equal((await confirmed(grantSignature, grantWire)).err, null);
  await finalized(grantSignature);
  const grantReceipt = await rpc<(Receipt & { transaction: { signatures: string[]; message: {
    accountKeys: string[]; header: { numRequiredSignatures: number } } }; meta: { err: unknown; fee: number;
      logMessages: string[]; preBalances: number[]; postBalances: number[]; computeUnitsConsumed: number;
      innerInstructions: { index: number; instructions: { programIdIndex: number; accounts: number[]; data: string }[] }[] } }) | null>(
    "getTransaction", [grantSignature, { commitment: "finalized", maxSupportedTransactionVersion: 0 }]);
  assert(grantReceipt?.meta, "Missing finalized grant execution receipt");
  assert.equal(grantReceipt.meta.err, null);
  assert.deepEqual(grantReceipt.transaction.signatures, [grantSignature]);
  assert.equal(grantReceipt.transaction.message.header.numRequiredSignatures, 1);
  assert.equal(grantReceipt.transaction.message.accountKeys[0], other.address);
  // Instruction logs are not an ABI. Verify actual classic SPL MintTo bytes
  // (tag 7 + u64 amount) and CPI account bindings in the finalized receipt.
  const mintCpi = grantReceipt.meta.innerInstructions.find(group => group.index === 1)?.instructions.find(ix =>
    grantReceipt.transaction.message.accountKeys[ix.programIdIndex] === TOKEN_PROGRAM_ADDRESS
    && Buffer.from(getBase58Encoder().encode(ix.data)).equals(Buffer.concat([Buffer.from([7]), u64(grant.amount)])));
  assert(mintCpi, "Finalized claim lacks exact SPL MintTo CPI");
  assert.deepEqual(mintCpi.accounts.map(index => grantReceipt.transaction.message.accountKeys[index]), [mint, grantAta, mintAuthority]);
  const afterGrant = await rpc<Context<(ChainAccount | null)[]>>("getMultipleAccounts", [grantKeys,
    { encoding: "base64", commitment: "finalized", minContextSlot: grantReceipt.slot }]);
  assert.deepEqual(decodeConfig(afterGrant.value[0]), { authorized: 2_000_000n, minted: 1_500_000n });
  assert.equal(getMintDecoder().decode(bytes(afterGrant.value[1])).supply, 1_500_000n);
  assert.equal(bytes(afterGrant.value[2]).readBigUInt64LE(112), 500_000n);
  assert.deepEqual(afterGrant.value[3], beforeGrant.value[3], "Identity record must remain immutable");
  assert.equal(afterGrant.value[4]?.owner, TOKEN_PROGRAM_ADDRESS);
  const grantToken = getTokenDecoder().decode(bytes(afterGrant.value[4]));
  assert.equal(grantToken.owner, other.address); assert.equal(grantToken.mint, mint); assert.equal(grantToken.amount, 500_000n);
  assert.equal(grantReceipt.meta.preBalances[0] - grantReceipt.meta.postBalances[0],
    grantReceipt.meta.fee + afterGrant.value[4]!.lamports, "Only wallet pays transaction fee plus ATA rent");
  await assert.rejects(prepareFeatherClaim({ runtime, wallet: other }), /already claimed/);
  assert.deepEqual((await accounts(grantKeys.slice(0, 5))), afterGrant.value.slice(0, 5), "Rejected replay preparation changed accounts");
  receipts.push({ name: "prepareFeatherClaim -> sole-wallet signing -> persisted submission -> finalized missing-ATA claim",
    signature: grantSignature, slot: grantReceipt.slot, error: null, feeLamports: grantReceipt.meta.fee,
    computeUnits: grantReceipt.meta.computeUnitsConsumed });
  console.log(`PASS wallet-prepared missing-ATA grant, chain Clock expiry/replay checks and exact-signature finality: ${grantSignature}`);
  console.log(JSON.stringify({ result: "PASS", rpc: endpoint.toString(), genesis, program: PROGRAM, programData,
    validator: await rpc("getVersion"), config, mint, mintAuthority, admin: admin.address, enrollmentAuthority: issuer.address,
    sourceAta: walletAta, recipientAta: transfer.destination, totalAuthorized: "2000000", totalMinted: "1500000",
    sourceUnits: "875544", recipientUnits: "123456", decimals: 3,
    market: book.market, seats: book.seats.address, vault: book.vault, vaultUnits: "1000", availableCash: "0", nextNonce: "3",
    transactionCaseCount: receipts.length, baselineTransactionCaseCount, clientBuilders: "src/lib/solana/escrow-client.ts", receipts,
    finalizedReader: { passed: true, slot: shippingRead.finalizedSlot.toString(), source: "src/lib/solana/escrow-read.ts" },
    preparedTransfer: { passed: true, observedSlot: transfer.observedSlot.toString(), feePayer: wallet.address, source: "src/lib/solana/prepare-transfer.ts" },
    preparedSubmissions,
    preparedFeatherClaim: { passed: true, source: "src/lib/solana/prepare-feather-claim.ts", observedSlot: grant.observedSlot.toString(),
      chainTimestamp: grant.chainTimestamp.toString(), expiresAt: grant.expiresAt.toString(), amount: grant.amount.toString(),
      createsAta: true, ata: grantAta, feePayer: other.address, soleSigner: other.address, finalizedSignature: grantSignature,
      finalizedSlot: grantReceipt.slot, computeUnits: grantReceipt.meta.computeUnitsConsumed, receiptPath: submissionPath,
      persistedBeforeSend: true, alreadyClaimedRejected: true, expiredGrantRejectedUsingChainClock: true },
    scope: "Actual deployed issuance, prepared/signed/submitted wallet transfer and missing-ATA grant claim, chain-Clock expiry and preparation replay rejection, market creation, seat registration, token CPI deposits/withdrawals, nonce rejection, donation surplus and atomic rollback. Matching, resolution, reserved positions, seat capacity exhaustion, concurrent sends, RPC restart/recovery and browser wallets are not tested. This suite does not stop its supplied validator; the isolated runner owns lifecycle. This suite writes or prints no private keys.",
  }, null, 2));
}
main().catch((error: unknown) => { console.error(error instanceof Error ? error.message : "Foundation E2E failed"); process.exitCode = 1; });
