import { address, createKeyPairSignerFromBytes, type TransactionPartialSigner } from "@solana/kit";

export class SolanaMarketAuthorityConfigurationError extends Error {
  constructor(message = "The Solana market authority is not configured.") {
    super(message);
    this.name = "SolanaMarketAuthorityConfigurationError";
  }
}

/** Loads the server-only authority configured as the Goosey program admin. */
export async function loadSolanaMarketAuthoritySigner(
  env: Record<string, string | undefined> = process.env,
): Promise<TransactionPartialSigner> {
  const expected = env.GOOSEY_SOLANA_MARKET_AUTHORITY_ADDRESS;
  const encoded = env.GOOSEY_SOLANA_MARKET_AUTHORITY_SECRET_KEY;
  if (!expected || !encoded || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded) || encoded.length > 128) {
    throw new SolanaMarketAuthorityConfigurationError();
  }
  const expectedAddress = address(expected);
  const secret = Buffer.from(encoded, "base64");
  if (secret.length !== 64 || secret.toString("base64") !== encoded) {
    secret.fill(0);
    throw new SolanaMarketAuthorityConfigurationError("The Solana market authority secret is invalid.");
  }
  try {
    const signer = await createKeyPairSignerFromBytes(secret);
    if (signer.address !== expectedAddress) {
      throw new SolanaMarketAuthorityConfigurationError("The Solana market authority address does not match its secret.");
    }
    return signer;
  } finally {
    secret.fill(0);
  }
}
