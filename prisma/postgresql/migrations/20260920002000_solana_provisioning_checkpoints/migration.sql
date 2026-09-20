CREATE TABLE "SolanaProvisioningCheckpoint" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "chainId" TEXT NOT NULL,
  "genesisHash" TEXT NOT NULL,
  "revision" INTEGER NOT NULL DEFAULT 0,
  "checkpointJson" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "SolanaProvisioningCheckpoint_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "SolanaProvisioningCheckpoint_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "SolanaProvisioningCheckpoint_chain_check" CHECK ("chainId" IN ('solana:localnet','solana:devnet')),
  CONSTRAINT "SolanaProvisioningCheckpoint_revision_check" CHECK ("revision" >= 0),
  CONSTRAINT "SolanaProvisioningCheckpoint_json_size_check" CHECK (octet_length("checkpointJson") BETWEEN 2 AND 20000)
);

CREATE UNIQUE INDEX "SolanaProvisioningCheckpoint_scope_key"
  ON "SolanaProvisioningCheckpoint"("userId", "chainId", "genesisHash");
CREATE INDEX "SolanaProvisioningCheckpoint_user_idx" ON "SolanaProvisioningCheckpoint"("userId");

CREATE OR REPLACE FUNCTION "guard_solana_provisioning_checkpoint_update"() RETURNS trigger AS $$
BEGIN
  IF NEW."id" <> OLD."id" OR NEW."userId" <> OLD."userId"
    OR NEW."chainId" <> OLD."chainId" OR NEW."genesisHash" <> OLD."genesisHash"
    OR NEW."createdAt" <> OLD."createdAt" THEN
    RAISE EXCEPTION 'SolanaProvisioningCheckpoint scope is immutable';
  END IF;
  IF NEW."revision" <> OLD."revision" + 1 THEN
    RAISE EXCEPTION 'SolanaProvisioningCheckpoint revision must increment exactly once';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "SolanaProvisioningCheckpoint_cas_guard"
BEFORE UPDATE ON "SolanaProvisioningCheckpoint"
FOR EACH ROW EXECUTE FUNCTION "guard_solana_provisioning_checkpoint_update"();
