import { mkdtemp, readFile, rm, stat, symlink, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { address, appendTransactionMessageInstructions, blockhash, createTransactionMessage, generateKeyPairSigner,
  getAddressDecoder, getBase64EncodedWireTransaction, getSignatureFromTransaction, getTransactionDecoder, pipe,
  setTransactionMessageFeePayerSigner, setTransactionMessageLifetimeUsingBlockhash, signTransactionMessageWithSigners } from "@solana/kit";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildCreateMarketInstructions, deriveGooseySeatAddresses } from "../../src/lib/solana/escrow-client";
import { buildBookSetupInstruction } from "../../src/lib/solana/exchange-client";
import { encodeMarketTerms, type MarketTerms } from "../../src/lib/solana/market-terms";
import { retainMarketTerms, readRetainedMarketTerms } from "../../src/lib/solana/market-terms-store";
import { MAINNET_GENESIS_HASH } from "../../src/lib/solana/runtime";
import { loadPublicationManifest, parsePublicationRuntime, publicationStep, publicationComputeBudget, validatePublicationReceipt,
  readPublicationFile, writePublicationFile } from "./solana-publication";

const directories: string[] = [];
async function directory() { const dir = await mkdtemp(path.join(tmpdir(), "goosey-publication-unit-")); directories.push(dir); return dir; }
afterEach(async () => { for (const dir of directories.splice(0)) await rm(dir, { recursive: true, force: true }); });
const runtime = { cluster: "localnet", rpcUrl: "http://127.0.0.1:30100", programAddress: "CgEGAD3EGLm63YaSx58sRiNPQmmxg8RqvqcxE3xThX8Q", genesisHash: "Bax5P2GmYBb2P6UjJFmEVys7cpRzY4A85ncAJqtgvSsm" };
// Offline codec fixtures only. Never deployed or represented as actual market content.
async function fixture() {
  const programAddress = address(runtime.programAddress), wallet = (n: number) => getAddressDecoder().decode(new Uint8Array(32).fill(n));
  const market = await deriveGooseySeatAddresses({ programAddress, marketId: 7n, wallet: wallet(1) });
  const reviewer = async (n: number) => ({ wallet: wallet(n), enrollment: (await deriveGooseySeatAddresses({ programAddress, marketId: 7n, wallet: wallet(n) })).enrollment });
  const manifest: MarketTerms = { version: 1, binding: { cluster: "localnet", genesisHash: runtime.genesisHash, program: programAddress,
    config: market.config, market: market.market, marketId: "7", creator: wallet(1), featherMint: market.featherMint },
    question: "Offline publication codec fixture only?", rules: { yes: "Test YES criterion.", no: "Test NO criterion.", void: "Test VOID criterion." },
    observation: { startsAt: "100", endsAt: "200", timezone: "UTC" },
    sources: [{ id: "test", uri: "https://example.invalid/test", selection: "Offline test only, not an actual source.", snapshotSha256: null }],
    sourcePolicy: { priority: "array-order-first-authoritative", missing: "Test missing rule.", revisions: "Test revision rule." },
    economics: { payoutMilli: "1000", feeBps: "100", closesAt: "150", resolvesAt: "220", decimals: 3 },
    oracle: { kind: "two-reviewer-no-fallback-v1", proposer: await reviewer(2), approver: await reviewer(3), unavailable: "wait-for-designated-reviewers", replacement: "none", automaticVoid: false } };
  return { manifest, bytes: encodeMarketTerms(manifest) };
}
describe("publication exact manifest/runtime and durable files", () => {
  it("validates canonical manifest/PDA roles against explicit non-mainnet runtime", async () => {
    const f = await fixture(), config = parsePublicationRuntime(runtime);
    expect((await loadPublicationManifest(f.bytes, config)).manifest).toEqual(f.manifest);
    await expect(loadPublicationManifest(Buffer.from(JSON.stringify(f.manifest, null, 2)), config)).rejects.toThrow();
    await expect(loadPublicationManifest(f.bytes, { ...config, genesisHash: getAddressDecoder().decode(new Uint8Array(32).fill(9)) })).rejects.toThrow();
    await expect(loadPublicationManifest(encodeMarketTerms({ ...f.manifest, binding: { ...f.manifest.binding, marketId: "8" } }), config)).rejects.toThrow();
  });
  it("rejects missing/extra runtime fields and forbidden cluster/network", () => {
    for (const value of [{ ...runtime, genesisHash: undefined }, { ...runtime, extra: true }, { ...runtime, genesisHash: MAINNET_GENESIS_HASH }, { ...runtime, cluster: "mainnet" }]) {
      expect(() => parsePublicationRuntime(value)).toThrow();
    }
  });
  it("retains exact serving bytes idempotently and rejects conflicting manifest", async () => {
    const dir = await directory(), f = await fixture(), p = await loadPublicationManifest(f.bytes, parsePublicationRuntime(runtime));
    const expected = { digest: p.digest, manifestLength: p.bytes.length, binding: p.manifest.binding, economics: p.manifest.economics,
      proposer: p.manifest.oracle.proposer, approver: p.manifest.oracle.approver };
    expect((await retainMarketTerms(dir, p.bytes, expected)).created).toBe(true);
    expect((await retainMarketTerms(dir, p.bytes, expected)).created).toBe(false);
    expect((await readRetainedMarketTerms(dir, expected)).bytes).toEqual(p.bytes);
    const changed = await loadPublicationManifest(encodeMarketTerms({ ...f.manifest, question: "Different offline fixture question?" }), parsePublicationRuntime(runtime));
    await expect(retainMarketTerms(dir, changed.bytes, { ...expected, digest: changed.digest, manifestLength: changed.bytes.length })).rejects.toThrow(/Different immutable terms/);
  });
  it("exclusive private persistence refuses overwrite, symlinks and broad permissions", async () => {
    const dir = await directory(); await writePublicationFile(dir, "receipt.json", "private-test-receipt");
    expect((await stat(path.join(dir, "receipt.json"))).mode & 0o777).toBe(0o600);
    await expect(writePublicationFile(dir, "receipt.json", "replacement")).rejects.toThrow();
    expect((await readPublicationFile(path.join(dir, "receipt.json"))).toString()).toBe("private-test-receipt");
    await symlink(path.join(dir, "receipt.json"), path.join(dir, "alias"));
    await expect(readPublicationFile(path.join(dir, "alias"))).rejects.toThrow();
    await chmod(path.join(dir, "receipt.json"), 0o644);
    await expect(readPublicationFile(path.join(dir, "receipt.json"))).rejects.toThrow();
    await expect(writePublicationFile(dir, "../escape", "bad")).rejects.toThrow();
  });
});

describe("publication step orchestration (mock callbacks, not chain proof)", () => {
  function setup() {
    const receipt = { signature: "test-signature" }, sequence: string[] = [];
    return { sequence, receipt, input: {
      complete: vi.fn<() => Promise<boolean>>().mockResolvedValueOnce(false).mockResolvedValue(true),
      load: vi.fn(async (): Promise<typeof receipt | null> => null),
      prepare: vi.fn(async () => { sequence.push("sign"); return receipt; }),
      persist: vi.fn(async () => { sequence.push("durable"); }),
      send: vi.fn(async () => { sequence.push("send"); }), confirm: vi.fn(async () => { sequence.push("finalized"); return true; }),
    } };
  }
  it("persists signed bytes before any send and rechecks finalized state", async () => {
    const s = setup(); expect(await publicationStep(s.input)).toBe("finalized");
    expect(s.sequence).toEqual(["sign", "durable", "send", "finalized"]); expect(s.input.complete).toHaveBeenCalledTimes(2);
  });
  it("does not send when durable persistence fails", async () => {
    const s = setup(); s.input.persist.mockRejectedValue(new Error("fsync failure"));
    await expect(publicationStep(s.input)).rejects.toThrow("fsync"); expect(s.input.send).not.toHaveBeenCalled();
  });
  it("reconciles a committed transaction after ambiguous transport", async () => {
    const s = setup(); s.input.send.mockRejectedValue(new Error("transport"));
    expect(await publicationStep(s.input)).toBe("finalized"); expect(s.input.prepare).toHaveBeenCalledTimes(1);
  });
  it("on restart only tracks retained signature, never sends or re-signs", async () => {
    const s = setup(); s.input.load.mockResolvedValue(s.receipt);
    expect(await publicationStep(s.input)).toBe("finalized");
    expect(s.input.prepare).not.toHaveBeenCalled(); expect(s.input.send).not.toHaveBeenCalled(); expect(s.input.confirm).toHaveBeenCalledWith(s.receipt);
  });
  it("unknown or failed retained receipt cannot generate replacement", async () => {
    const s = setup(); s.input.load.mockResolvedValue(s.receipt); s.input.confirm.mockResolvedValue(false);
    await expect(publicationStep(s.input)).rejects.toThrow("unresolved"); expect(s.input.prepare).not.toHaveBeenCalled(); expect(s.input.send).not.toHaveBeenCalled();
  });
  it("exact finalized completion skips all signing and receipt replay", async () => {
    const s = setup(); s.input.complete.mockReset().mockResolvedValue(true);
    expect(await publicationStep(s.input)).toBe("already-finalized"); expect(s.input.load).not.toHaveBeenCalled(); expect(s.input.prepare).not.toHaveBeenCalled();
  });
  it("confirmation alone cannot claim publication success", async () => {
    const s = setup(); s.input.complete.mockReset().mockResolvedValue(false);
    await expect(publicationStep(s.input)).rejects.toThrow("does not establish");
  });
  it("receipt is actually retained when subsequent send fails", async () => {
    const dir = await directory(), s = setup();
    s.input.persist.mockImplementation(async () => writePublicationFile(dir, "step.json", JSON.stringify(s.receipt)));
    s.input.send.mockRejectedValue(new Error("offline")); s.input.confirm.mockResolvedValue(false);
    await expect(publicationStep(s.input)).rejects.toThrow();
    expect(JSON.parse(await readFile(path.join(dir, "step.json"), "utf8"))).toEqual(s.receipt);
  });
});

describe("publication receipt recovery (real offline Ed25519 signatures, no RPC)", () => {
  async function signedFixture(multi = false) {
    const payer = await generateKeyPairSigner(), seats = await generateKeyPairSigner(), config = parsePublicationRuntime(runtime);
    const create = await buildCreateMarketInstructions({ programAddress: config.programAddress, marketId: 7n, admin: payer, seats,
      seatsRentLamports: 123456n, payoutMilli: 1000n, feeBps: 100, closesAt: 150n, resolvesAt: 220n });
    const setup = await buildBookSetupInstruction({ programAddress: config.programAddress, marketId: 7n, admin: payer, step: { kind: "create" } });
    const instructions = [publicationComputeBudget(), ...(multi ? create.instructions : [setup.instruction])];
    const message = pipe(createTransactionMessage({ version: 0 }), m => setTransactionMessageFeePayerSigner(payer, m),
      m => setTransactionMessageLifetimeUsingBlockhash({ blockhash: blockhash(config.genesisHash), lastValidBlockHeight: 100n }, m),
      m => appendTransactionMessageInstructions(instructions, m));
    const tx = await signTransactionMessageWithSigners(message);
    const expected = { step: multi ? "market" : "book-create", digest: "a".repeat(64), runtime: config, payer, instructions };
    const receipt = { step: expected.step, digest: expected.digest, genesisHash: config.genesisHash,
      signature: getSignatureFromTransaction(tx), signedWireBase64: getBase64EncodedWireTransaction(tx), lastValidBlockHeight: "100" };
    return { receipt, expected, seats };
  }
  it.each([false, true])("authenticates exact shipping ABI and all signers (multiple=%s)", async multi => {
    const f = await signedFixture(multi); await expect(validatePublicationReceipt(f.receipt, f.expected)).resolves.toEqual(f.receipt);
  });
  it("rejects authentic signed bytes for a different expected ABI", async () => {
    const f = await signedFixture();
    const wrong = await buildBookSetupInstruction({ programAddress: f.expected.runtime.programAddress, marketId: 8n, admin: f.expected.payer, step: { kind: "create" } });
    await expect(validatePublicationReceipt(f.receipt, { ...f.expected, instructions: [publicationComputeBudget(), wrong.instruction] })).rejects.toThrow(/ABI/);
  });
  it("rejects corrupted signatures, including the Seats co-signature", async () => {
    for (const multi of [false, true]) {
      const f = await signedFixture(multi), wire = Buffer.from(f.receipt.signedWireBase64, "base64");
      wire[multi ? 65 : 1] ^= 1;
      const decoded = getTransactionDecoder().decode(wire);
      await expect(validatePublicationReceipt({ ...f.receipt, signature: getSignatureFromTransaction(decoded), signedWireBase64: wire.toString("base64") }, f.expected)).rejects.toThrow();
    }
  });
  it("rejects trailing/noncanonical wire, wrong receipt domain and unbounded lifetime", async () => {
    const f = await signedFixture();
    for (const patch of [{ signedWireBase64: f.receipt.signedWireBase64 + "\n" },
      { signedWireBase64: Buffer.concat([Buffer.from(f.receipt.signedWireBase64, "base64"), Buffer.alloc(1)]).toString("base64") },
      { genesisHash: MAINNET_GENESIS_HASH }, { digest: "b".repeat(64) }, { step: "terms-seal" },
      { lastValidBlockHeight: "18446744073709551616" }, { lastValidBlockHeight: "01" }]) {
      await expect(validatePublicationReceipt({ ...f.receipt, ...patch }, f.expected)).rejects.toThrow();
    }
  });
});
