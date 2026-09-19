import { generateKeyPairSync, sign } from "node:crypto";
import { getAddressDecoder } from "@solana/kit";
import { describe, expect, it } from "vitest";
import {
  createWalletChallenge,
  verifyWalletChallenge,
  WALLET_CHALLENGE_MAX_LIFETIME_MS,
  type WalletChallenge,
  type WalletChallengeContext,
} from "./wallet-challenge";

const NOW = new Date("2026-09-19T15:00:00.000Z");
import { DEVNET_GENESIS_HASH as GENESIS, MAINNET_GENESIS_HASH, TESTNET_GENESIS_HASH } from "./runtime";

function wallet() {
  const pair = generateKeyPairSync("ed25519");
  const spki = pair.publicKey.export({ format: "der", type: "spki" });
  const rawPublicKey = new Uint8Array(spki.subarray(spki.length - 32));
  return {
    address: getAddressDecoder().decode(rawPublicKey),
    sign(message: string) {
      return sign(null, Buffer.from(message, "utf8"), pair.privateKey).toString("base64");
    },
  };
}

function signedFixture(overrides: Partial<WalletChallengeContext> = {}) {
  const signer = wallet();
  const context: WalletChallengeContext = {
    origin: "https://goosey.example:8443",
    chainId: "solana:devnet",
    genesisHash: GENESIS,
    walletAddress: signer.address,
    ...overrides,
  };
  const challenge = createWalletChallenge({ ...context, now: NOW });
  return {
    signer,
    context,
    challenge,
    signedMessageBase64: Buffer.from(challenge.message, "utf8").toString("base64"),
    signatureBase64: signer.sign(challenge.message),
  };
}

function verify(fixture: ReturnType<typeof signedFixture>, overrides: Partial<Parameters<typeof verifyWalletChallenge>[0]> = {}) {
  return verifyWalletChallenge({
    challenge: fixture.challenge,
    context: fixture.context,
    signedMessageBase64: fixture.signedMessageBase64,
    signatureBase64: fixture.signatureBase64,
    now: new Date(NOW.getTime() + 1_000),
    ...overrides,
  });
}

describe("SIWS-style wallet-link challenge creation", () => {
  it("binds canonical domain, URI, Wallet Standard chain, genesis and exact wallet bytes", () => {
    const fixture = signedFixture();
    expect(fixture.challenge).toMatchObject({
      domain: "goosey.example:8443",
      uri: "https://goosey.example:8443",
      chainId: "solana:devnet",
      genesisHash: GENESIS,
      walletAddress: fixture.signer.address,
      version: "1",
      issuedAt: NOW.toISOString(),
      expirationTime: new Date(NOW.getTime() + WALLET_CHALLENGE_MAX_LIFETIME_MS).toISOString(),
      resources: [`urn:solana:genesis:${GENESIS}`],
    });
    expect(fixture.challenge.nonce).toMatch(/^[0-9a-f]{64}$/);
    expect(Buffer.from(fixture.challenge.nonce, "hex")).toHaveLength(32);
    expect(fixture.challenge.message).toContain(`Nonce: ${fixture.challenge.nonce}`);
    expect(fixture.challenge.message.endsWith("\n")).toBe(false);
  });

  it("rejects malformed configuration and lifetimes beyond five minutes", () => {
    const signer = wallet();
    const base = { origin: "https://goosey.example", chainId: "solana:devnet" as const, genesisHash: GENESIS, walletAddress: signer.address, now: NOW };
    expect(() => createWalletChallenge({ ...base, origin: "https://goosey.example/path" })).toThrow("origin");
    expect(() => createWalletChallenge({ ...base, walletAddress: "not-a-wallet" })).toThrow("Wallet address");
    expect(() => createWalletChallenge({ ...base, genesisHash: "not-a-genesis" })).toThrow("Genesis hash");
    for (const genesisHash of [GENESIS.slice(0, 32), MAINNET_GENESIS_HASH.slice(0, 32), MAINNET_GENESIS_HASH, TESTNET_GENESIS_HASH]) {
      for (const chainId of ["solana:devnet", "solana:localnet"] as const) {
        expect(() => createWalletChallenge({ ...base, chainId, genesisHash })).toThrow("Genesis hash");
      }
    }
    expect(() => createWalletChallenge({ ...base, lifetimeMs: WALLET_CHALLENGE_MAX_LIFETIME_MS + 1 })).toThrow("5 minutes");
  });
});

describe("exact-byte Ed25519 wallet challenge verification", () => {
  it("verifies a valid signature but explicitly requires atomic nonce consumption", () => {
    const fixture = signedFixture();
    expect(verify(fixture)).toEqual({
      verified: true,
      walletAddress: fixture.signer.address,
      nonce: fixture.challenge.nonce,
      issuedAt: fixture.challenge.issuedAt,
      expirationTime: fixture.challenge.expirationTime,
      nonceConsumptionRequired: true,
    });
  });

  it("rejects a different expected wallet and a signature made by another wallet", () => {
    const fixture = signedFixture();
    const other = wallet();
    expect(verify(fixture, { context: { ...fixture.context, walletAddress: other.address } })).toMatchObject({ verified: false });
    expect(verify(fixture, { signatureBase64: other.sign(fixture.challenge.message) })).toEqual({ verified: false, reason: "INVALID_SIGNATURE" });
  });

  it("rejects wrong configured origin or chain/genesis context", () => {
    const fixture = signedFixture();
    expect(verify(fixture, { context: { ...fixture.context, origin: "https://evil.example" } })).toEqual({ verified: false, reason: "INVALID_CONTEXT" });
    expect(verify(fixture, { context: { ...fixture.context, chainId: "solana:localnet" } })).toEqual({ verified: false, reason: "INVALID_CONTEXT" });
    expect(verify(fixture, { context: { ...fixture.context, genesisHash: "11111111111111111111111111111111" } })).toEqual({ verified: false, reason: "INVALID_CONTEXT" });
  });

  it("rejects expired and not-yet-issued challenges", () => {
    const fixture = signedFixture();
    expect(verify(fixture, { now: new Date(fixture.challenge.expirationTime) })).toEqual({ verified: false, reason: "EXPIRED" });
    expect(verify(fixture, { now: new Date(NOW.getTime() - 1) })).toEqual({ verified: false, reason: "NOT_YET_VALID" });
  });

  it("rejects changed nonce, message, and chain bytes even when the wallet signs them", () => {
    const fixture = signedFixture();
    const cases = [
      fixture.challenge.message.replace(fixture.challenge.nonce, "0".repeat(64)),
      `${fixture.challenge.message}.`,
      fixture.challenge.message.replace("Chain ID: solana:devnet", "Chain ID: solana:localnet"),
    ];
    for (const message of cases) {
      expect(verify(fixture, {
        signedMessageBase64: Buffer.from(message, "utf8").toString("base64"),
        signatureBase64: fixture.signer.sign(message),
      })).toEqual({ verified: false, reason: "MESSAGE_MISMATCH" });
    }
  });

  it("rejects a challenge whose stored canonical fields and message diverge", () => {
    const fixture = signedFixture();
    const challenge = { ...fixture.challenge, nonce: "0".repeat(64) } as WalletChallenge;
    expect(verify(fixture, { challenge })).toEqual({ verified: false, reason: "INVALID_CHALLENGE" });
  });

  it.each([
    ["not base64", "not base64"],
    ["63 bytes", Buffer.alloc(63).toString("base64")],
    ["65 bytes", Buffer.alloc(65).toString("base64")],
    ["non-canonical whitespace", `${Buffer.alloc(64).toString("base64")}\n`],
  ])("rejects %s instead of accepting lenient base64", (_label, signatureBase64) => {
    const fixture = signedFixture();
    expect(verify(fixture, { signatureBase64 })).toEqual({ verified: false, reason: "INVALID_SIGNATURE_ENCODING" });
  });
});
