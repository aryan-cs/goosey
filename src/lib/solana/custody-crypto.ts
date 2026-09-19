import {
  createCipheriv,
  createDecipheriv,
  generateKeyPairSync,
  randomBytes,
} from "node:crypto";

import { address, getAddressDecoder, getAddressEncoder, type Address } from "@solana/kit";

const ALGORITHM = "AES-256-GCM" as const;
const KEY_VERSION = 1 as const;
const SECRET_KEY_BYTES = 64;
const NONCE_BYTES = 12;
const AUTH_TAG_BYTES = 16;
const KEY_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;

export type CustodyEncryptionConfiguration = Readonly<{
  key: Buffer;
  keyId: string;
}>;

export type CustodyKeyContext = Readonly<{
  userId: string;
  chainId: "solana:localnet" | "solana:devnet";
  genesisHash: string;
  walletAddress: string;
}>;

export type SealedCustodyKey = Readonly<{
  encryptionAlgorithm: typeof ALGORITHM;
  keyVersion: typeof KEY_VERSION;
  keyId: string;
  encryptedSecretKey: string;
  encryptionNonce: string;
  encryptionAuthTag: string;
}>;

export class CustodyEncryptionConfigurationError extends Error {
  constructor() {
    super("App-managed Solana custody encryption is not configured correctly.");
    this.name = "CustodyEncryptionConfigurationError";
  }
}

export class CustodyKeyDecryptionError extends Error {
  constructor() {
    super("The app-managed Solana identity could not be opened safely.");
    this.name = "CustodyKeyDecryptionError";
  }
}

function decodeCanonicalBase64Url(value: string, expectedBytes: number): Buffer {
  if (!BASE64URL_PATTERN.test(value)) throw new CustodyKeyDecryptionError();
  const decoded = Buffer.from(value, "base64url");
  if (decoded.length !== expectedBytes || decoded.toString("base64url") !== value) {
    decoded.fill(0);
    throw new CustodyKeyDecryptionError();
  }
  return decoded;
}

function validateContext(context: CustodyKeyContext): void {
  if (!context.userId || context.userId.length > 191) throw new CustodyKeyDecryptionError();
  if (context.chainId !== "solana:localnet" && context.chainId !== "solana:devnet") {
    throw new CustodyKeyDecryptionError();
  }
  try {
    address(context.genesisHash);
    address(context.walletAddress);
  } catch {
    throw new CustodyKeyDecryptionError();
  }
}

function additionalAuthenticatedData(context: CustodyKeyContext, keyId: string): Buffer {
  validateContext(context);
  return Buffer.from(
    ["goosey-solana-custody", String(KEY_VERSION), keyId, context.userId, context.chainId, context.genesisHash, context.walletAddress].join("\0"),
    "utf8",
  );
}

export function resolveCustodyEncryptionConfiguration(
  env: Record<string, string | undefined> = process.env,
): CustodyEncryptionConfiguration {
  const encoded = env.GOOSEY_SOLANA_CUSTODY_ENCRYPTION_KEY;
  const keyId = env.GOOSEY_SOLANA_CUSTODY_KEY_ID;
  if (!encoded || !keyId || !KEY_ID_PATTERN.test(keyId) || !BASE64URL_PATTERN.test(encoded)) {
    throw new CustodyEncryptionConfigurationError();
  }
  const key = Buffer.from(encoded, "base64url");
  if (key.length !== 32 || key.toString("base64url") !== encoded) {
    key.fill(0);
    throw new CustodyEncryptionConfigurationError();
  }
  return { key, keyId };
}

export function generateSolanaSecretKey(): { walletAddress: Address; secretKey: Buffer } {
  const { privateKey } = generateKeyPairSync("ed25519");
  const jwk = privateKey.export({ format: "jwk" });
  if (!jwk.d || !jwk.x) throw new Error("Ed25519 key generation failed.");
  const privateBytes = Buffer.from(jwk.d, "base64url");
  const publicBytes = Buffer.from(jwk.x, "base64url");
  delete jwk.d;
  if (privateBytes.length !== 32 || publicBytes.length !== 32) {
    privateBytes.fill(0);
    publicBytes.fill(0);
    throw new Error("Ed25519 key generation returned an invalid key.");
  }
  const walletAddress = getAddressDecoder().decode(publicBytes);
  const secretKey = Buffer.concat([privateBytes, publicBytes]);
  privateBytes.fill(0);
  publicBytes.fill(0);
  return { walletAddress, secretKey };
}

export function sealCustodySecretKey(
  secretKey: Uint8Array,
  context: CustodyKeyContext,
  configuration: CustodyEncryptionConfiguration,
): SealedCustodyKey {
  if (secretKey.length !== SECRET_KEY_BYTES || configuration.key.length !== 32 || !KEY_ID_PATTERN.test(configuration.keyId)) {
    throw new CustodyEncryptionConfigurationError();
  }
  const expectedPublicKey = getAddressEncoder().encode(address(context.walletAddress));
  if (!Buffer.from(secretKey.subarray(32)).equals(Buffer.from(expectedPublicKey))) {
    throw new CustodyKeyDecryptionError();
  }
  const nonce = randomBytes(NONCE_BYTES);
  const aad = additionalAuthenticatedData(context, configuration.keyId);
  try {
    const cipher = createCipheriv("aes-256-gcm", configuration.key, nonce, { authTagLength: AUTH_TAG_BYTES });
    cipher.setAAD(aad);
    const ciphertext = Buffer.concat([cipher.update(secretKey), cipher.final()]);
    const authTag = cipher.getAuthTag();
    try {
      return {
        encryptionAlgorithm: ALGORITHM,
        keyVersion: KEY_VERSION,
        keyId: configuration.keyId,
        encryptedSecretKey: ciphertext.toString("base64url"),
        encryptionNonce: nonce.toString("base64url"),
        encryptionAuthTag: authTag.toString("base64url"),
      };
    } finally {
      ciphertext.fill(0);
      authTag.fill(0);
    }
  } finally {
    nonce.fill(0);
    aad.fill(0);
  }
}

export function openCustodySecretKey(
  sealed: SealedCustodyKey,
  context: CustodyKeyContext,
  configuration: CustodyEncryptionConfiguration,
): Buffer {
  if (
    sealed.encryptionAlgorithm !== ALGORITHM ||
    sealed.keyVersion !== KEY_VERSION ||
    sealed.keyId !== configuration.keyId ||
    configuration.key.length !== 32
  ) {
    throw new CustodyKeyDecryptionError();
  }
  const ciphertext = decodeCanonicalBase64Url(sealed.encryptedSecretKey, SECRET_KEY_BYTES);
  const nonce = decodeCanonicalBase64Url(sealed.encryptionNonce, NONCE_BYTES);
  const authTag = decodeCanonicalBase64Url(sealed.encryptionAuthTag, AUTH_TAG_BYTES);
  const aad = additionalAuthenticatedData(context, sealed.keyId);
  try {
    const decipher = createDecipheriv("aes-256-gcm", configuration.key, nonce, { authTagLength: AUTH_TAG_BYTES });
    decipher.setAAD(aad);
    decipher.setAuthTag(authTag);
    const secretKey = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    const expectedPublicKey = getAddressEncoder().encode(address(context.walletAddress));
    if (secretKey.length !== SECRET_KEY_BYTES || !secretKey.subarray(32).equals(Buffer.from(expectedPublicKey))) {
      secretKey.fill(0);
      throw new CustodyKeyDecryptionError();
    }
    return secretKey;
  } catch (error) {
    if (error instanceof CustodyKeyDecryptionError) throw error;
    throw new CustodyKeyDecryptionError();
  } finally {
    ciphertext.fill(0);
    nonce.fill(0);
    authTag.fill(0);
    aad.fill(0);
  }
}

