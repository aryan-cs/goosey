-- Durable, append-only evidence for an explicitly confirmed localnet coverage rotation.
CREATE TABLE "SolanaCoverageRotation" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "genesisHash" TEXT NOT NULL,
    "programAddress" TEXT NOT NULL,
    "previousCoverageStartSignature" TEXT NOT NULL,
    "previousCommittedHeadSignature" TEXT,
    "previousScanHeadSignature" TEXT,
    "previousScanBeforeSignature" TEXT,
    "previousBackfillComplete" BOOLEAN NOT NULL,
    "previousRevision" INTEGER NOT NULL,
    "previousCursorCreatedAt" DATETIME NOT NULL,
    "previousCursorUpdatedAt" DATETIME NOT NULL,
    "previousCursorSha256" TEXT NOT NULL,
    "newCoverageStartSignature" TEXT NOT NULL,
    "newBoundarySlot" BIGINT NOT NULL,
    "newBoundaryConfigurationSlot" BIGINT NOT NULL,
    "newBoundaryEventKey" TEXT NOT NULL,
    "newBoundaryWalletAddress" TEXT NOT NULL,
    "newBoundaryEnrollmentAddress" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX "SolanaRotation_domain_created_idx"
ON "SolanaCoverageRotation"("genesisHash", "programAddress", "createdAt");

CREATE UNIQUE INDEX "SolanaRotation_domain_revision_key"
ON "SolanaCoverageRotation"("genesisHash", "programAddress", "previousRevision");

CREATE TRIGGER "SolanaCoverageRotation_no_update"
BEFORE UPDATE ON "SolanaCoverageRotation"
BEGIN
  SELECT RAISE(ABORT, 'SolanaCoverageRotation is append-only');
END;

CREATE TRIGGER "SolanaCoverageRotation_no_delete"
BEFORE DELETE ON "SolanaCoverageRotation"
BEGIN
  SELECT RAISE(ABORT, 'SolanaCoverageRotation is append-only');
END;
