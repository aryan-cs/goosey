PRAGMA foreign_keys=ON;

CREATE TABLE "SolanaProvisioningCheckpoint" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "userId" TEXT NOT NULL,
  "chainId" TEXT NOT NULL,
  "genesisHash" TEXT NOT NULL,
  "revision" INTEGER NOT NULL DEFAULT 0,
  "checkpointJson" TEXT NOT NULL,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" DATETIME NOT NULL,
  CONSTRAINT "SolanaProvisioningCheckpoint_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CHECK ("chainId" IN ('solana:localnet','solana:devnet')),
  CHECK ("revision" >= 0),
  CHECK (length("checkpointJson") BETWEEN 2 AND 20000)
);

CREATE UNIQUE INDEX "SolanaProvisioningCheckpoint_scope_key"
  ON "SolanaProvisioningCheckpoint"("userId", "chainId", "genesisHash");
CREATE INDEX "SolanaProvisioningCheckpoint_user_idx" ON "SolanaProvisioningCheckpoint"("userId");

CREATE TRIGGER "SolanaProvisioningCheckpoint_cas_guard"
BEFORE UPDATE ON "SolanaProvisioningCheckpoint"
FOR EACH ROW BEGIN
  SELECT CASE WHEN NEW."id" <> OLD."id" OR NEW."userId" <> OLD."userId"
    OR NEW."chainId" <> OLD."chainId" OR NEW."genesisHash" <> OLD."genesisHash"
    OR NEW."createdAt" <> OLD."createdAt"
    THEN RAISE(ABORT, 'SolanaProvisioningCheckpoint scope is immutable') END;
  SELECT CASE WHEN NEW."revision" <> OLD."revision" + 1
    THEN RAISE(ABORT, 'SolanaProvisioningCheckpoint revision must increment exactly once') END;
END;
