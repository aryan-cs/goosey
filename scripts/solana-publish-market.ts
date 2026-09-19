/** Explicit creator operator. Never holds reviewer keys or manufactures terms. */
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { lstat, mkdir, realpath, unlink } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { address, appendTransactionMessageInstructions, createKeyPairSignerFromBytes, createNoopSigner, createSolanaRpc,
  createTransactionMessage, getAddressDecoder, getBase64EncodedWireTransaction, getSignatureFromTransaction, pipe,
  setTransactionMessageFeePayerSigner, setTransactionMessageLifetimeUsingBlockhash, signTransactionMessageWithSigners,
  type Instruction, type TransactionSigner } from "@solana/kit";
import { retainMarketTerms, readRetainedMarketTerms } from "../src/lib/solana/market-terms-store";
import { buildCreateMarketInstructions, GOOSEY_SEATS_ACCOUNT_SPACE } from "../src/lib/solana/escrow-client";
import { buildBookSetupInstruction, GOOSEY_BOOK_BYTES } from "../src/lib/solana/exchange-client";
import { buildAcceptMarketTermsInstruction, buildInitializeMarketTermsInstruction, buildSealMarketTermsInstruction } from "../src/lib/solana/market-terms-client";
import { buildInitializeResolutionInstruction } from "../src/lib/solana/resolution-client";
import { trackTransactionStatus } from "../src/lib/solana/transaction-status";
import { absolute, loadPublicationManifest, parsePublicationRuntime, publicationExists, publicationStep,
  publicationComputeBudget, validatePublicationReceipt, type PublicationReceipt,
  readPublicationFile, readPublicationSnapshot, syncPublicationDirectory, writePublicationFile } from "./lib/solana-publication";

const usage = `Usage: node --import tsx scripts/solana-publish-market.ts COMMAND
  --runtime /absolute/runtime.json --manifest /absolute/canonical-terms.json
  --state /absolute/private/publication-directory --terms-directory /absolute/private/terms-store
  [--admin-key /absolute/admin.json]
COMMAND: prepare | init | review-instructions | seal | activate | status
Creator commands require --admin-key. Reviewer instructions/status do not load a signer.
prepare creates NEW private state; other commands resume it. Manifest is existing
canonical bytes, never generated. No enrollments, approvals, funding, DB/env edits.
See docs/solana-publication.md for independent reviewer signing and recovery.`;

async function main() {
  const { values, positionals } = parseArgs({ options: { runtime: { type: "string" }, manifest: { type: "string" },
    state: { type: "string" }, "terms-directory": { type: "string" }, "admin-key": { type: "string" }, help: { type: "boolean" } }, allowPositionals: true, strict: true });
  if (values.help) { console.log(usage); return; }
  const command = positionals[0];
  assert(positionals.length === 1 && ["prepare", "init", "review-instructions", "seal", "activate", "status"].includes(command), usage);
  assert(values.runtime && values.manifest && values.state && values["terms-directory"], usage);
  const state = absolute(values.state);
  assert.equal(await realpath(path.dirname(state)), path.dirname(state), "State parent must be canonical");
  const runtime = parsePublicationRuntime(JSON.parse((await readPublicationFile(values.runtime, false)).toString()));
  const publication = await loadPublicationManifest(await readPublicationFile(values.manifest, false, 24_576), runtime);
  const { manifest, digest } = publication, marketId = BigInt(manifest.binding.marketId), programAddress = runtime.programAddress;
  const termsDirectory = await realpath(absolute(values["terms-directory"]));
  for (const [a, b] of [[path.resolve(state), termsDirectory], [termsDirectory, path.resolve(state)]]) {
    const relative = path.relative(a, b); assert(relative.startsWith(`..${path.sep}`) || relative === "..", "Terms store and signing state must be separate, non-nested directories");
  }
  const termsExpectation = { digest, manifestLength: publication.bytes.length, binding: manifest.binding,
    economics: manifest.economics, proposer: manifest.oracle.proposer, approver: manifest.oracle.approver };
  const controller = new AbortController(), stop = () => controller.abort();
  process.once("SIGINT", stop); process.once("SIGTERM", stop);
  const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(600_000)]);
  const rpc = createSolanaRpc(runtime.rpcUrl);
  async function keypair(file: string) {
    const bytes: unknown = JSON.parse((await readPublicationFile(file)).toString());
    assert(Array.isArray(bytes) && bytes.length === 64 && bytes.every(v => Number.isInteger(v) && v >= 0 && v < 256), "Invalid private key file");
    const secret = Uint8Array.from(bytes); try { return await createKeyPairSignerFromBytes(secret); } finally { secret.fill(0); }
  }
  let admin: TransactionSigner | null = null;
  if (!["review-instructions", "status"].includes(command)) {
    assert(values["admin-key"], "Explicit creator/admin key required"); admin = await keypair(values["admin-key"]);
    assert.equal(admin.address, manifest.binding.creator, "Signer is not manifest creator");
  } else assert(!values["admin-key"], "Read-only commands must not receive private signer keys");
  if (command === "prepare") {
    await readPublicationSnapshot(runtime, publication, null, signal);
    await retainMarketTerms(termsDirectory, publication.bytes, termsExpectation);
    await mkdir(state, { mode: 0o700 });
    const jwk = generateKeyPairSync("ed25519").privateKey.export({ format: "jwk" }); assert(jwk.d && jwk.x);
    const secret = Buffer.concat([Buffer.from(jwk.d, "base64url"), Buffer.from(jwk.x, "base64url")]); delete jwk.d;
    try {
      await writePublicationFile(state, "seats.json", JSON.stringify([...secret]));
      await writePublicationFile(state, "seats-address.json", JSON.stringify({ address: getAddressDecoder().decode(secret.subarray(32)) }));
      await writePublicationFile(state, "terms.json", publication.bytes);
      await writePublicationFile(state, "runtime.json", JSON.stringify(runtime));
      await writePublicationFile(state, "terms-store.json", JSON.stringify({ directory: termsDirectory }));
      await syncPublicationDirectory(path.dirname(state));
    } finally { secret.fill(0); }
    console.log(JSON.stringify({ status: "prepared-not-published", market: manifest.binding.market, digest })); return;
  }
  const info = await lstat(state);
  assert(info.isDirectory() && !info.isSymbolicLink() && info.uid === process.getuid?.() && (info.mode & 0o077) === 0, "Unsafe publication state directory");
  assert.deepEqual(await readPublicationFile(path.join(state, "terms.json")), Buffer.from(publication.bytes), "Retained manifest differs");
  assert.deepEqual(JSON.parse((await readPublicationFile(path.join(state, "runtime.json"))).toString()), runtime, "Retained runtime differs");
  assert.deepEqual(JSON.parse((await readPublicationFile(path.join(state, "terms-store.json"))).toString()), { directory: termsDirectory }, "Retained terms directory differs");
  await readRetainedMarketTerms(termsDirectory, termsExpectation);
  const seats = address(JSON.parse((await readPublicationFile(path.join(state, "seats-address.json"))).toString()).address);
  const seatsSigner = command === "init" ? await keypair(path.join(state, "seats.json")) : null;
  if (seatsSigner) assert.equal(seatsSigner.address, seats, "Retained Seats key/address mismatch");
  await writePublicationFile(state, "operator.lock", JSON.stringify({ pid: process.pid }));
  let observedSlot = 0n;
  const snapshot = async () => {
    signal.throwIfAborted(); const result = await readPublicationSnapshot(runtime, publication, seats, signal);
    assert(result.slot >= observedSlot, "RPC finalized snapshot moved backwards"); observedSlot = result.slot; return result;
  };
  const base = { programAddress, marketId, seats };
  const creator = () => { assert(admin, "Creator signing unavailable"); return admin; };
  const reviewerAddresses = { proposer: address(manifest.oracle.proposer.wallet), approver: address(manifest.oracle.approver.wallet) };
  async function step(name: string, complete: (s: Awaited<ReturnType<typeof snapshot>>) => boolean, build: () => Promise<readonly Instruction[]>) {
    const filename = `${name}.receipt.json`;
    const result = await publicationStep<PublicationReceipt>({
      complete: async () => complete(await snapshot()),
      load: async () => {
        if (!await publicationExists(path.join(state, filename))) return null;
        const r: unknown = JSON.parse((await readPublicationFile(path.join(state, filename))).toString());
        return validatePublicationReceipt(r, { step: name, digest, runtime, payer: creator(),
          instructions: [publicationComputeBudget(), ...await build()] });
      },
      prepare: async () => {
        signal.throwIfAborted();
        const instructions = await build();
        const { value: lifetime } = await rpc.getLatestBlockhash({ commitment: "finalized", minContextSlot: observedSlot }).send({ abortSignal: signal });
        const intended = [publicationComputeBudget(), ...instructions];
        const message = pipe(createTransactionMessage({ version: 0 }), m => setTransactionMessageFeePayerSigner(creator(), m),
          m => setTransactionMessageLifetimeUsingBlockhash(lifetime, m),
          m => appendTransactionMessageInstructions(intended, m));
        const signed = await signTransactionMessageWithSigners(message);
        return validatePublicationReceipt({ step: name, digest, genesisHash: runtime.genesisHash, signature: getSignatureFromTransaction(signed),
          lastValidBlockHeight: lifetime.lastValidBlockHeight.toString(), signedWireBase64: getBase64EncodedWireTransaction(signed) },
        { step: name, digest, runtime, payer: creator(), instructions: intended });
      },
      persist: r => writePublicationFile(state, filename, JSON.stringify(r)),
      send: async r => {
        signal.throwIfAborted(); assert.equal(await rpc.getGenesisHash().send({ abortSignal: signal }), runtime.genesisHash);
        // Persisted bytes are produced only by the shipping instruction builders
        // above. Existing receipt files are NEVER passed to send or re-signed.
        const sent = await rpc.sendTransaction(r.signedWireBase64 as Parameters<typeof rpc.sendTransaction>[0],
          { encoding: "base64", skipPreflight: false, preflightCommitment: "confirmed", maxRetries: 0n }).send({ abortSignal: signal });
        assert.equal(sent, r.signature);
      },
      confirm: async r => {
        assert.equal(await rpc.getGenesisHash().send({ abortSignal: signal }), runtime.genesisHash);
        return (await trackTransactionStatus(rpc, { signature: r.signature, lastValidBlockHeight: BigInt(r.lastValidBlockHeight),
          commitment: "finalized", timeoutMs: 90_000, signal })).status === "finalized";
      },
    });
    console.log(JSON.stringify({ step: name, status: result, market: manifest.binding.market }));
  }
  try {
    const initial = await snapshot();
    if (command === "init") {
      assert(initial.reviewersEnrolled, "Both manifest reviewers must have actual matching enrollments before market initialization");
      await step("market", s => s.market !== null, async () => {
        assert(seatsSigner, "Retained Seats signer required");
        const rent = await rpc.getMinimumBalanceForRentExemption(GOOSEY_SEATS_ACCOUNT_SPACE, { commitment: "finalized" }).send({ abortSignal: signal });
        return (await buildCreateMarketInstructions({ programAddress, marketId, admin: creator(), seats: seatsSigner, seatsRentLamports: rent,
          payoutMilli: BigInt(manifest.economics.payoutMilli), feeBps: Number(manifest.economics.feeBps), closesAt: BigInt(manifest.economics.closesAt), resolvesAt: BigInt(manifest.economics.resolvesAt) })).instructions;
      });
      await step("book-create", s => s.book !== null, async () => [(await buildBookSetupInstruction({ programAddress, marketId, admin: creator(), step: { kind: "create" } })).instruction]);
      for (let n = 0; n < 8; n++) {
        const s = await snapshot(); assert(s.book);
        if (s.book.ready || s.book.size === GOOSEY_BOOK_BYTES) break;
        const size = s.book.size;
        await step(`book-grow-${size}`, s => !!s.book && (s.book.ready || s.book.size > size), async () => [(await buildBookSetupInstruction({ programAddress, marketId, admin: creator(), step: { kind: "grow", expectedSize: size } })).instruction]);
      }
      await step("book-finalize", s => s.book?.ready === true, async () => [(await buildBookSetupInstruction({ programAddress, marketId, admin: creator(), step: { kind: "finalize" } })).instruction]);
      await step("terms-init", s => s.terms !== null, async () => {
        // Recheck durable serving bytes immediately before signing the commitment.
        await retainMarketTerms(termsDirectory, publication.bytes, termsExpectation);
        return [(await buildInitializeMarketTermsInstruction({ ...base, creator: creator(), ...reviewerAddresses,
          version: 1, digest: Buffer.from(digest, "hex"), manifestLength: publication.bytes.length })).instruction];
      });
    } else if (command === "review-instructions") {
      assert(initial.terms && initial.book?.ready, "Initialize terms first");
      const instructions = await Promise.all(Object.entries(reviewerAddresses).map(async ([role, wallet]) => {
        const built = await buildAcceptMarketTermsInstruction({ ...base, reviewer: createNoopSigner(wallet), expectedDigest: Buffer.from(digest, "hex") });
        return { role, reviewer: wallet, programAddress, accounts: built.instruction.accounts.map(({ address, role }) => ({ address, role })), dataBase64: Buffer.from(built.instruction.data).toString("base64") };
      }));
      console.log(JSON.stringify({ status: "unsigned-reviewer-instructions-only", digest, genesisHash: runtime.genesisHash,
        market: manifest.binding.market, instructions }));
    } else if (command === "seal") {
      assert(initial.terms?.acceptanceBits === 3, "Both designated reviewers must independently accept exact terms first");
      await step("terms-seal", s => s.terms?.sealed === true, async () => [(await buildSealMarketTermsInstruction({ ...base, creator: creator(), expectedDigest: Buffer.from(digest, "hex") })).instruction]);
    } else if (command === "activate") {
      assert(initial.terms?.sealed, "Terms must already be sealed");
      await step("resolution-init", s => s.resolution !== null, async () => [(await buildInitializeResolutionInstruction({ ...base, creator: creator(), ...reviewerAddresses })).instruction]);
    }
    const final = await snapshot();
    console.log(JSON.stringify({ status: "finalized-state", market: manifest.binding.market, digest, slot: final.slot.toString(),
      marketExists: !!final.market, bookReady: final.book?.ready ?? false, termsInitialized: !!final.terms,
      reviewersEnrolled: final.reviewersEnrolled,
      reviewerAcceptanceBits: final.terms?.acceptanceBits ?? 0, termsSealed: final.terms?.sealed ?? false,
      resolutionInitialized: !!final.resolution, resolutionPhase: final.resolution?.phase ?? null }));
  } finally {
    await unlink(path.join(state, "operator.lock")); await syncPublicationDirectory(state);
    process.removeListener("SIGINT", stop); process.removeListener("SIGTERM", stop);
  }
}
main().catch(() => { console.error("Publication refused or incomplete. Retained state/receipts must be reconciled; no automatic replacement, reviewer approval, or rollback. Check explicit manifest/runtime, signer, on-chain prerequisites and private state."); process.exitCode = 1; });
