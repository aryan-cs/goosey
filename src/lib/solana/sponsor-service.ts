import { address, createKeyPairSignerFromBytes, type TransactionPartialSigner } from "@solana/kit";

export class SolanaSponsorConfigurationError extends Error {
  constructor(message = "The Solana transaction sponsor is not configured.") {
    super(message);
    this.name = "SolanaSponsorConfigurationError";
  }
}

function canonicalSecret(value: string | undefined): Uint8Array {
  if (!value || !/^[A-Za-z0-9+/]+={0,2}$/.test(value) || value.length > 128) {
    throw new SolanaSponsorConfigurationError();
  }
  const bytes = Buffer.from(value, "base64");
  if (bytes.length !== 64 || bytes.toString("base64") !== value) {
    bytes.fill(0);
    throw new SolanaSponsorConfigurationError("The Solana sponsor secret is invalid.");
  }
  return bytes;
}

/** Loads the server-only fee sponsor used for invisible localnet/devnet fees.
 * Never return this signer from a route or serialize it into a command. */
export async function loadSolanaSponsorSigner(
  env: Record<string, string | undefined> = process.env,
): Promise<TransactionPartialSigner> {
  const expected = env.GOOSEY_SOLANA_SPONSOR_ADDRESS;
  if (!expected) throw new SolanaSponsorConfigurationError();
  const expectedAddress = address(expected);
  const secret = canonicalSecret(env.GOOSEY_SOLANA_SPONSOR_SECRET_KEY);
  try {
    const signer = await createKeyPairSignerFromBytes(secret);
    if (signer.address !== expectedAddress) {
      throw new SolanaSponsorConfigurationError("The Solana sponsor address does not match its secret.");
    }
    return signer;
  } finally {
    secret.fill(0);
  }
}

/** Loads the distinct authority that authorizes free feather enrollment. */
export async function loadSolanaEnrollmentAuthoritySigner(
  env: Record<string, string | undefined> = process.env,
): Promise<TransactionPartialSigner> {
  const expected = env.GOOSEY_SOLANA_ENROLLMENT_AUTHORITY_ADDRESS;
  if (!expected) throw new SolanaSponsorConfigurationError("The Solana enrollment authority is not configured.");
  const expectedAddress = address(expected);
  const secret = canonicalSecret(env.GOOSEY_SOLANA_ENROLLMENT_AUTHORITY_SECRET_KEY);
  try {
    const signer = await createKeyPairSignerFromBytes(secret);
    if (signer.address !== expectedAddress) {
      throw new SolanaSponsorConfigurationError("The Solana enrollment authority address does not match its secret.");
    }
    return signer;
  } finally {
    secret.fill(0);
  }
}
