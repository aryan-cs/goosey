import { address, createKeyPairSignerFromBytes, type KeyPairSigner } from "@solana/kit";

export class SettlementAttestationAuthorityConfigurationError extends Error {
  constructor(message = "The Solana settlement attestation authority is not configured.") {
    super(message);
    this.name = "SettlementAttestationAuthorityConfigurationError";
  }
}

/** Loads the dedicated server-only signer for database settlement receipts.
 * It is deliberately separate from user custody, enrollment, sponsor, admin,
 * reviewer, and program-upgrade authorities. */
export async function loadSettlementAttestationAuthority(
  env: Record<string, string | undefined> = process.env,
): Promise<KeyPairSigner> {
  const expectedText = env.GOOSEY_SOLANA_SETTLEMENT_ATTESTATION_AUTHORITY_ADDRESS;
  const secretText = env.GOOSEY_SOLANA_SETTLEMENT_ATTESTATION_AUTHORITY_SECRET_KEY;
  if (!expectedText || !secretText || !/^[A-Za-z0-9+/]+={0,2}$/.test(secretText) || secretText.length > 128) {
    throw new SettlementAttestationAuthorityConfigurationError();
  }
  const expected = address(expectedText);
  const secret = Buffer.from(secretText, "base64");
  if (secret.length !== 64 || secret.toString("base64") !== secretText) {
    secret.fill(0);
    throw new SettlementAttestationAuthorityConfigurationError("The Solana settlement attestation authority secret is invalid.");
  }
  try {
    const signer = await createKeyPairSignerFromBytes(secret);
    if (signer.address !== expected) {
      throw new SettlementAttestationAuthorityConfigurationError("The Solana settlement attestation authority address does not match its secret.");
    }
    return signer;
  } finally {
    secret.fill(0);
  }
}
