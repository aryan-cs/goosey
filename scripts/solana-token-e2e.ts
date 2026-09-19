/** Real SPL Token RPC test. Only an explicitly pinned loopback validator is allowed.
 * All keys are ephemeral in memory; no existing wallets or validator lifecycle
 * are touched. Run with node --import tsx scripts/solana-token-e2e.ts.
 */
import assert from "node:assert/strict";
import { DEVNET_GENESIS_HASH, MAINNET_GENESIS_HASH, TESTNET_GENESIS_HASH } from "../src/lib/solana/runtime";
import { setTimeout as delay } from "node:timers/promises";
import {
  address, appendTransactionMessageInstructions,
  blockhash,
  createTransactionMessage,
  generateKeyPairSigner,
  getBase64EncodedWireTransaction,
  getSignatureFromTransaction,
  pipe,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
  type Address,
  type Instruction,
  type TransactionSigner,
} from "@solana/kit";
import { getCreateAccountInstruction } from "@solana-program/system";
import {
  findAssociatedTokenPda,
  getCreateAssociatedTokenIdempotentInstruction,
  getInitializeMint2Instruction,
  getMintDecoder,
  getMintSize,
  getMintToCheckedInstruction,
  getTokenDecoder,
  getTransferCheckedInstruction,
  TOKEN_PROGRAM_ADDRESS,
} from "@solana-program/token";
import { buildFeatherTransfer, FEATHER_DECIMALS } from "../src/lib/solana/feather-transfer";

type RpcAccount = { data: [string, string]; owner: string; lamports: number; executable: boolean };
type RpcContext<T> = { context: { slot: number }; value: T };
type Receipt = { slot: number; meta: { err: unknown; fee: number; logMessages: string[] | null } | null };
class RpcFailure extends Error {
  constructor(readonly code: number, message: string) { super(message); }
}

async function main() {
  const endpoint = new URL(process.env.GOOSEY_SOLANA_RPC_URL ?? "");
  // Literal loopback avoids DNS/proxy names. Redirects are also forbidden below.
  assert(["127.0.0.1", "[::1]"].includes(endpoint.hostname), "Token E2E requires literal loopback RPC");
  assert(["http:", "https:"].includes(endpoint.protocol), "RPC requires HTTP(S)");
  assert(!endpoint.username && !endpoint.password && !endpoint.hash && !endpoint.search, "Unexpected RPC URL credentials/fragment/query");
  const genesis = process.env.GOOSEY_SOLANA_GENESIS_HASH;
  assert(genesis && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(genesis), "Explicit genesis pin required");
  address(genesis);
  assert(![
    MAINNET_GENESIS_HASH,
    DEVNET_GENESIS_HASH,
    TESTNET_GENESIS_HASH,
  ].includes(genesis), "Public cluster genesis is prohibited");
  let requestId = 0;
  async function rpc<T>(method: string, params: unknown[] = []): Promise<T> {
    const response = await fetch(endpoint, {
      method: "POST", redirect: "error", signal: AbortSignal.timeout(10_000),
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++requestId, method, params }),
    });
    assert(response.ok, `RPC HTTP ${response.status} for ${method}`);
    const body = await response.json() as { result: T; error?: { code: number; message: string } };
    if (body.error) throw new RpcFailure(body.error.code, body.error.message);
    return body.result;
  }
  async function pin() {
    assert.equal(await rpc<string>("getGenesisHash"), genesis, "Genesis mismatch: refusing chain writes");
  }
  await pin();
  const version = await rpc<Record<string, unknown>>("getVersion");
  const payer = await generateKeyPairSigner();
  const recipient = await generateKeyPairSigner();
  const attacker = await generateKeyPairSigner();
  const mint = await generateKeyPairSigner();
  const otherMint = await generateKeyPairSigner();
  const receipts: Record<string, unknown>[] = [];
  const commitment = "confirmed";
  async function confirmed(signature: string) {
    const deadline = Date.now() + 45_000;
    while (Date.now() < deadline) {
      const statuses = await rpc<RpcContext<({ confirmationStatus: string; err: unknown } | null)[]>>(
        "getSignatureStatuses", [[signature], { searchTransactionHistory: true }],
      );
      const status = statuses.value[0];
      if (status && ["confirmed", "finalized"].includes(status.confirmationStatus)) return status;
      await delay(200);
    }
    throw new Error(`Confirmation timed out; result is unknown for ${signature}`);
  }
  async function receipt(signature: string) {
    for (let attempt = 0; attempt < 30; attempt++) {
      const result = await rpc<Receipt | null>("getTransaction", [signature, { commitment, maxSupportedTransactionVersion: 0 }]);
      if (result?.meta) return result as Receipt & { meta: NonNullable<Receipt["meta"]> };
      await delay(200);
    }
    throw new Error(`Missing actual transaction receipt for ${signature}`);
  }
  async function build(instructions: readonly Instruction[]) {
    const latest = await rpc<RpcContext<{ blockhash: string; lastValidBlockHeight: number }>>("getLatestBlockhash", [{ commitment }]);
    const message = pipe(
      createTransactionMessage({ version: 0 }),
      (tx) => setTransactionMessageFeePayerSigner(payer, tx),
      (tx) => setTransactionMessageLifetimeUsingBlockhash({
        blockhash: blockhash(latest.value.blockhash), lastValidBlockHeight: BigInt(latest.value.lastValidBlockHeight),
      }, tx),
      (tx) => appendTransactionMessageInstructions(instructions, tx),
    );
    const signed = await signTransactionMessageWithSigners(message);
    return { wire: getBase64EncodedWireTransaction(signed), signature: getSignatureFromTransaction(signed) };
  }
  async function execute(name: string, instructions: readonly Instruction[], expectedError: unknown = null) {
    await pin();
    const transaction = await build(instructions);
    // Failure cases intentionally reach the validator, not just RPC simulation.
    const signature = await rpc<string>("sendTransaction", [transaction.wire, { encoding: "base64", skipPreflight: true, maxRetries: 0 }]);
    assert.equal(signature, transaction.signature);
    await confirmed(signature);
    const result = await receipt(signature);
    assert.deepEqual(result.meta.err, expectedError, `${name}: unexpected execution result`);
    assert(result.meta.logMessages?.some((line) => line.includes(`Program ${TOKEN_PROGRAM_ADDRESS} invoke`)), `${name}: token program did not execute`);
    receipts.push({ name, signature, slot: result.slot, error: result.meta.err, networkFeeLamports: result.meta.fee });
    console.log(`PASS ${name}: ${signature}`);
    return transaction;
  }
  async function accounts(addresses: readonly Address[]) {
    return (await rpc<RpcContext<(RpcAccount | null)[]>>("getMultipleAccounts", [addresses, { encoding: "base64", commitment }])).value;
  }
  await pin();
  const funding = await rpc<string>("requestAirdrop", [payer.address, 2_000_000_000]);
  assert.equal((await confirmed(funding)).err, null, "Ephemeral local SOL funding failed");
  const rent = await rpc<number>("getMinimumBalanceForRentExemption", [getMintSize()]);
  function mintInstructions(newMint: TransactionSigner) {
    return [
      getCreateAccountInstruction({ payer, newAccount: newMint, lamports: BigInt(rent), space: BigInt(getMintSize()), programAddress: TOKEN_PROGRAM_ADDRESS }),
      getInitializeMint2Instruction({ mint: newMint.address, decimals: FEATHER_DECIMALS, mintAuthority: payer.address }),
    ];
  }
  const [source] = await findAssociatedTokenPda({ mint: mint.address, owner: payer.address, tokenProgram: TOKEN_PROGRAM_ADDRESS });
  const initialSupply = 1_000_000n; // 1,000 feathers at three decimals.
  await execute("initialize mint, source ATA, and mint 1000 feathers", [
    ...mintInstructions(mint),
    getCreateAssociatedTokenIdempotentInstruction({ payer, ata: source, owner: payer.address, mint: mint.address, tokenProgram: TOKEN_PROGRAM_ADDRESS }),
    getMintToCheckedInstruction({ mint: mint.address, token: source, mintAuthority: payer, amount: initialSupply, decimals: FEATHER_DECIMALS }),
  ]);
  await execute("initialize independent wrong mint", mintInstructions(otherMint));
  const transfer = await buildFeatherTransfer({ mint: mint.address, sender: payer, recipient: recipient.address, amount: 123_456n });
  assert.equal(transfer.source, source);
  const watched = [mint.address, source, transfer.destination, otherMint.address];
  function tokenData(account: RpcAccount | null) {
    assert(account, "Token account must exist");
    assert.equal(account.owner, TOKEN_PROGRAM_ADDRESS);
    return getTokenDecoder().decode(Buffer.from(account.data[0], "base64"));
  }
  async function assertEconomics(sourceAmount: bigint, destinationAmount: bigint) {
    const state = await accounts(watched);
    assert(state[0]);
    assert.equal(state[0].owner, TOKEN_PROGRAM_ADDRESS);
    const mintData = getMintDecoder().decode(Buffer.from(state[0].data[0], "base64"));
    assert.equal(mintData.decimals, 3);
    assert.equal(mintData.supply, initialSupply);
    const sourceData = tokenData(state[1]);
    assert.equal(sourceData.owner, payer.address);
    assert.equal(sourceData.mint, mint.address);
    assert.equal(sourceData.amount, sourceAmount);
    if (state[2]) {
      const destinationData = tokenData(state[2]);
      assert.equal(destinationData.owner, recipient.address);
      assert.equal(destinationData.mint, mint.address);
      assert.equal(destinationData.amount, destinationAmount);
    } else assert.equal(destinationAmount, 0n);
    assert.equal(sourceAmount + destinationAmount, mintData.supply, "Supply must equal all funded token holdings");
    return state;
  }
  assert.equal((await assertEconomics(initialSupply, 0n))[2], null, "Recipient ATA should not preexist");
  const success = await execute("application helper creates recipient ATA and transfers 123.456 feathers", transfer.instructions);
  const afterTransfer = await assertEconomics(876_544n, 123_456n);
  await pin();
  // Exact signed-wire replay: never rebuild or refresh its blockhash.
  try {
    const replaySignature = await rpc<string>("sendTransaction", [success.wire, { encoding: "base64", skipPreflight: true, maxRetries: 0 }]);
    assert.equal(replaySignature, success.signature);
  } catch (error) {
    // Some validators reject an already processed transaction at submission.
    assert(error instanceof RpcFailure && /already processed/i.test(error.message), "Unexpected replay submission failure");
  }
  await confirmed(success.signature);
  // Require new confirmed blocks after replay so comparison is not immediate.
  const replayStart = await rpc<number>("getBlockHeight", [{ commitment }]);
  const replayDeadline = Date.now() + 15_000;
  while (await rpc<number>("getBlockHeight", [{ commitment }]) < replayStart + 2) {
    assert(Date.now() < replayDeadline, "Validator did not advance after replay");
    await delay(200);
  }
  assert.deepEqual(await accounts(watched), afterTransfer, "Exact signed replay changed token state");
  const history = await rpc<{ signature: string }[]>("getSignaturesForAddress", [transfer.destination, { commitment }]);
  assert.equal(history.filter((entry) => entry.signature === success.signature).length, 1);
  receipts.push({ name: "exact signed transaction replay delivers once", signature: success.signature });
  console.log("PASS exact signed transaction replay: unchanged balances and supply");

  const second = await buildFeatherTransfer({ mint: mint.address, sender: payer, recipient: recipient.address, amount: 1n });
  await execute("application helper reuses existing ATA for 0.001 feather", second.instructions);
  await assertEconomics(876_543n, 123_457n);
  const base = { source, destination: transfer.destination, mint: mint.address, authority: payer, amount: 1n, decimals: FEATHER_DECIMALS };
  async function rejected(name: string, instructions: readonly Instruction[], expectedError: unknown, extra: Address[] = []) {
    const targets = [...watched, ...extra];
    const before = await accounts(targets);
    await execute(name, instructions, expectedError);
    assert.deepEqual(await accounts(targets), before, `${name}: failed transaction mutated token/mint accounts`);
    await assertEconomics(876_543n, 123_457n);
  }
  await rejected("wrong decimals", [getTransferCheckedInstruction({ ...base, decimals: 2 })], { InstructionError: [0, { Custom: 18 }] });
  await rejected("wrong mint", [getTransferCheckedInstruction({ ...base, mint: otherMint.address })], { InstructionError: [0, { Custom: 3 }] });
  await rejected("unauthorized owner", [getTransferCheckedInstruction({ ...base, authority: attacker })], { InstructionError: [0, { Custom: 4 }] });
  await rejected("insufficient balance", [getTransferCheckedInstruction({ ...base, amount: 876_544n })], { InstructionError: [0, { Custom: 1 }] });
  await rejected("missing owner signature", [getTransferCheckedInstruction({ ...base, authority: recipient.address, source: transfer.destination, destination: source })], { InstructionError: [0, "MissingRequiredSignature"] });
  await rejected("unauthorized mint authority cannot grant feathers", [getMintToCheckedInstruction({ mint: mint.address, token: source, mintAuthority: attacker, amount: 1n, decimals: FEATHER_DECIMALS })], { InstructionError: [0, { Custom: 4 }] });
  const freshRecipient = await generateKeyPairSigner();
  const fresh = await buildFeatherTransfer({ mint: mint.address, sender: payer, recipient: freshRecipient.address, amount: 1n });
  assert.equal((await accounts([fresh.destination]))[0], null);
  await rejected("ATA creation rolls back when transfer fails", [fresh.instructions[0], getTransferCheckedInstruction({ ...base, destination: fresh.destination, decimals: 2 })], { InstructionError: [1, { Custom: 18 }] }, [fresh.destination]);

  const beforeInvalidSignature = await accounts(watched);
  const valid = await build([getTransferCheckedInstruction({ ...base, amount: 2n })]);
  const invalid = Buffer.from(valid.wire, "base64");
  assert.equal(invalid[0], 1, "Expected a single-signature shortvec");
  invalid[1] ^= 1; // Corrupt only the real fee payer's Ed25519 signature.
  await pin();
  let signatureRejectionCode: number | undefined;
  await assert.rejects(
    rpc("sendTransaction", [invalid.toString("base64"), { encoding: "base64", skipPreflight: false }]),
    (error: unknown) => {
      if (error instanceof RpcFailure && [-32003, -32002].includes(error.code) && /signature verification/i.test(error.message)) {
        signatureRejectionCode = error.code;
        return true;
      }
      throw new Error(`Unexpected signature rejection: ${error instanceof RpcFailure ? `${error.code}: ${error.message}` : String(error)}`);
    },
    "Validator must reject the invalid Ed25519 signature",
  );
  assert.deepEqual(await accounts(watched), beforeInvalidSignature);
  receipts.push({ name: "invalid Ed25519 signature rejected by RPC verification", rpcCode: signatureRejectionCode });
  console.log("PASS invalid Ed25519 signature: rejected with unchanged token state");
  await assertEconomics(876_543n, 123_457n);
  console.log(JSON.stringify({
    result: "PASS", rpc: endpoint.toString(), genesis, validator: version,
    tokenProgram: TOKEN_PROGRAM_ADDRESS, mint: mint.address,
    sourceOwner: payer.address, recipientOwner: recipient.address, source, destination: transfer.destination,
    decimals: FEATHER_DECIMALS, mintedBaseUnits: initialSupply.toString(),
    finalSourceBaseUnits: "876543", finalRecipientBaseUnits: "123457", supplyConserved: true,
    helper: "src/lib/solana/feather-transfer.ts:buildFeatherTransfer", receipts,
    limits: "Real SPL Token and ATA execution only; no exchange escrow, grant cap, CLOB, browser wallet, or devnet verification. Validator remains running. Ephemeral private keys were not persisted.",
  }, null, 2));
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "Token E2E failed");
  process.exitCode = 1;
});
