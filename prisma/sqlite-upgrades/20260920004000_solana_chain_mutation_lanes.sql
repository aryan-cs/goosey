PRAGMA foreign_keys=ON;

CREATE TABLE "SolanaChainMutationLane" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "genesisHash" TEXT NOT NULL CHECK (length("genesisHash") BETWEEN 32 AND 44),
  "programAddress" TEXT NOT NULL CHECK (length("programAddress") BETWEEN 32 AND 44),
  "walletAddress" TEXT NOT NULL CHECK (length("walletAddress") BETWEEN 32 AND 44),
  "chainMarketId" TEXT NOT NULL CHECK (
    length("chainMarketId") BETWEEN 1 AND 20
    AND "chainMarketId" NOT GLOB '*[^0-9]*'
    AND (length("chainMarketId") = 1 OR substr("chainMarketId", 1, 1) <> '0')
    AND (length("chainMarketId") < 20 OR "chainMarketId" <= '18446744073709551615')
  ),
  "revision" INTEGER NOT NULL DEFAULT 0 CHECK ("revision" BETWEEN 0 AND 2147483647),
  "leaseOwner" TEXT CHECK ("leaseOwner" IS NULL OR length("leaseOwner") BETWEEN 1 AND 191),
  "leaseTokenHash" TEXT CHECK (
    "leaseTokenHash" IS NULL OR (length("leaseTokenHash") = 64 AND "leaseTokenHash" NOT GLOB '*[^0-9a-f]*')
  ),
  "leaseEpoch" INTEGER NOT NULL DEFAULT 0 CHECK ("leaseEpoch" BETWEEN 0 AND 2147483647),
  "leaseExpiresAt" DATETIME,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" DATETIME NOT NULL,
  CHECK (("leaseOwner" IS NULL AND "leaseTokenHash" IS NULL AND "leaseExpiresAt" IS NULL)
    OR ("leaseOwner" IS NOT NULL AND "leaseTokenHash" IS NOT NULL AND "leaseExpiresAt" IS NOT NULL AND "leaseEpoch" > 0))
);

CREATE UNIQUE INDEX "SolanaMutationLane_identity_key"
ON "SolanaChainMutationLane"("genesisHash", "programAddress", "walletAddress", "chainMarketId");
CREATE INDEX "SolanaMutationLane_expiry_idx" ON "SolanaChainMutationLane"("leaseExpiresAt");

CREATE TRIGGER "SolanaMutationLane_cas_guard"
BEFORE UPDATE ON "SolanaChainMutationLane"
FOR EACH ROW BEGIN
  SELECT CASE WHEN NEW."id" <> OLD."id" OR NEW."genesisHash" <> OLD."genesisHash"
    OR NEW."programAddress" <> OLD."programAddress" OR NEW."walletAddress" <> OLD."walletAddress"
    OR NEW."chainMarketId" <> OLD."chainMarketId" OR NEW."createdAt" <> OLD."createdAt"
    THEN RAISE(ABORT, 'Solana mutation lane identity is immutable') END;
  SELECT CASE WHEN NEW."revision" <> OLD."revision" + 1
    THEN RAISE(ABORT, 'Solana mutation lane revision must increment exactly once') END;
  SELECT CASE WHEN NEW."leaseOwner" IS NOT NULL
      AND (OLD."leaseOwner" IS NULL OR NEW."leaseOwner" IS NOT OLD."leaseOwner"
        OR NEW."leaseTokenHash" IS NOT OLD."leaseTokenHash")
      AND NEW."leaseEpoch" <> OLD."leaseEpoch" + 1
    THEN RAISE(ABORT, 'Solana mutation lane acquisition must advance its epoch') END;
  SELECT CASE WHEN NOT (NEW."leaseOwner" IS NOT NULL
      AND (OLD."leaseOwner" IS NULL OR NEW."leaseOwner" IS NOT OLD."leaseOwner"
        OR NEW."leaseTokenHash" IS NOT OLD."leaseTokenHash"))
      AND NEW."leaseEpoch" <> OLD."leaseEpoch"
    THEN RAISE(ABORT, 'Solana mutation lane epoch changed without acquisition') END;
END;
