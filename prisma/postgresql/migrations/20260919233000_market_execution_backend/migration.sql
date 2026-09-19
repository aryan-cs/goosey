-- Apply after reviewed backup, before switching generated Prisma clients.
-- Existing rows stay DATABASE. No balances or historical financial rows are rewritten.
BEGIN;
ALTER TABLE "Market" ADD COLUMN "executionBackend" TEXT NOT NULL DEFAULT 'DATABASE';
ALTER TABLE "Market" ALTER COLUMN "collateralAccountId" DROP NOT NULL;
ALTER TABLE "Market" ADD CONSTRAINT "Market_backend_collateral_check" CHECK (
  ("executionBackend" = 'DATABASE' AND "collateralAccountId" IS NOT NULL)
  OR ("executionBackend" = 'SOLANA' AND "collateralAccountId" IS NULL));
CREATE INDEX "Market_executionBackend_status_closesAt_idx" ON "Market"("executionBackend", "status", "closesAt");

-- CreateTable
CREATE TABLE "SolanaMarketBinding" (
    "id" TEXT NOT NULL,
    "marketId" TEXT NOT NULL,
    "cluster" TEXT NOT NULL,
    "genesisHash" TEXT NOT NULL,
    "programAddress" TEXT NOT NULL,
    "marketAddress" TEXT NOT NULL,
    "chainMarketId" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SolanaMarketBinding_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "SolanaMarketBinding_marketId_key" ON "SolanaMarketBinding"("marketId");

-- CreateIndex
CREATE UNIQUE INDEX "SolanaMarketBinding_domain_address_key" ON "SolanaMarketBinding"("genesisHash", "programAddress", "marketAddress");

-- CreateIndex
CREATE UNIQUE INDEX "SolanaMarketBinding_domain_id_key" ON "SolanaMarketBinding"("genesisHash", "programAddress", "chainMarketId");

-- AddForeignKey
ALTER TABLE "SolanaMarketBinding" ADD CONSTRAINT "SolanaMarketBinding_marketId_fkey" FOREIGN KEY ("marketId") REFERENCES "Market"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "SolanaMarketBinding" ADD CONSTRAINT "SolanaMarketBinding_cluster_check" CHECK ("cluster" IN ('localnet', 'devnet'));
ALTER TABLE "SolanaMarketBinding" ADD CONSTRAINT "SolanaMarketBinding_chain_id_check" CHECK (
  "chainMarketId" ~ '^(0|[1-9][0-9]{0,19})$'
  AND (length("chainMarketId") < 20 OR "chainMarketId" COLLATE "C" <= '18446744073709551615'));

CREATE FUNCTION "goosey_market_backend_immutable"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."executionBackend" IS DISTINCT FROM OLD."executionBackend" THEN
    RAISE EXCEPTION 'Market executionBackend is immutable';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "Market_executionBackend_immutable" BEFORE UPDATE OF "executionBackend" ON "Market"
FOR EACH ROW EXECUTE FUNCTION "goosey_market_backend_immutable"();

CREATE FUNCTION "goosey_solana_binding_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Solana market binding is retained and cannot be replaced';
  ELSIF TG_OP = 'UPDATE' THEN
    IF NEW IS DISTINCT FROM OLD THEN RAISE EXCEPTION 'Solana market binding is immutable'; END IF;
    RETURN NEW;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM "Market" WHERE id = NEW."marketId" AND "executionBackend" = 'SOLANA' AND "collateralAccountId" IS NULL) THEN
    RAISE EXCEPTION 'Solana binding requires a SOLANA market without SQL collateral';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "SolanaMarketBinding_guard" BEFORE INSERT OR UPDATE OR DELETE ON "SolanaMarketBinding"
FOR EACH ROW EXECUTE FUNCTION "goosey_solana_binding_guard"();
COMMIT;
