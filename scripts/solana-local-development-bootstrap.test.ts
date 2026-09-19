import { execFileSync } from "node:child_process";
import { getTransferSolInstruction } from "@solana-program/system";
import { address, appendTransactionMessageInstruction, blockhash, createTransactionMessage, generateKeyPairSigner,
  getBase64EncodedWireTransaction, getSignatureFromTransaction, pipe, setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash, signTransactionMessageWithSigners } from "@solana/kit";
import { describe, expect, it } from "vitest";
import { decodeMarketTerms, hashMarketTerms } from "../src/lib/solana/market-terms";
import {
  buildLocalBootstrapTerms, deriveLocalBootstrapMarketId, localBootstrapHelp, localBootstrapSlug,
  localBootstrapIndexingMode, parseLocalBootstrapArguments, validateLocalBootstrapReceipt, validateLocalBootstrapState,
} from "./solana-local-development-bootstrap";

const operator = "/private/tmp/goosey-retained-localnet";
const stateDirectory = "/private/tmp/goosey-local-market-bootstrap";
const termsDirectory = "/private/tmp/goosey-local-market-terms";
const args = ["run", "--operator-directory", operator, "--state", stateDirectory,
  "--terms-directory", termsDirectory, "--actor-user-id", "local_admin"];
const genesisHash = "Bax5P2GmYBb2P6UjJFmEVys7cpRzY4A85ncAJqtgvSsm";
const programAddress = "CgEGAD3EGLm63YaSx58sRiNPQmmxg8RqvqcxE3xThX8Q";
const creator = "Vote111111111111111111111111111111111111111";
const rawState = {
  version: 1, genesisHash, programAddress, marketId: deriveLocalBootstrapMarketId(genesisHash).toString(),
  createdAt: "1789750000", closesAt: "1821286000", resolvesAt: "1821890800", allowance: "100000",
  proposer: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
  approver: "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL",
  participant: "SysvarC1ock11111111111111111111111111111111",
} as const;
const unsafeArguments: readonly (readonly string[])[] = [
  args.slice(0, -1),
  [...args, "--state", "/private/tmp/other"],
  ["run", "--operator-directory", "relative", "--state", stateDirectory, "--terms-directory", termsDirectory, "--actor-user-id", "local_admin"],
  ["run", "--operator-directory", operator, "--state", `${operator}/nested`, "--terms-directory", termsDirectory, "--actor-user-id", "local_admin"],
  ["run", "--operator-directory", operator, "--state", stateDirectory, "--terms-directory", stateDirectory, "--actor-user-id", "local_admin"],
  ["run", "--operator-directory", operator, "--state", stateDirectory, "--terms-directory", termsDirectory, "--actor-user-id", "bad actor"],
  ["run", "--operator-directory", operator, "--state", stateDirectory, "--terms-directory", termsDirectory, "--rpc", "https://api.mainnet-beta.solana.com"],
];

describe("retained-localnet development market bootstrap", () => {
  it("requires an explicit run target, private state, serving terms store and catalog actor", () => {
    expect(parseLocalBootstrapArguments(args)).toEqual({ mode: "run", operatorDirectory: operator,
      stateDirectory, termsDirectory, actorUserId: "local_admin" });
    expect(parseLocalBootstrapArguments(["--help"])).toEqual({ mode: "help" });
  });

  it.each(unsafeArguments.map(value => [value] as const))("rejects ambiguous/unsafe arguments %# before any operator work", value => {
    expect(() => parseLocalBootstrapArguments(value)).toThrow();
  });

  it("derives one stable nonzero u64 identity and deployment-specific catalog slug", () => {
    const id = deriveLocalBootstrapMarketId(genesisHash);
    expect(id).toBeGreaterThan(0n); expect(id).toBeLessThanOrEqual((1n << 64n) - 1n);
    expect(deriveLocalBootstrapMarketId(genesisHash)).toBe(id);
    expect(deriveLocalBootstrapMarketId("AjRRXmyGBFhUtVWWp5xYXYKAP4Ha8vyTDRNVrkTVA2DE")).not.toBe(id);
    expect(localBootstrapSlug(genesisHash)).toMatch(/^goosey-htn-localnet-first-match-[0-9a-f]{10}$/);
  });

  it("strictly validates the immutable resumability record", () => {
    expect(validateLocalBootstrapState(rawState)).toEqual(rawState);
    for (const patch of [
      { version: 2 }, { marketId: "01" }, { allowance: "0" }, { closesAt: rawState.createdAt },
      { proposer: rawState.approver }, { extra: "not allowed" },
    ]) expect(() => validateLocalBootstrapState({ ...rawState, ...patch })).toThrow();
  });

  it("constructs canonical UW/HTN terms bound to exact localnet identities and independent reviewers", async () => {
    const state = validateLocalBootstrapState(rawState);
    const bytes = await buildLocalBootstrapTerms({ runtime: { cluster: "localnet", rpcUrl: "http://127.0.0.1:20999/",
      genesisHash, programAddress: address(programAddress) }, state, creator });
    const terms = decodeMarketTerms(bytes);
    expect(terms.question).toContain("Hack the North");
    expect(terms.question).toContain("matched on-chain trade");
    expect(terms.binding).toMatchObject({ cluster: "localnet", genesisHash, program: programAddress,
      marketId: rawState.marketId, creator });
    expect(terms.oracle.proposer.wallet).toBe(rawState.proposer);
    expect(terms.oracle.approver.wallet).toBe(rawState.approver);
    expect(terms.oracle.proposer.enrollment).not.toBe(terms.oracle.approver.enrollment);
    expect(terms.sources[0].uri).toBe("https://github.com/aryan-cs/goosey/tree/master/chain/programs/goosey-exchange");
    expect(terms.economics).toMatchObject({ payoutMilli: "1000", feeBps: "100", closesAt: rawState.closesAt,
      resolvesAt: rawState.resolvesAt, decimals: 3 });
    expect(await hashMarketTerms(bytes)).toMatch(/^[0-9a-f]{64}$/);
    expect(await buildLocalBootstrapTerms({ runtime: { cluster: "localnet", rpcUrl: "http://127.0.0.1:20999/",
      genesisHash, programAddress: address(programAddress) }, state, creator })).toEqual(bytes);
  });

  it("cryptographically validates exact retained transaction intent and rejects mutation", async () => {
    const payer = await generateKeyPairSigner(), destination = await generateKeyPairSigner();
    const instruction = getTransferSolInstruction({ source: payer, destination: destination.address, amount: 123n });
    const lifetime = { blockhash: blockhash(genesisHash), lastValidBlockHeight: 456n };
    const message = pipe(createTransactionMessage({ version: 0 }), m => setTransactionMessageFeePayerSigner(payer, m),
      m => setTransactionMessageLifetimeUsingBlockhash(lifetime, m), m => appendTransactionMessageInstruction(instruction, m));
    const signed = await signTransactionMessageWithSigners(message);
    const receipt = { version: 1 as const, kind: "unit-intent", genesisHash, signer: payer.address,
      signature: getSignatureFromTransaction(signed), blockhash: lifetime.blockhash,
      lastValidBlockHeight: lifetime.lastValidBlockHeight.toString(), signedWireBase64: getBase64EncodedWireTransaction(signed) };
    const input = { kind: receipt.kind, runtime: { cluster: "localnet" as const, rpcUrl: "http://127.0.0.1:20999/",
      genesisHash, programAddress: address(programAddress) }, payer, instructions: [instruction] };
    expect((await validateLocalBootstrapReceipt(receipt, input)).receipt.signature).toBe(receipt.signature);
    await expect(validateLocalBootstrapReceipt({ ...receipt, kind: "other" }, input)).rejects.toThrow();
    const changed = getTransferSolInstruction({ source: payer, destination: destination.address, amount: 124n });
    await expect(validateLocalBootstrapReceipt(receipt, { ...input, instructions: [changed] })).rejects.toThrow("intent");
    const wire = Buffer.from(receipt.signedWireBase64, "base64"); wire[64] ^= 1;
    await expect(validateLocalBootstrapReceipt({ ...receipt, signedWireBase64: wire.toString("base64") }, input)).rejects.toThrow();
  });

  it("offers no public-cluster, reset, faucet, key-printing or fabricated-ledger option", () => {
    expect(localBootstrapHelp).toContain("never starts, resets or replaces");
    expect(localBootstrapHelp).toContain("no SQL balance, order, fill or position");
    expect(localBootstrapHelp).not.toMatch(/--cluster|--rpc|--reset|--airdrop|--faucet|--print-key/i);
  });

  it("never replaces an existing deployment coverage boundary", () => {
    const boundary = "3f7BW6hDJUdTKLXyQV97haeoQsYVaK3jru7RLVEA4Kwm1QwJ1F97YxfoCdMNxQYDvCDUrUWAk6VSgBPnbi3mmcFn";
    expect(localBootstrapIndexingMode(null, boundary)).toBe("index-bootstrap-boundary");
    expect(localBootstrapIndexingMode({ coverageStartSignature: boundary }, boundary)).toBe("index-bootstrap-boundary");
    expect(localBootstrapIndexingMode({ coverageStartSignature: `${boundary.slice(0, -1)}m` }, boundary))
      .toBe("retain-existing-boundary");
  });

  it("entrypoint help performs no RPC, database or filesystem mutation", () => {
    const output = execFileSync(process.execPath, ["--import", "tsx", "scripts/solana-local-development-bootstrap.ts", "--help"],
      { cwd: process.cwd(), encoding: "utf8", timeout: 15_000,
        env: { PATH: process.env.PATH, NODE_ENV: "test", DATABASE_URL: "", DATABASE_PROVIDER: "" } });
    expect(output).toContain("127.0.0.1:20999"); expect(output).toContain("Rerun the exact command");
  });
});
