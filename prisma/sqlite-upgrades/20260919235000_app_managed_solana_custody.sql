PRAGMA foreign_keys=ON;

CREATE TABLE "SolanaCustodyIdentity" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "userId" TEXT NOT NULL,
  "chainId" TEXT NOT NULL CHECK ("chainId" IN ('solana:localnet', 'solana:devnet')),
  "genesisHash" TEXT NOT NULL,
  "walletAddress" TEXT NOT NULL,
  "encryptionAlgorithm" TEXT NOT NULL DEFAULT 'AES-256-GCM' CHECK ("encryptionAlgorithm" = 'AES-256-GCM'),
  "keyVersion" INTEGER NOT NULL DEFAULT 1 CHECK ("keyVersion" = 1),
  "keyId" TEXT NOT NULL CHECK (length("keyId") BETWEEN 1 AND 64),
  "encryptedSecretKey" TEXT NOT NULL CHECK (length("encryptedSecretKey") = 86),
  "encryptionNonce" TEXT NOT NULL CHECK (length("encryptionNonce") = 16),
  "encryptionAuthTag" TEXT NOT NULL CHECK (length("encryptionAuthTag") = 22),
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" DATETIME NOT NULL,
  CONSTRAINT "SolanaCustodyIdentity_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "SolanaCustody_user_domain_key" ON "SolanaCustodyIdentity"("userId", "chainId", "genesisHash");
CREATE UNIQUE INDEX "SolanaCustody_domain_wallet_key" ON "SolanaCustodyIdentity"("chainId", "genesisHash", "walletAddress");
CREATE INDEX "SolanaCustodyIdentity_userId_idx" ON "SolanaCustodyIdentity"("userId");
