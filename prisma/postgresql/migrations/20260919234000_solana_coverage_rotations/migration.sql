-- Durable, append-only evidence for an explicitly confirmed localnet coverage rotation.
CREATE TABLE "SolanaCoverageRotation" (
    "id" TEXT NOT NULL,
    "genesisHash" TEXT NOT NULL,
    "programAddress" TEXT NOT NULL,
    "previousCoverageStartSignature" TEXT NOT NULL,
    "previousCommittedHeadSignature" TEXT,
    "previousScanHeadSignature" TEXT,
    "previousScanBeforeSignature" TEXT,
    "previousBackfillComplete" BOOLEAN NOT NULL,
    "previousRevision" INTEGER NOT NULL,
    "previousCursorCreatedAt" TIMESTAMPTZ(3) NOT NULL,
    "previousCursorUpdatedAt" TIMESTAMPTZ(3) NOT NULL,
    "previousCursorSha256" TEXT NOT NULL,
    "newCoverageStartSignature" TEXT NOT NULL,
    "newBoundarySlot" BIGINT NOT NULL,
    "newBoundaryConfigurationSlot" BIGINT NOT NULL,
    "newBoundaryEventKey" TEXT NOT NULL,
    "newBoundaryWalletAddress" TEXT NOT NULL,
    "newBoundaryEnrollmentAddress" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SolanaCoverageRotation_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "SolanaRotation_domain_created_idx"
ON "SolanaCoverageRotation"("genesisHash", "programAddress", "createdAt");

CREATE UNIQUE INDEX "SolanaRotation_domain_revision_key"
ON "SolanaCoverageRotation"("genesisHash", "programAddress", "previousRevision");

CREATE FUNCTION "reject_solana_coverage_rotation_mutation"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'SolanaCoverageRotation is append-only';
END;
$$;

CREATE TRIGGER "SolanaCoverageRotation_no_update_or_delete"
BEFORE UPDATE OR DELETE ON "SolanaCoverageRotation"
FOR EACH ROW EXECUTE FUNCTION "reject_solana_coverage_rotation_mutation"();
