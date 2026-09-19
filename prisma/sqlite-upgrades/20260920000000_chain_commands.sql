PRAGMA foreign_keys=ON;

CREATE TABLE "ChainCommand" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "cluster" TEXT NOT NULL CHECK ("cluster" IN ('localnet', 'devnet')),
  "genesisHash" TEXT NOT NULL CHECK (length("genesisHash") BETWEEN 32 AND 44),
  "programAddress" TEXT NOT NULL CHECK (length("programAddress") BETWEEN 32 AND 44),
  "scope" TEXT NOT NULL CHECK ("scope" IN ('USER', 'MARKET', 'SYSTEM')),
  "scopeId" TEXT NOT NULL CHECK (length("scopeId") BETWEEN 1 AND 191),
  "actorId" TEXT NOT NULL CHECK (length("actorId") BETWEEN 1 AND 191),
  "operation" TEXT NOT NULL CHECK (length("operation") BETWEEN 1 AND 96),
  "idempotencyKey" TEXT NOT NULL CHECK (length("idempotencyKey") BETWEEN 1 AND 200),
  "requestHash" TEXT NOT NULL CHECK (length("requestHash") = 64 AND "requestHash" NOT GLOB '*[^0-9a-f]*'),
  "requestJson" TEXT NOT NULL CHECK (length("requestJson") BETWEEN 1 AND 65536),
  "status" TEXT NOT NULL DEFAULT 'ACCEPTED' CHECK ("status" IN (
    'ACCEPTED', 'PREPARED', 'SIGNED', 'SUBMITTED', 'CONFIRMED', 'FINALIZED', 'PROJECTED',
    'UNKNOWN', 'FAILED_RETRYABLE', 'FAILED_TERMINAL'
  )),
  "revision" INTEGER NOT NULL DEFAULT 0 CHECK ("revision" BETWEEN 0 AND 2147483647),
  "leaseOwner" TEXT CHECK ("leaseOwner" IS NULL OR length("leaseOwner") BETWEEN 1 AND 191),
  "leaseTokenHash" TEXT CHECK ("leaseTokenHash" IS NULL OR (length("leaseTokenHash") = 64 AND "leaseTokenHash" NOT GLOB '*[^0-9a-f]*')),
  "leaseEpoch" INTEGER NOT NULL DEFAULT 0 CHECK ("leaseEpoch" BETWEEN 0 AND 2147483647),
  "leaseExpiresAt" DATETIME,
  "attemptCount" INTEGER NOT NULL DEFAULT 0 CHECK ("attemptCount" BETWEEN 0 AND 2147483647),
  "lastErrorCode" TEXT CHECK ("lastErrorCode" IS NULL OR length("lastErrorCode") BETWEEN 1 AND 64),
  "lastErrorMessage" TEXT CHECK ("lastErrorMessage" IS NULL OR length("lastErrorMessage") BETWEEN 1 AND 1000),
  "acceptedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "preparedAt" DATETIME,
  "signedAt" DATETIME,
  "submittedAt" DATETIME,
  "confirmedAt" DATETIME,
  "finalizedAt" DATETIME,
  "projectedAt" DATETIME,
  "unknownSince" DATETIME,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" DATETIME NOT NULL,
  CHECK (("leaseOwner" IS NULL AND "leaseTokenHash" IS NULL AND "leaseExpiresAt" IS NULL)
    OR ("leaseOwner" IS NOT NULL AND "leaseTokenHash" IS NOT NULL AND "leaseExpiresAt" IS NOT NULL AND "leaseEpoch" > 0)),
  CHECK (("status" IN ('FAILED_RETRYABLE', 'FAILED_TERMINAL') AND "lastErrorCode" IS NOT NULL AND "lastErrorMessage" IS NOT NULL)
    OR ("status" NOT IN ('FAILED_RETRYABLE', 'FAILED_TERMINAL') AND "lastErrorCode" IS NULL AND "lastErrorMessage" IS NULL))
);

CREATE TABLE "ChainCommandSignedWire" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "commandId" TEXT NOT NULL,
  "sequence" INTEGER NOT NULL CHECK ("sequence" BETWEEN 0 AND 2147483647),
  "leaseEpoch" INTEGER NOT NULL CHECK ("leaseEpoch" BETWEEN 1 AND 2147483647),
  "commandRevision" INTEGER NOT NULL CHECK ("commandRevision" BETWEEN 0 AND 2147483647),
  "wireVersion" TEXT NOT NULL CHECK ("wireVersion" IN ('legacy', 'v0')),
  "signedWireBase64" TEXT NOT NULL CHECK (length("signedWireBase64") BETWEEN 4 AND 1644),
  "signedWireByteLength" INTEGER NOT NULL CHECK ("signedWireByteLength" BETWEEN 1 AND 1232),
  "signedWireSha256" TEXT NOT NULL CHECK (length("signedWireSha256") = 64 AND "signedWireSha256" NOT GLOB '*[^0-9a-f]*'),
  "transactionSignature" TEXT NOT NULL CHECK (length("transactionSignature") BETWEEN 87 AND 88),
  "recentBlockhash" TEXT NOT NULL CHECK (length("recentBlockhash") BETWEEN 32 AND 44),
  "lastValidBlockHeight" BIGINT CHECK ("lastValidBlockHeight" BETWEEN 0 AND 9223372036854775807),
  "durableNonceAddress" TEXT CHECK ("durableNonceAddress" IS NULL OR length("durableNonceAddress") BETWEEN 32 AND 44),
  "feePayerAddress" TEXT NOT NULL CHECK (length("feePayerAddress") BETWEEN 32 AND 44),
  "signerAddressesJson" TEXT NOT NULL CHECK (length("signerAddressesJson") BETWEEN 4 AND 1024),
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ChainCommandSignedWire_commandId_fkey" FOREIGN KEY ("commandId") REFERENCES "ChainCommand" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CHECK (("lastValidBlockHeight" IS NULL) <> ("durableNonceAddress" IS NULL))
);

CREATE INDEX "ChainCommand_dispatch_idx" ON "ChainCommand"("status", "leaseExpiresAt");
CREATE INDEX "ChainCommand_deployment_status_idx" ON "ChainCommand"("genesisHash", "programAddress", "status");
CREATE UNIQUE INDEX "ChainCommand_scoped_idempotency_key" ON "ChainCommand"("genesisHash", "programAddress", "scope", "scopeId", "operation", "idempotencyKey");
CREATE UNIQUE INDEX "ChainCommandSignedWire_transactionSignature_key" ON "ChainCommandSignedWire"("transactionSignature");
CREATE INDEX "ChainCommandWire_command_created_idx" ON "ChainCommandSignedWire"("commandId", "createdAt");
CREATE UNIQUE INDEX "ChainCommandWire_command_sequence_key" ON "ChainCommandSignedWire"("commandId", "sequence");

CREATE TRIGGER "ChainCommand_identity_and_cas_guard"
BEFORE UPDATE ON "ChainCommand"
FOR EACH ROW BEGIN
  SELECT CASE WHEN NEW."id" <> OLD."id"
    OR NEW."cluster" <> OLD."cluster" OR NEW."genesisHash" <> OLD."genesisHash" OR NEW."programAddress" <> OLD."programAddress"
    OR NEW."scope" <> OLD."scope" OR NEW."scopeId" <> OLD."scopeId" OR NEW."actorId" <> OLD."actorId"
    OR NEW."operation" <> OLD."operation" OR NEW."idempotencyKey" <> OLD."idempotencyKey"
    OR NEW."requestHash" <> OLD."requestHash" OR NEW."requestJson" <> OLD."requestJson"
    OR NEW."acceptedAt" <> OLD."acceptedAt" OR NEW."createdAt" <> OLD."createdAt"
    THEN RAISE(ABORT, 'ChainCommand identity is immutable') END;
  SELECT CASE WHEN NEW."revision" <> OLD."revision" + 1
    THEN RAISE(ABORT, 'ChainCommand revision must increment exactly once') END;
  SELECT CASE WHEN (NEW."leaseOwner" IS NOT OLD."leaseOwner" OR NEW."leaseTokenHash" IS NOT OLD."leaseTokenHash")
      AND NEW."leaseOwner" IS NOT NULL
      AND (NEW."leaseEpoch" <> OLD."leaseEpoch" + 1 OR NEW."attemptCount" <> OLD."attemptCount" + 1)
    THEN RAISE(ABORT, 'ChainCommand lease acquisition must advance its fence exactly once') END;
  SELECT CASE WHEN NOT ((NEW."leaseOwner" IS NOT OLD."leaseOwner" OR NEW."leaseTokenHash" IS NOT OLD."leaseTokenHash")
      AND NEW."leaseOwner" IS NOT NULL)
      AND (NEW."leaseEpoch" <> OLD."leaseEpoch" OR NEW."attemptCount" <> OLD."attemptCount")
    THEN RAISE(ABORT, 'ChainCommand fencing counters changed without lease acquisition') END;
  SELECT CASE WHEN NEW."status" <> OLD."status" AND NOT (
    (OLD."status"='ACCEPTED' AND NEW."status" IN ('PREPARED','FAILED_RETRYABLE','FAILED_TERMINAL')) OR
    (OLD."status"='PREPARED' AND NEW."status" IN ('SIGNED','FAILED_RETRYABLE','FAILED_TERMINAL')) OR
    (OLD."status"='SIGNED' AND NEW."status" IN ('SUBMITTED','UNKNOWN','FAILED_RETRYABLE','FAILED_TERMINAL')) OR
    (OLD."status"='SUBMITTED' AND NEW."status" IN ('CONFIRMED','FINALIZED','UNKNOWN','FAILED_RETRYABLE','FAILED_TERMINAL')) OR
    (OLD."status"='CONFIRMED' AND NEW."status" IN ('FINALIZED','UNKNOWN','FAILED_RETRYABLE','FAILED_TERMINAL')) OR
    (OLD."status"='FINALIZED' AND NEW."status" IN ('PROJECTED','FAILED_RETRYABLE','FAILED_TERMINAL')) OR
    (OLD."status"='UNKNOWN' AND NEW."status" IN ('SUBMITTED','CONFIRMED','FINALIZED','FAILED_RETRYABLE','FAILED_TERMINAL')) OR
    (OLD."status"='FAILED_RETRYABLE' AND NEW."status" IN ('ACCEPTED','UNKNOWN','FAILED_TERMINAL'))
  ) THEN RAISE(ABORT, 'Illegal ChainCommand status transition') END;
END;

CREATE TRIGGER "ChainCommandSignedWire_no_update"
BEFORE UPDATE ON "ChainCommandSignedWire"
BEGIN SELECT RAISE(ABORT, 'ChainCommandSignedWire is append-only'); END;

CREATE TRIGGER "ChainCommandSignedWire_no_delete"
BEFORE DELETE ON "ChainCommandSignedWire"
BEGIN SELECT RAISE(ABORT, 'ChainCommandSignedWire is append-only'); END;

CREATE TRIGGER "ChainCommandSignedWire_fence_insert"
BEFORE INSERT ON "ChainCommandSignedWire"
FOR EACH ROW BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM "ChainCommand" c WHERE c."id"=NEW."commandId" AND c."status"='PREPARED'
      AND c."revision"=NEW."commandRevision" AND c."leaseEpoch"=NEW."leaseEpoch"
      AND c."leaseOwner" IS NOT NULL AND c."leaseTokenHash" IS NOT NULL AND c."leaseExpiresAt" > CURRENT_TIMESTAMP
  ) THEN RAISE(ABORT, 'ChainCommandSignedWire lease fence mismatch') END;
END;
