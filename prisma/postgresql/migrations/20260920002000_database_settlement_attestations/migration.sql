CREATE TABLE "MarketSettlementAttestation" (
  "id" TEXT NOT NULL,
  "settlementRunId" TEXT NOT NULL,
  "commandId" TEXT NOT NULL,
  "digest" TEXT NOT NULL,
  "marketDigest" TEXT NOT NULL,
  "signature" TEXT,
  "slot" BIGINT,
  "attestedAt" TIMESTAMPTZ(3),
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "MarketSettlementAttestation_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "MarketSettlementAttestation_digest_check" CHECK ("digest" ~ '^[a-f0-9]{64}$'),
  CONSTRAINT "MarketSettlementAttestation_market_digest_check" CHECK ("marketDigest" ~ '^[a-f0-9]{64}$'),
  CONSTRAINT "MarketSettlementAttestation_receipt_check" CHECK (
    ("signature" IS NULL AND "slot" IS NULL AND "attestedAt" IS NULL)
    OR ("signature" IS NOT NULL AND "slot" IS NOT NULL AND "slot" >= 0 AND "attestedAt" IS NOT NULL)
  )
);

CREATE UNIQUE INDEX "MarketSettlementAttestation_settlementRunId_key"
  ON "MarketSettlementAttestation"("settlementRunId");
CREATE UNIQUE INDEX "MarketSettlementAttestation_commandId_key"
  ON "MarketSettlementAttestation"("commandId");
CREATE UNIQUE INDEX "MarketSettlementAttestation_signature_key"
  ON "MarketSettlementAttestation"("signature");
CREATE INDEX "MarketSettlementAttestation_attestedAt_createdAt_idx"
  ON "MarketSettlementAttestation"("attestedAt", "createdAt");

ALTER TABLE "MarketSettlementAttestation" ADD CONSTRAINT "MarketSettlementAttestation_settlementRunId_fkey"
  FOREIGN KEY ("settlementRunId") REFERENCES "MarketSettlementRun"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "MarketSettlementAttestation" ADD CONSTRAINT "MarketSettlementAttestation_commandId_fkey"
  FOREIGN KEY ("commandId") REFERENCES "ChainCommand"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE FUNCTION "MarketSettlementAttestation_deny_identity_mutation"() RETURNS trigger AS $$
BEGIN
  IF NEW."settlementRunId" <> OLD."settlementRunId"
    OR NEW."commandId" <> OLD."commandId"
    OR NEW."digest" <> OLD."digest"
    OR NEW."marketDigest" <> OLD."marketDigest" THEN
    RAISE EXCEPTION 'MarketSettlementAttestation identity is immutable';
  END IF;
  IF OLD."attestedAt" IS NOT NULL AND (
    NEW."signature" IS DISTINCT FROM OLD."signature"
    OR NEW."slot" IS DISTINCT FROM OLD."slot"
    OR NEW."attestedAt" IS DISTINCT FROM OLD."attestedAt"
  ) THEN
    RAISE EXCEPTION 'MarketSettlementAttestation finalized receipt is immutable';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "MarketSettlementAttestation_immutable"
BEFORE UPDATE ON "MarketSettlementAttestation" FOR EACH ROW
EXECUTE FUNCTION "MarketSettlementAttestation_deny_identity_mutation"();
