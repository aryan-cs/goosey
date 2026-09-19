import { address, getBase58Decoder } from "@solana/kit";
import { describe, expect, it } from "vitest";

import {
  acceptChainCommand,
  assertChainCommandReplay,
  canonicalChainCommandJson,
  ChainCommandValidationError,
  createSignedWireJournal,
} from "@/lib/solana/chain-command";
import type { SolanaRuntime } from "@/lib/solana/runtime";

const toBase58 = (bytes: Uint8Array) => getBase58Decoder().decode(bytes);
const feePayer = toBase58(new Uint8Array(32).fill(3));
const blockhash = toBase58(new Uint8Array(32).fill(4));
const transactionSignature = toBase58(new Uint8Array(64).fill(5));
const runtime: SolanaRuntime = {
  cluster: "localnet",
  rpcUrl: "http://127.0.0.1:20999/",
  genesisHash: "11111111111111111111111111111111",
  programAddress: address("BPFLoaderUpgradeab1e11111111111111111111111"),
};

function signedWire() {
  const bytes = Buffer.concat([
    Buffer.from([1]),
    Buffer.from(new Uint8Array(64).fill(5)),
    Buffer.from([1, 0, 0]),
    Buffer.from([1]),
    Buffer.from(new Uint8Array(32).fill(3)),
    Buffer.from(new Uint8Array(32).fill(4)),
    Buffer.from([0]),
  ]);
  return bytes.toString("base64");
}

function command(overrides: Record<string, unknown> = {}) {
  return acceptChainCommand({
    runtime,
    scope: "USER",
    scopeId: "user_12345678",
    actorId: "user_12345678",
    operation: "PLACE_ORDER",
    idempotencyKey: "request_12345678",
    request: { quantity: "2", market: "market_12345678", nested: { z: false, a: 1 } },
    ...overrides,
  });
}

describe("chain command acceptance", () => {
  it("produces canonical recursively sorted JSON and a stable scoped request hash", () => {
    const first = command();
    const second = command({ request: { nested: { a: 1, z: false }, market: "market_12345678", quantity: "2" } });
    expect(second).toEqual(first);
    expect(first.requestJson).toBe('{"operation":"PLACE_ORDER","request":{"market":"market_12345678","nested":{"a":1,"z":false},"quantity":"2"},"version":1}');
    expect(first.requestHash).toMatch(/^[a-f0-9]{64}$/);
    expect(() => assertChainCommandReplay(first, second)).not.toThrow();
  });

  it("detects idempotency replays that alter request or immutable deployment identity", () => {
    const first = command();
    expect(() => assertChainCommandReplay(first, command({ request: { quantity: "3" } })))
      .toThrow(/requestHash|requestJson/);
    expect(() => assertChainCommandReplay(first, { ...first, genesisHash: toBase58(new Uint8Array(32).fill(7)) }))
      .toThrow(/genesisHash/);
  });

  it("rejects ambiguous or lossy JSON rather than hashing it", () => {
    expect(() => canonicalChainCommandJson({ value: undefined })).toThrow(ChainCommandValidationError);
    expect(() => canonicalChainCommandJson({ value: 1.5 })).toThrow(/safe integers/);
    expect(() => canonicalChainCommandJson({ value: BigInt(1) })).toThrow(/canonical JSON/);
    expect(() => canonicalChainCommandJson({ value: "e\u0301" })).toThrow(/non-NFC/);
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => canonicalChainCommandJson(cyclic)).toThrow(/cycle/);
  });
});

describe("exact signed-wire journal", () => {
  const input = () => ({
    commandId: "command_12345678",
    sequence: 0,
    leaseEpoch: 1,
    commandRevision: 2,
    signedWireBase64: signedWire(),
    transactionSignature,
    recentBlockhash: blockhash,
    lastValidBlockHeight: 55n,
    durableNonceAddress: null,
    feePayerAddress: feePayer,
    signerAddresses: [feePayer],
  });

  it("derives bounded metadata from the exact signed transaction", () => {
    const result = createSignedWireJournal(input());
    expect(result).toMatchObject({
      wireVersion: "legacy",
      signedWireByteLength: 134,
      transactionSignature,
      recentBlockhash: blockhash,
      feePayerAddress: feePayer,
      signerAddressesJson: JSON.stringify([feePayer]),
    });
    expect(result.signedWireSha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it("rejects metadata that is not proven by the exact wire bytes", () => {
    expect(() => createSignedWireJournal({ ...input(), transactionSignature: toBase58(new Uint8Array(64).fill(6)) }))
      .toThrow(/signature/);
    expect(() => createSignedWireJournal({ ...input(), recentBlockhash: toBase58(new Uint8Array(32).fill(6)) }))
      .toThrow(/blockhash/);
    expect(() => createSignedWireJournal({ ...input(), feePayerAddress: blockhash, signerAddresses: [blockhash] }))
      .toThrow(/payer or signer/);
    expect(() => createSignedWireJournal({ ...input(), signedWireBase64: `${signedWire()}\n` }))
      .toThrow(/canonical bounded base64/);
  });

  it("requires exactly one bounded transaction lifetime strategy", () => {
    expect(() => createSignedWireJournal({ ...input(), lastValidBlockHeight: null })).toThrow(/Exactly one/);
    expect(() => createSignedWireJournal({ ...input(), durableNonceAddress: feePayer })).toThrow(/Exactly one/);
    expect(() => createSignedWireJournal({ ...input(), lastValidBlockHeight: 9_223_372_036_854_775_808n }))
      .toThrow(/out of range/);
  });
});
