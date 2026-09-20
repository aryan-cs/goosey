CREATE TABLE "MarketSettlementAttestation" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "settlementRunId" TEXT NOT NULL,
  "commandId" TEXT NOT NULL,
  "digest" TEXT NOT NULL CHECK (length("digest") = 64 AND "digest" NOT GLOB '*[^a-f0-9]*'),
  "marketDigest" TEXT NOT NULL CHECK (length("marketDigest") = 64 AND "marketDigest" NOT GLOB '*[^a-f0-9]*'),
  "signature" TEXT,
  "slot" BIGINT,
  "attestedAt" DATETIME,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" DATETIME NOT NULL,
  CONSTRAINT "MarketSettlementAttestation_receipt_check" CHECK (
    ("signature" IS NULL AND "slot" IS NULL AND "attestedAt" IS NULL)
    OR ("signature" IS NOT NULL AND "slot" IS NOT NULL AND "slot" >= 0 AND "attestedAt" IS NOT NULL)
  ),
  CONSTRAINT "MarketSettlementAttestation_settlementRunId_fkey" FOREIGN KEY ("settlementRunId") REFERENCES "MarketSettlementRun" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "MarketSettlementAttestation_commandId_fkey" FOREIGN KEY ("commandId") REFERENCES "ChainCommand" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "MarketSettlementAttestation_settlementRunId_key" ON "MarketSettlementAttestation"("settlementRunId");
CREATE UNIQUE INDEX "MarketSettlementAttestation_commandId_key" ON "MarketSettlementAttestation"("commandId");
CREATE UNIQUE INDEX "MarketSettlementAttestation_signature_key" ON "MarketSettlementAttestation"("signature");
CREATE INDEX "MarketSettlementAttestation_attestedAt_createdAt_idx" ON "MarketSettlementAttestation"("attestedAt", "createdAt");

CREATE TRIGGER "MarketSettlementAttestation_identity_immutable"
BEFORE UPDATE ON "MarketSettlementAttestation"
WHEN NEW."settlementRunId" <> OLD."settlementRunId"
  OR NEW."commandId" <> OLD."commandId"
  OR NEW."digest" <> OLD."digest"
  OR NEW."marketDigest" <> OLD."marketDigest"
BEGIN SELECT RAISE(ABORT, 'MarketSettlementAttestation identity is immutable'); END;

CREATE TRIGGER "MarketSettlementAttestation_receipt_immutable"
BEFORE UPDATE ON "MarketSettlementAttestation"
WHEN OLD."attestedAt" IS NOT NULL AND (
  NEW."signature" IS NOT OLD."signature"
  OR NEW."slot" IS NOT OLD."slot"
  OR NEW."attestedAt" IS NOT OLD."attestedAt"
)
BEGIN SELECT RAISE(ABORT, 'MarketSettlementAttestation finalized receipt is immutable'); END;
