/** Node-only publication support; state/receipts are private, not web configuration. */
import assert from "node:assert/strict";
import { constants } from "node:fs";
import { lstat, open, readFile } from "node:fs/promises";
import path from "node:path";
import { address, appendTransactionMessageInstructions, blockhash, compileTransaction, createSolanaRpc, createTransactionMessage,
  getAddressDecoder, getBase64Encoder, getBase64EncodedWireTransaction, getCompiledTransactionMessageDecoder, getPublicKeyFromAddress,
  getSignatureFromTransaction, getTransactionDecoder, pipe, setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash, signature, verifySignature, type Address, type Instruction, type TransactionSigner } from "@solana/kit";
import { createTransferReceiptStore } from "../../src/lib/solana/transfer-receipts";
import { decodeMarketTerms, hashMarketTerms, verifyMarketTerms } from "../../src/lib/solana/market-terms";
import { resolveSolanaRuntime, probeSolanaRuntime, type SolanaRuntime } from "../../src/lib/solana/runtime";
import { verifyGooseyConfiguration } from "../../src/lib/solana/configuration";
import { deriveGooseySeatAddresses } from "../../src/lib/solana/escrow-client";
import { deriveGooseyResolutionAddresses } from "../../src/lib/solana/resolution-client";
import { deriveGooseyMarketTermsAddresses, readMarketTermsAccount } from "../../src/lib/solana/market-terms-client";
import { verifyGooseyEscrowSnapshot } from "../../src/lib/solana/escrow-read";
import { readCanonicalOrderBook } from "../../src/lib/solana/order-book-read";
import { GOOSEY_BOOK_BYTES, GOOSEY_BOOK_GROWTH } from "../../src/lib/solana/exchange-client";

export function absolute(value: string) {
  assert(path.isAbsolute(value) && !/[\0\r\n]/.test(value), "Explicit absolute file/directory path required"); return value;
}
export async function readPublicationFile(file: string, privateOnly = true, max = 64 * 1024) {
  absolute(file); const info = await lstat(file);
  assert(info.isFile() && !info.isSymbolicLink() && info.size > 0 && info.size <= max, "Invalid publication file type/size");
  if (privateOnly) assert((info.mode & 0o077) === 0 && info.uid === process.getuid?.(), "Private file permissions/owner required");
  return readFile(file);
}
export async function writePublicationFile(directory: string, name: string, bytes: Uint8Array | string) {
  assert(/^[a-zA-Z0-9._-]+$/.test(name), "Invalid state filename");
  const handle = await open(path.join(directory, name), "wx", 0o600);
  try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
  await syncPublicationDirectory(directory);
}
export async function syncPublicationDirectory(directory: string) {
  const fd = await open(directory, constants.O_RDONLY); try { await fd.sync(); } finally { await fd.close(); }
}
export async function publicationExists(file: string) {
  try { await lstat(file); return true; } catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return false; throw e; }
}
export async function loadPublicationManifest(bytes: Uint8Array, runtime: SolanaRuntime) {
  const copy = new Uint8Array(bytes), manifest = decodeMarketTerms(copy), digest = await hashMarketTerms(copy);
  assert.equal(manifest.binding.cluster, runtime.cluster); assert.equal(manifest.binding.genesisHash, runtime.genesisHash);
  assert.equal(manifest.binding.program, runtime.programAddress);
  await verifyMarketTerms(copy, { digest, binding: manifest.binding, economics: manifest.economics,
    proposer: manifest.oracle.proposer, approver: manifest.oracle.approver });
  return { bytes: copy, manifest, digest };
}
export function parsePublicationRuntime(value: unknown) {
  assert(value && typeof value === "object" && !Array.isArray(value), "Runtime must be a JSON object");
  const v = value as Record<string, unknown>;
  assert.deepEqual(Object.keys(v).sort(), ["cluster", "genesisHash", "programAddress", "rpcUrl"].sort());
  assert(Object.values(v).every(v => typeof v === "string"), "Runtime fields must be explicit strings");
  return resolveSolanaRuntime({ GOOSEY_SOLANA_CLUSTER: v.cluster as string, GOOSEY_SOLANA_RPC_URL: v.rpcUrl as string,
    GOOSEY_SOLANA_PROGRAM_ID: v.programAddress as string, GOOSEY_SOLANA_GENESIS_HASH: v.genesisHash as string });
}

export type Publication = Awaited<ReturnType<typeof loadPublicationManifest>>;
export type PublicationReceipt = { step: string; digest: string; genesisHash: string; signature: string; lastValidBlockHeight: string; signedWireBase64: string };
export function publicationComputeBudget(): Instruction {
  const data = new Uint8Array(5); data[0] = 2; new DataView(data.buffer).setUint32(1, 1_400_000, true);
  return { programAddress: address("ComputeBudget111111111111111111111111111111"), data };
}
/** Real Ed25519 verification plus exact recompilation of shipping ABI/account
 * intent. Height is unsigned lifetime metadata, not proof of chain inclusion.
 * Single-signer stages reuse the wallet receipt validator; Seats creation must
 * additionally verify the second signer (the wallet store intentionally rejects it).
 */
export async function validatePublicationReceipt(value: unknown, expected: {
  step: string; digest: string; runtime: SolanaRuntime; payer: TransactionSigner; instructions: readonly Instruction[];
}): Promise<PublicationReceipt> {
  assert(value && typeof value === "object" && !Array.isArray(value), "Invalid publication receipt");
  const r = { ...value } as PublicationReceipt;
  assert.deepEqual(Object.keys(r).sort(), ["step", "digest", "genesisHash", "signature", "lastValidBlockHeight", "signedWireBase64"].sort());
  assert(r.step === expected.step && r.digest === expected.digest && r.genesisHash === expected.runtime.genesisHash, "Receipt intent/domain mismatch");
  assert(typeof r.lastValidBlockHeight === "string" && /^(0|[1-9][0-9]{0,19})$/.test(r.lastValidBlockHeight)
    && BigInt(r.lastValidBlockHeight) <= (1n << 64n) - 1n, "Invalid receipt lifetime");
  signature(r.signature);
  assert(typeof r.signedWireBase64 === "string" && r.signedWireBase64.length <= 1644
    && /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(r.signedWireBase64), "Invalid receipt wire");
  const wire = getBase64Encoder().encode(r.signedWireBase64); assert(wire.length <= 1232, "Oversized transaction");
  const tx = getTransactionDecoder().decode(wire), decoded = getCompiledTransactionMessageDecoder().decode(tx.messageBytes);
  assert.equal(getBase64EncodedWireTransaction(tx), r.signedWireBase64, "Noncanonical receipt wire");
  assert.equal(getSignatureFromTransaction(tx), r.signature, "Receipt signature mismatch");
  assert(decoded.version === 0 && decoded.lifetimeToken, "Expected recent-blockhash v0 transaction");
  const message = pipe(createTransactionMessage({ version: 0 }), m => setTransactionMessageFeePayerSigner(expected.payer, m),
    m => setTransactionMessageLifetimeUsingBlockhash({ blockhash: blockhash(decoded.lifetimeToken), lastValidBlockHeight: BigInt(r.lastValidBlockHeight) }, m),
    m => appendTransactionMessageInstructions(expected.instructions, m));
  const compiled = compileTransaction(message);
  assert.deepEqual(new Uint8Array(tx.messageBytes), new Uint8Array(compiled.messageBytes), "Receipt does not match exact intended instruction/account ABI");
  const signers = Object.keys(compiled.signatures);
  assert.deepEqual(Object.keys(tx.signatures).sort(), [...signers].sort(), "Unexpected receipt signers");
  if (signers.length === 1) {
    const entries = new Map<string, string>();
    const store = createTransferReceiptStore({ get length() { return entries.size; }, key: i => [...entries.keys()][i] ?? null,
      getItem: key => entries.get(key) ?? null, setItem: (key, value) => { entries.set(key, value); } },
    { ...expected.runtime, walletAddress: expected.payer.address });
    await store.persist({ signature: r.signature, signedWireBase64: r.signedWireBase64, lastValidBlockHeight: BigInt(r.lastValidBlockHeight) });
  } else {
    assert(signers.length === 2 && expected.step === "market", "Only market creation may have a second signer");
    for (const key of signers) {
      const sig = tx.signatures[address(key)];
      assert(sig && await verifySignature(await getPublicKeyFromAddress(address(key)), sig, tx.messageBytes), "Invalid publication co-signature");
    }
  }
  return { ...r };
}
/** One coherent finalized batch for all manifest bindings and account state;
 * draft book validation uses the actual bootstrap layout, ready books use the
 * shipping full-book reconciler. No fabricated wallet account is required. */
export async function readPublicationSnapshot(runtime: SolanaRuntime, publication: Publication, seats: Address | null, signal: AbortSignal) {
  const { manifest, digest, bytes } = publication, marketId = BigInt(manifest.binding.marketId), wallet = address(manifest.binding.creator);
  const rpc = createSolanaRpc(runtime.rpcUrl), base = await deriveGooseySeatAddresses({ programAddress: runtime.programAddress, marketId, wallet });
  const r = await deriveGooseyResolutionAddresses({ programAddress: runtime.programAddress, marketId });
  const t = await deriveGooseyMarketTermsAddresses({ programAddress: runtime.programAddress, marketId });
  const reviewers = [manifest.oracle.proposer, manifest.oracle.approver];
  const reviewerPdas = await Promise.all(reviewers.map(reviewer => deriveGooseySeatAddresses({ programAddress: runtime.programAddress, marketId, wallet: address(reviewer.wallet) })));
  const probe = await probeSolanaRuntime(runtime, rpc, signal);
  const addresses = [base.config, base.featherMint, base.market, seats ?? base.market, base.locator, base.vault, base.walletTokens, r.book, t.terms, r.resolution,
    ...reviewerPdas.map(pda => pda.enrollment)];
  const response = await rpc.getMultipleAccounts(addresses, { encoding: "base64", commitment: "finalized", minContextSlot: BigInt(probe.finalizedSlot) }).send({ abortSignal: signal });
  const [config, mint, market, seatsAccount, locator, vault, walletTokens, book, termsAccount, resolution] = response.value;
  assert(response.value.length === 12 && response.context.slot >= BigInt(probe.finalizedSlot), "Invalid finalized snapshot");
  const configuration = await verifyGooseyConfiguration(runtime, config, mint);
  assert.equal(configuration.admin, manifest.binding.creator); assert.equal(base.config, manifest.binding.config);
  assert.equal(base.market, manifest.binding.market); assert.equal(base.featherMint, manifest.binding.featherMint);
  const enrollmentDiscriminator = Buffer.from(await crypto.subtle.digest("SHA-256", new TextEncoder().encode("account:Enrollment"))).subarray(0, 8);
  for (let i = 0; i < 2; i++) {
    assert.equal(reviewerPdas[i].enrollment, reviewers[i].enrollment);
    const account = response.value[10 + i]; if (!account) continue;
    assert(account.owner === runtime.programAddress && !account.executable, "Invalid reviewer enrollment envelope");
    const raw = Buffer.from(account.data[0], "base64"), key = (offset: number) => getAddressDecoder().decode(raw.subarray(offset, offset + 32));
    assert(raw.length === 129 && raw.subarray(0, 8).equals(enrollmentDiscriminator), "Invalid reviewer enrollment layout");
    assert(key(8) === base.config && key(40) === reviewers[i].wallet && raw.subarray(72, 104).some(Boolean)
      && raw.readBigUInt64LE(104) > 0n && raw.readBigUInt64LE(112) <= raw.readBigUInt64LE(104)
      && raw.readBigInt64LE(120) > 0n && raw[128] === reviewerPdas[i].enrollmentBump, "Reviewer enrollment does not match manifest");
  }
  const reviewersEnrolled = response.value[10] !== null && response.value[11] !== null;
  if (!market) {
    assert(!book && !termsAccount && !resolution && (!seats || !seatsAccount), "Orphaned publication accounts");
    return { slot: response.context.slot, market: null, book: null, terms: null, resolution: null, reviewersEnrolled };
  }
  assert(seats, "Market already exists; refusing to adopt unknown Seats");
  const verified = await verifyGooseyEscrowSnapshot(runtime, { marketId, wallet }, seats,
    { config, mint, market, seats: seatsAccount, locator, vault, walletTokens, ...(resolution ? { resolution } : {}) });
  const m = verified.marketState, e = manifest.economics;
  assert.equal(m.payoutMilli.toString(), e.payoutMilli); assert.equal(String(m.feeBps), e.feeBps);
  assert.equal(m.closesAt.toString(), e.closesAt); assert.equal(m.resolvesAt.toString(), e.resolvesAt);
  let bookState: { ready: boolean; size: number } | null = null;
  const envelope = (key: Address, account: NonNullable<typeof market>) => ({ address: key, owner: account.owner, executable: account.executable, data: Buffer.from(account.data[0], "base64") });
  if (book) {
    assert.equal(book.owner, runtime.programAddress); assert(!book.executable);
    const data = Buffer.from(book.data[0], "base64");
    if (data.subarray(0, 8).toString() === "GOOSEYI1") {
      assert(data.length === GOOSEY_BOOK_BYTES || (data.length >= GOOSEY_BOOK_GROWTH && data.length < GOOSEY_BOOK_BYTES && data.length % GOOSEY_BOOK_GROWTH === 0), "Malformed book draft size");
      assert(!data.subarray(8).some(Boolean), "Malformed book draft contents");
      bookState = { ready: false, size: data.length };
    } else {
      assert(seatsAccount);
      await readCanonicalOrderBook({ programAddress: runtime.programAddress, marketId,
        market: envelope(base.market, market), seats: envelope(seats, seatsAccount), book: envelope(r.book, book),
        ...(resolution ? { resolution: envelope(r.resolution, resolution) } : {}) });
      bookState = { ready: true, size: data.length };
    }
  }
  const terms = termsAccount ? await readMarketTermsAccount({ programAddress: runtime.programAddress, marketId,
    config: base.config, market: base.market, creator: wallet,
    proposer: { wallet: address(manifest.oracle.proposer.wallet), enrollment: address(manifest.oracle.proposer.enrollment) },
    approver: { wallet: address(manifest.oracle.approver.wallet), enrollment: address(manifest.oracle.approver.enrollment) } }, envelope(t.terms, termsAccount)) : null;
  if (terms) {
    assert(bookState?.ready, "Terms without ready book");
    assert.equal(Buffer.from(terms.digest).toString("hex"), digest); assert.equal(terms.manifestLength, bytes.length);
  }
  if (verified.resolution) {
    assert(terms?.sealed, "Resolution without sealed terms");
    assert.deepEqual(verified.resolution.proposer, manifest.oracle.proposer); assert.deepEqual(verified.resolution.approver, manifest.oracle.approver);
  }
  return { slot: response.context.slot, market: verified, book: bookState, terms, resolution: verified.resolution, reviewersEnrolled };
}

/** Persist-before-send sequencing. Completion callbacks MUST validate actual
 * finalized state. Existing unresolved receipts are tracked, never re-signed. */
export async function publicationStep<R>(input: {
  complete: () => Promise<boolean>; load: () => Promise<R | null>; prepare: () => Promise<R>;
  persist: (receipt: R) => Promise<void>; send: (receipt: R) => Promise<void>;
  confirm: (receipt: R) => Promise<boolean>;
}) {
  if (await input.complete()) return "already-finalized" as const;
  let receipt = await input.load();
  if (!receipt) {
    receipt = await input.prepare(); await input.persist(receipt);
    // A transport failure says nothing about execution. Always reconcile.
    try { await input.send(receipt); } catch { /* confirm exact retained signature */ }
  }
  assert(await input.confirm(receipt), "Publication receipt unresolved/failed; no replacement signed");
  assert(await input.complete(), "Finalized receipt does not establish expected publication state");
  return "finalized" as const;
}
