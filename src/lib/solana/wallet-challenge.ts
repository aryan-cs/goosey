import { createPublicKey, randomBytes, verify as verifyEd25519 } from "node:crypto";
import { address, getAddressEncoder, getBase58Decoder, getBase58Encoder, type Address } from "@solana/kit";
import { DEVNET_GENESIS_HASH, MAINNET_GENESIS_HASH, TESTNET_GENESIS_HASH } from "./runtime";

export const WALLET_CHALLENGE_MAX_LIFETIME_MS = 5 * 60 * 1_000;
export const WALLET_CHALLENGE_STATEMENT =
  "Link this Solana wallet to your Goosey account. This does not authorize a transaction.";

export type WalletChallengeChain = "solana:localnet" | "solana:devnet";

export type WalletChallengeContext = Readonly<{
  origin: string;
  chainId: WalletChallengeChain;
  genesisHash: string;
  walletAddress: string;
}>;

export type WalletChallenge = Readonly<{
  domain: string;
  uri: string;
  version: "1";
  chainId: WalletChallengeChain;
  genesisHash: string;
  walletAddress: Address;
  statement: typeof WALLET_CHALLENGE_STATEMENT;
  nonce: string;
  issuedAt: string;
  expirationTime: string;
  resources: readonly [string];
  message: string;
}>;

export type WalletChallengeVerification =
  | Readonly<{
      verified: true;
      walletAddress: Address;
      nonce: string;
      issuedAt: string;
      expirationTime: string;
      /** Signature verification is not replay protection. The caller must
       * atomically consume the persisted nonce while creating the wallet link. */
      nonceConsumptionRequired: true;
    }>
  | Readonly<{
      verified: false;
      reason:
        | "INVALID_CONTEXT"
        | "INVALID_CHALLENGE"
        | "NOT_YET_VALID"
        | "EXPIRED"
        | "MESSAGE_MISMATCH"
        | "INVALID_SIGNATURE_ENCODING"
        | "INVALID_SIGNATURE";
    }>;

const NONCE_PATTERN = /^[0-9a-f]{64}$/;
const MAX_SIGNED_MESSAGE_BYTES = 4_096;
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

function normalizeOrigin(raw: string): { origin: string; domain: string } {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > 2_048) {
    throw new Error("Wallet challenge origin must be a configured absolute HTTP(S) origin.");
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("Wallet challenge origin must be a configured absolute HTTP(S) origin.");
  }
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    (url.pathname !== "/" && url.pathname !== "") ||
    url.search ||
    url.hash
  ) {
    throw new Error("Wallet challenge origin must be a configured absolute HTTP(S) origin.");
  }
  return { origin: url.origin, domain: url.host };
}

function normalizeAddress(raw: string, label: string): Address {
  try {
    const value = address(raw);
    if (getAddressEncoder().encode(value).length !== 32) throw new Error("wrong length");
    return value;
  } catch {
    throw new Error(`${label} must be a valid 32-byte base58 Solana value.`);
  }
}

function normalizeGenesisHash(raw: string): string {
  try {
    if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(raw)) throw new Error("invalid characters");
    const bytes = getBase58Encoder().encode(raw);
    if (bytes.length !== 32 || getBase58Decoder().decode(bytes) !== raw) {
      throw new Error("invalid length");
    }
    return raw;
  } catch {
    throw new Error("Genesis hash must be a canonical base58 Solana genesis value.");
  }
}

function validateChain(chainId: string): asserts chainId is WalletChallengeChain {
  if (chainId !== "solana:localnet" && chainId !== "solana:devnet") {
    throw new Error("Wallet challenge chain must be solana:localnet or solana:devnet.");
  }
}

function genesisResource(genesisHash: string): string {
  return `urn:solana:genesis:${genesisHash}`;
}

function messageFor(challenge: Omit<WalletChallenge, "message">): string {
  return [
    `${challenge.domain} wants you to sign in with your Solana account:`,
    challenge.walletAddress,
    "",
    challenge.statement,
    "",
    `URI: ${challenge.uri}`,
    `Version: ${challenge.version}`,
    `Chain ID: ${challenge.chainId}`,
    `Nonce: ${challenge.nonce}`,
    `Issued At: ${challenge.issuedAt}`,
    `Expiration Time: ${challenge.expirationTime}`,
    "Resources:",
    ...challenge.resources.map((resource) => `- ${resource}`),
  ].join("\n");
}

function canonicalIsoDate(raw: string): number | null {
  const time = Date.parse(raw);
  if (!Number.isFinite(time) || new Date(time).toISOString() !== raw) return null;
  return time;
}

function decodeCanonicalBase64(raw: string, maxBytes: number): Uint8Array | null {
  if (
    typeof raw !== "string" ||
    raw.length === 0 ||
    raw.length % 4 !== 0 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(raw)
  ) {
    return null;
  }
  const decoded = Buffer.from(raw, "base64");
  if (decoded.length > maxBytes || decoded.toString("base64") !== raw) return null;
  return decoded;
}

function normalizeContext(context: WalletChallengeContext) {
  const { origin, domain } = normalizeOrigin(context.origin);
  validateChain(context.chainId);
  const walletAddress = normalizeAddress(context.walletAddress, "Wallet address");
  const genesisHash = normalizeGenesisHash(context.genesisHash);
  if (genesisHash === MAINNET_GENESIS_HASH || genesisHash === TESTNET_GENESIS_HASH || (context.chainId === "solana:devnet"
    ? genesisHash !== DEVNET_GENESIS_HASH : genesisHash === DEVNET_GENESIS_HASH)) {
    throw new Error("Genesis hash does not identify the selected non-mainnet chain.");
  }
  return { origin, domain, chainId: context.chainId, walletAddress, genesisHash } as const;
}

/** Creates a Wallet Standard SIWS text challenge. The actual genesis hash is
 * included as a signed resource because the Wallet Standard chain identifier
 * names a cluster but does not uniquely identify a local ledger. */
export function createWalletChallenge(
  input: WalletChallengeContext & { now?: Date; lifetimeMs?: number },
): WalletChallenge {
  const context = normalizeContext(input);
  const now = input.now ?? new Date();
  if (!Number.isFinite(now.getTime())) throw new Error("Wallet challenge issue time must be valid.");
  const lifetimeMs = input.lifetimeMs ?? WALLET_CHALLENGE_MAX_LIFETIME_MS;
  if (!Number.isSafeInteger(lifetimeMs) || lifetimeMs <= 0 || lifetimeMs > WALLET_CHALLENGE_MAX_LIFETIME_MS) {
    throw new Error("Wallet challenge lifetime must be between 1 ms and 5 minutes.");
  }
  const fields = {
    domain: context.domain,
    uri: context.origin,
    version: "1" as const,
    chainId: context.chainId,
    genesisHash: context.genesisHash,
    walletAddress: context.walletAddress,
    statement: WALLET_CHALLENGE_STATEMENT,
    nonce: randomBytes(32).toString("hex"),
    issuedAt: now.toISOString(),
    expirationTime: new Date(now.getTime() + lifetimeMs).toISOString(),
    resources: [genesisResource(context.genesisHash)],
  } as const;
  return Object.freeze({ ...fields, message: messageFor(fields) });
}

/** Verifies only the stored challenge's exact bytes and Ed25519 signature.
 * It neither authenticates a Goosey session nor consumes a nonce. A caller
 * must atomically consume the persisted, unexpired nonce when linking. */
export function verifyWalletChallenge(input: {
  challenge: WalletChallenge;
  context: WalletChallengeContext;
  signedMessageBase64: string;
  signatureBase64: string;
  now?: Date;
}): WalletChallengeVerification {
  let context: ReturnType<typeof normalizeContext>;
  try {
    context = normalizeContext(input.context);
  } catch {
    return { verified: false, reason: "INVALID_CONTEXT" };
  }

  const challenge = input.challenge;
  const { message: storedMessage, ...messageFields } = challenge;
  const issuedAt = canonicalIsoDate(challenge.issuedAt);
  const expirationTime = canonicalIsoDate(challenge.expirationTime);
  const expectedResource = genesisResource(context.genesisHash);
  let challengeWallet: Address;
  try {
    challengeWallet = normalizeAddress(challenge.walletAddress, "Wallet address");
    normalizeGenesisHash(challenge.genesisHash);
  } catch {
    return { verified: false, reason: "INVALID_CHALLENGE" };
  }

  if (
    challenge.domain !== context.domain ||
    challenge.uri !== context.origin ||
    challenge.chainId !== context.chainId ||
    challenge.walletAddress !== context.walletAddress ||
    challengeWallet !== context.walletAddress ||
    challenge.genesisHash !== context.genesisHash
  ) {
    return { verified: false, reason: "INVALID_CONTEXT" };
  }
  if (
    challenge.version !== "1" ||
    challenge.statement !== WALLET_CHALLENGE_STATEMENT ||
    !NONCE_PATTERN.test(challenge.nonce) ||
    issuedAt === null ||
    expirationTime === null ||
    expirationTime <= issuedAt ||
    expirationTime - issuedAt > WALLET_CHALLENGE_MAX_LIFETIME_MS ||
    challenge.resources.length !== 1 ||
    challenge.resources[0] !== expectedResource ||
    storedMessage !== messageFor(messageFields)
  ) {
    return { verified: false, reason: "INVALID_CHALLENGE" };
  }

  const now = (input.now ?? new Date()).getTime();
  if (!Number.isFinite(now)) return { verified: false, reason: "INVALID_CONTEXT" };
  if (issuedAt > now) return { verified: false, reason: "NOT_YET_VALID" };
  if (expirationTime <= now) return { verified: false, reason: "EXPIRED" };

  const signedMessage = decodeCanonicalBase64(input.signedMessageBase64, MAX_SIGNED_MESSAGE_BYTES);
  const expectedMessage = Buffer.from(storedMessage, "utf8");
  if (!signedMessage || signedMessage.length !== expectedMessage.length || !Buffer.from(signedMessage).equals(expectedMessage)) {
    return { verified: false, reason: "MESSAGE_MISMATCH" };
  }
  const signature = decodeCanonicalBase64(input.signatureBase64, 64);
  if (!signature || signature.length !== 64) {
    return { verified: false, reason: "INVALID_SIGNATURE_ENCODING" };
  }

  try {
    const rawPublicKey = getAddressEncoder().encode(challengeWallet);
    if (rawPublicKey.length !== 32) return { verified: false, reason: "INVALID_CHALLENGE" };
    const publicKey = createPublicKey({
      key: Buffer.concat([ED25519_SPKI_PREFIX, Buffer.from(rawPublicKey)]),
      format: "der",
      type: "spki",
    });
    if (!verifyEd25519(null, signedMessage, publicKey, signature)) {
      return { verified: false, reason: "INVALID_SIGNATURE" };
    }
  } catch {
    return { verified: false, reason: "INVALID_SIGNATURE" };
  }

  return {
    verified: true,
    walletAddress: challengeWallet,
    nonce: challenge.nonce,
    issuedAt: challenge.issuedAt,
    expirationTime: challenge.expirationTime,
    nonceConsumptionRequired: true,
  };
}
