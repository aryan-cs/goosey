CREATE TABLE "SolanaChainMutationLane" (
  "id" TEXT NOT NULL,
  "genesisHash" TEXT NOT NULL,
  "programAddress" TEXT NOT NULL,
  "walletAddress" TEXT NOT NULL,
  "chainMarketId" TEXT NOT NULL,
  "revision" INTEGER NOT NULL DEFAULT 0,
  "leaseOwner" TEXT,
  "leaseTokenHash" TEXT,
  "leaseEpoch" INTEGER NOT NULL DEFAULT 0,
  "leaseExpiresAt" TIMESTAMPTZ(3),
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "SolanaChainMutationLane_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "SolanaMutationLane_identity_check" CHECK (
    char_length("genesisHash") BETWEEN 32 AND 44
    AND char_length("programAddress") BETWEEN 32 AND 44
    AND char_length("walletAddress") BETWEEN 32 AND 44
    AND "chainMarketId" ~ '^(0|[1-9][0-9]{0,19})$'
    AND (char_length("chainMarketId") < 20 OR "chainMarketId" <= '18446744073709551615')
  ),
  CONSTRAINT "SolanaMutationLane_revision_check" CHECK ("revision" BETWEEN 0 AND 2147483647),
  CONSTRAINT "SolanaMutationLane_epoch_check" CHECK ("leaseEpoch" BETWEEN 0 AND 2147483647),
  CONSTRAINT "SolanaMutationLane_lease_check" CHECK (
    ("leaseOwner" IS NULL AND "leaseTokenHash" IS NULL AND "leaseExpiresAt" IS NULL)
    OR (char_length("leaseOwner") BETWEEN 1 AND 191 AND "leaseTokenHash" ~ '^[0-9a-f]{64}$'
      AND "leaseExpiresAt" IS NOT NULL AND "leaseEpoch" > 0)
  )
);

CREATE UNIQUE INDEX "SolanaMutationLane_identity_key"
ON "SolanaChainMutationLane"("genesisHash", "programAddress", "walletAddress", "chainMarketId");
CREATE INDEX "SolanaMutationLane_expiry_idx" ON "SolanaChainMutationLane"("leaseExpiresAt");

CREATE FUNCTION "SolanaMutationLane_guard_update"() RETURNS trigger AS $$
BEGIN
  IF NEW."id" <> OLD."id" OR NEW."genesisHash" <> OLD."genesisHash"
    OR NEW."programAddress" <> OLD."programAddress" OR NEW."walletAddress" <> OLD."walletAddress"
    OR NEW."chainMarketId" <> OLD."chainMarketId" OR NEW."createdAt" <> OLD."createdAt" THEN
    RAISE EXCEPTION 'Solana mutation lane identity is immutable';
  END IF;
  IF NEW."revision" <> OLD."revision" + 1 THEN
    RAISE EXCEPTION 'Solana mutation lane revision must increment exactly once';
  END IF;
  IF NEW."leaseOwner" IS NOT NULL
    AND (OLD."leaseOwner" IS NULL OR NEW."leaseOwner" IS DISTINCT FROM OLD."leaseOwner"
      OR NEW."leaseTokenHash" IS DISTINCT FROM OLD."leaseTokenHash") THEN
    IF NEW."leaseEpoch" <> OLD."leaseEpoch" + 1 THEN
      RAISE EXCEPTION 'Solana mutation lane acquisition must advance its epoch';
    END IF;
  ELSIF NEW."leaseEpoch" <> OLD."leaseEpoch" THEN
    RAISE EXCEPTION 'Solana mutation lane epoch changed without acquisition';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "SolanaMutationLane_cas_guard"
BEFORE UPDATE ON "SolanaChainMutationLane"
FOR EACH ROW EXECUTE FUNCTION "SolanaMutationLane_guard_update"();
