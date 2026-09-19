-- Slots/configurationSlot must be validated by the writer as bigint in [0, 9223372036854775807].
-- Payload bigint values remain decimal strings; status and append-only replay semantics are application validated.
-- CreateTable
CREATE TABLE "SolanaIngestionCursor" (
    "id" TEXT NOT NULL,
    "genesisHash" TEXT NOT NULL,
    "programAddress" TEXT NOT NULL,
    "committedHeadSignature" TEXT,
    "scanHeadSignature" TEXT,
    "scanBeforeSignature" TEXT,
    "coverageStartSignature" TEXT NOT NULL,
    "backfillComplete" BOOLEAN NOT NULL DEFAULT false,
    "revision" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "SolanaIngestionCursor_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SolanaTransactionReceipt" (
    "id" TEXT NOT NULL,
    "genesisHash" TEXT NOT NULL,
    "programAddress" TEXT NOT NULL,
    "signature" TEXT NOT NULL,
    "slot" BIGINT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "eventCount" INTEGER NOT NULL DEFAULT 0,
    "decoderVersion" INTEGER NOT NULL DEFAULT 1,
    "configurationSlot" BIGINT,
    "lastError" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "SolanaTransactionReceipt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SolanaProgramEvent" (
    "eventKey" TEXT NOT NULL,
    "receiptId" TEXT NOT NULL,
    "logIndex" INTEGER NOT NULL,
    "invocationDepth" INTEGER NOT NULL,
    "kind" TEXT NOT NULL,
    "payload" TEXT NOT NULL,
    "schemaVersion" INTEGER NOT NULL DEFAULT 1,
    "marketAddress" TEXT,
    "walletAddress" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SolanaProgramEvent_pkey" PRIMARY KEY ("eventKey")
);

-- CreateIndex
CREATE UNIQUE INDEX "SolanaCursor_domain_key" ON "SolanaIngestionCursor"("genesisHash", "programAddress");

-- CreateIndex
CREATE INDEX "SolanaReceipt_domain_slot_idx" ON "SolanaTransactionReceipt"("genesisHash", "programAddress", "slot");

-- CreateIndex
CREATE UNIQUE INDEX "SolanaReceipt_domain_signature_key" ON "SolanaTransactionReceipt"("genesisHash", "programAddress", "signature");

-- CreateIndex
CREATE INDEX "SolanaProgramEvent_marketAddress_receiptId_idx" ON "SolanaProgramEvent"("marketAddress", "receiptId");

-- CreateIndex
CREATE UNIQUE INDEX "SolanaProgramEvent_receiptId_logIndex_key" ON "SolanaProgramEvent"("receiptId", "logIndex");

-- AddForeignKey
ALTER TABLE "SolanaProgramEvent" ADD CONSTRAINT "SolanaProgramEvent_receiptId_fkey" FOREIGN KEY ("receiptId") REFERENCES "SolanaTransactionReceipt"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

