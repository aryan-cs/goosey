CREATE TABLE "ChainCommand" (
  "id" TEXT NOT NULL,
  "cluster" TEXT NOT NULL,
  "genesisHash" TEXT NOT NULL,
  "programAddress" TEXT NOT NULL,
  "scope" TEXT NOT NULL,
  "scopeId" TEXT NOT NULL,
  "actorId" TEXT NOT NULL,
  "operation" TEXT NOT NULL,
  "idempotencyKey" TEXT NOT NULL,
  "requestHash" TEXT NOT NULL,
  "requestJson" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'ACCEPTED',
  "revision" INTEGER NOT NULL DEFAULT 0,
  "leaseOwner" TEXT,
  "leaseTokenHash" TEXT,
  "leaseEpoch" INTEGER NOT NULL DEFAULT 0,
  "leaseExpiresAt" TIMESTAMPTZ(3),
  "attemptCount" INTEGER NOT NULL DEFAULT 0,
  "lastErrorCode" TEXT,
  "lastErrorMessage" TEXT,
  "acceptedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "preparedAt" TIMESTAMPTZ(3),
  "signedAt" TIMESTAMPTZ(3),
  "submittedAt" TIMESTAMPTZ(3),
  "confirmedAt" TIMESTAMPTZ(3),
  "finalizedAt" TIMESTAMPTZ(3),
  "projectedAt" TIMESTAMPTZ(3),
  "unknownSince" TIMESTAMPTZ(3),
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "ChainCommand_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ChainCommand_cluster_check" CHECK ("cluster" IN ('localnet', 'devnet')),
  CONSTRAINT "ChainCommand_deployment_check" CHECK (char_length("genesisHash") BETWEEN 32 AND 44 AND char_length("programAddress") BETWEEN 32 AND 44),
  CONSTRAINT "ChainCommand_scope_check" CHECK ("scope" IN ('USER', 'MARKET', 'SYSTEM')),
  CONSTRAINT "ChainCommand_identity_bounds_check" CHECK (char_length("scopeId") BETWEEN 1 AND 191 AND char_length("actorId") BETWEEN 1 AND 191 AND char_length("operation") BETWEEN 1 AND 96 AND char_length("idempotencyKey") BETWEEN 1 AND 200),
  CONSTRAINT "ChainCommand_request_check" CHECK ("requestHash" ~ '^[0-9a-f]{64}$' AND char_length("requestJson") BETWEEN 1 AND 65536),
  CONSTRAINT "ChainCommand_status_check" CHECK ("status" IN ('ACCEPTED', 'PREPARED', 'SIGNED', 'SUBMITTED', 'CONFIRMED', 'FINALIZED', 'PROJECTED', 'UNKNOWN', 'FAILED_RETRYABLE', 'FAILED_TERMINAL')),
  CONSTRAINT "ChainCommand_counters_check" CHECK ("revision" BETWEEN 0 AND 2147483647 AND "leaseEpoch" BETWEEN 0 AND 2147483647 AND "attemptCount" BETWEEN 0 AND 2147483647),
  CONSTRAINT "ChainCommand_lease_check" CHECK (("leaseOwner" IS NULL AND "leaseTokenHash" IS NULL AND "leaseExpiresAt" IS NULL) OR (char_length("leaseOwner") BETWEEN 1 AND 191 AND "leaseTokenHash" ~ '^[0-9a-f]{64}$' AND "leaseExpiresAt" IS NOT NULL AND "leaseEpoch" > 0)),
  CONSTRAINT "ChainCommand_failure_check" CHECK (("status" IN ('FAILED_RETRYABLE', 'FAILED_TERMINAL') AND char_length("lastErrorCode") BETWEEN 1 AND 64 AND char_length("lastErrorMessage") BETWEEN 1 AND 1000) OR ("status" NOT IN ('FAILED_RETRYABLE', 'FAILED_TERMINAL') AND "lastErrorCode" IS NULL AND "lastErrorMessage" IS NULL))
);

CREATE TABLE "ChainCommandSignedWire" (
  "id" TEXT NOT NULL,
  "commandId" TEXT NOT NULL,
  "sequence" INTEGER NOT NULL,
  "leaseEpoch" INTEGER NOT NULL,
  "commandRevision" INTEGER NOT NULL,
  "wireVersion" TEXT NOT NULL,
  "signedWireBase64" TEXT NOT NULL,
  "signedWireByteLength" INTEGER NOT NULL,
  "signedWireSha256" TEXT NOT NULL,
  "transactionSignature" TEXT NOT NULL,
  "recentBlockhash" TEXT NOT NULL,
  "lastValidBlockHeight" BIGINT,
  "durableNonceAddress" TEXT,
  "feePayerAddress" TEXT NOT NULL,
  "signerAddressesJson" TEXT NOT NULL,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ChainCommandSignedWire_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ChainCommandWire_counters_check" CHECK ("sequence" BETWEEN 0 AND 2147483647 AND "leaseEpoch" BETWEEN 1 AND 2147483647 AND "commandRevision" BETWEEN 0 AND 2147483647),
  CONSTRAINT "ChainCommandWire_version_check" CHECK ("wireVersion" IN ('legacy', 'v0')),
  CONSTRAINT "ChainCommandWire_payload_check" CHECK (char_length("signedWireBase64") BETWEEN 4 AND 1644 AND "signedWireByteLength" BETWEEN 1 AND 1232 AND "signedWireSha256" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "ChainCommandWire_signature_check" CHECK (char_length("transactionSignature") BETWEEN 87 AND 88 AND char_length("recentBlockhash") BETWEEN 32 AND 44),
  CONSTRAINT "ChainCommandWire_lifetime_check" CHECK (("lastValidBlockHeight" IS NULL) <> ("durableNonceAddress" IS NULL) AND ("lastValidBlockHeight" IS NULL OR "lastValidBlockHeight" >= 0)),
  CONSTRAINT "ChainCommandWire_address_check" CHECK (("durableNonceAddress" IS NULL OR char_length("durableNonceAddress") BETWEEN 32 AND 44) AND char_length("feePayerAddress") BETWEEN 32 AND 44),
  CONSTRAINT "ChainCommandWire_signers_check" CHECK (char_length("signerAddressesJson") BETWEEN 4 AND 1024)
);

CREATE INDEX "ChainCommand_dispatch_idx" ON "ChainCommand"("status", "leaseExpiresAt");
CREATE INDEX "ChainCommand_deployment_status_idx" ON "ChainCommand"("genesisHash", "programAddress", "status");
CREATE UNIQUE INDEX "ChainCommand_scoped_idempotency_key" ON "ChainCommand"("genesisHash", "programAddress", "scope", "scopeId", "operation", "idempotencyKey");
CREATE UNIQUE INDEX "ChainCommandSignedWire_transactionSignature_key" ON "ChainCommandSignedWire"("transactionSignature");
CREATE INDEX "ChainCommandWire_command_created_idx" ON "ChainCommandSignedWire"("commandId", "createdAt");
CREATE UNIQUE INDEX "ChainCommandWire_command_sequence_key" ON "ChainCommandSignedWire"("commandId", "sequence");

ALTER TABLE "ChainCommandSignedWire" ADD CONSTRAINT "ChainCommandSignedWire_commandId_fkey"
FOREIGN KEY ("commandId") REFERENCES "ChainCommand"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE FUNCTION "ChainCommand_guard_update"() RETURNS trigger AS $$
BEGIN
  IF NEW."id" <> OLD."id" OR NEW."cluster" <> OLD."cluster" OR NEW."genesisHash" <> OLD."genesisHash"
    OR NEW."programAddress" <> OLD."programAddress" OR NEW."scope" <> OLD."scope" OR NEW."scopeId" <> OLD."scopeId"
    OR NEW."actorId" <> OLD."actorId" OR NEW."operation" <> OLD."operation" OR NEW."idempotencyKey" <> OLD."idempotencyKey"
    OR NEW."requestHash" <> OLD."requestHash" OR NEW."requestJson" <> OLD."requestJson"
    OR NEW."acceptedAt" <> OLD."acceptedAt" OR NEW."createdAt" <> OLD."createdAt" THEN
    RAISE EXCEPTION 'ChainCommand identity is immutable';
  END IF;
  IF NEW."revision" <> OLD."revision" + 1 THEN RAISE EXCEPTION 'ChainCommand revision must increment exactly once'; END IF;
  IF (NEW."leaseOwner" IS DISTINCT FROM OLD."leaseOwner" OR NEW."leaseTokenHash" IS DISTINCT FROM OLD."leaseTokenHash")
    AND NEW."leaseOwner" IS NOT NULL THEN
    IF NEW."leaseEpoch" <> OLD."leaseEpoch" + 1 OR NEW."attemptCount" <> OLD."attemptCount" + 1 THEN
      RAISE EXCEPTION 'ChainCommand lease acquisition must advance its fence exactly once';
    END IF;
  ELSIF NEW."leaseEpoch" <> OLD."leaseEpoch" OR NEW."attemptCount" <> OLD."attemptCount" THEN
    RAISE EXCEPTION 'ChainCommand fencing counters changed without lease acquisition';
  END IF;
  IF NEW."status" <> OLD."status" AND NOT (
    (OLD."status"='ACCEPTED' AND NEW."status" IN ('PREPARED','FAILED_RETRYABLE','FAILED_TERMINAL')) OR
    (OLD."status"='PREPARED' AND NEW."status" IN ('SIGNED','FAILED_RETRYABLE','FAILED_TERMINAL')) OR
    (OLD."status"='SIGNED' AND NEW."status" IN ('SUBMITTED','UNKNOWN','FAILED_RETRYABLE','FAILED_TERMINAL')) OR
    (OLD."status"='SUBMITTED' AND NEW."status" IN ('CONFIRMED','FINALIZED','UNKNOWN','FAILED_RETRYABLE','FAILED_TERMINAL')) OR
    (OLD."status"='CONFIRMED' AND NEW."status" IN ('FINALIZED','UNKNOWN','FAILED_RETRYABLE','FAILED_TERMINAL')) OR
    (OLD."status"='FINALIZED' AND NEW."status" IN ('PROJECTED','FAILED_RETRYABLE','FAILED_TERMINAL')) OR
    (OLD."status"='UNKNOWN' AND NEW."status" IN ('SUBMITTED','CONFIRMED','FINALIZED','FAILED_RETRYABLE','FAILED_TERMINAL')) OR
    (OLD."status"='FAILED_RETRYABLE' AND NEW."status" IN ('ACCEPTED','UNKNOWN','FAILED_TERMINAL'))
  ) THEN
    RAISE EXCEPTION 'Illegal ChainCommand status transition';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "ChainCommand_identity_and_cas_guard"
BEFORE UPDATE ON "ChainCommand" FOR EACH ROW EXECUTE FUNCTION "ChainCommand_guard_update"();

CREATE FUNCTION "ChainCommandSignedWire_deny_mutation"() RETURNS trigger AS $$
BEGIN RAISE EXCEPTION 'ChainCommandSignedWire is append-only'; END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "ChainCommandSignedWire_no_update_or_delete"
BEFORE UPDATE OR DELETE ON "ChainCommandSignedWire" FOR EACH ROW EXECUTE FUNCTION "ChainCommandSignedWire_deny_mutation"();

CREATE FUNCTION "ChainCommandSignedWire_guard_insert"() RETURNS trigger AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM "ChainCommand" c WHERE c."id"=NEW."commandId" AND c."status"='PREPARED'
      AND c."revision"=NEW."commandRevision" AND c."leaseEpoch"=NEW."leaseEpoch"
      AND c."leaseOwner" IS NOT NULL AND c."leaseTokenHash" IS NOT NULL AND c."leaseExpiresAt" > CURRENT_TIMESTAMP
  ) THEN RAISE EXCEPTION 'ChainCommandSignedWire lease fence mismatch'; END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "ChainCommandSignedWire_fence_insert"
BEFORE INSERT ON "ChainCommandSignedWire" FOR EACH ROW EXECUTE FUNCTION "ChainCommandSignedWire_guard_insert"();
