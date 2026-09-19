-- Retained ingestion-window membership only; no financial relations or writes.
CREATE TABLE "SolanaIngestionVisit" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "genesisHash" TEXT NOT NULL,
    "programAddress" TEXT NOT NULL,
    "scanHeadSignature" TEXT NOT NULL,
    "signature" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX "SolanaVisit_domain_scan_signature_key" ON "SolanaIngestionVisit"("genesisHash", "programAddress", "scanHeadSignature", "signature");
