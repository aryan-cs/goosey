CREATE TABLE "SolanaCustodyIdentity" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "chainId" TEXT NOT NULL,
    "genesisHash" TEXT NOT NULL,
    "walletAddress" TEXT NOT NULL,
    "encryptionAlgorithm" TEXT NOT NULL DEFAULT 'AES-256-GCM',
    "keyVersion" INTEGER NOT NULL DEFAULT 1,
    "keyId" TEXT NOT NULL,
    "encryptedSecretKey" TEXT NOT NULL,
    "encryptionNonce" TEXT NOT NULL,
    "encryptionAuthTag" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) WITH TIME ZONE NOT NULL,

    CONSTRAINT "SolanaCustodyIdentity_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "SolanaCustodyIdentity_chain_check" CHECK ("chainId" IN ('solana:localnet', 'solana:devnet')),
    CONSTRAINT "SolanaCustodyIdentity_algorithm_check" CHECK ("encryptionAlgorithm" = 'AES-256-GCM'),
    CONSTRAINT "SolanaCustodyIdentity_version_check" CHECK ("keyVersion" = 1),
    CONSTRAINT "SolanaCustodyIdentity_key_id_check" CHECK (char_length("keyId") BETWEEN 1 AND 64),
    CONSTRAINT "SolanaCustodyIdentity_ciphertext_check" CHECK (char_length("encryptedSecretKey") = 86),
    CONSTRAINT "SolanaCustodyIdentity_nonce_check" CHECK (char_length("encryptionNonce") = 16),
    CONSTRAINT "SolanaCustodyIdentity_tag_check" CHECK (char_length("encryptionAuthTag") = 22)
);

CREATE UNIQUE INDEX "SolanaCustody_user_domain_key" ON "SolanaCustodyIdentity"("userId", "chainId", "genesisHash");
CREATE UNIQUE INDEX "SolanaCustody_domain_wallet_key" ON "SolanaCustodyIdentity"("chainId", "genesisHash", "walletAddress");
CREATE INDEX "SolanaCustodyIdentity_userId_idx" ON "SolanaCustodyIdentity"("userId");

ALTER TABLE "SolanaCustodyIdentity" ADD CONSTRAINT "SolanaCustodyIdentity_userId_fkey"
FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
