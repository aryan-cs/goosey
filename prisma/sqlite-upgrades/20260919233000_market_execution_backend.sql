-- OFFLINE REVIEWED REBUILD. Stop all writers and make/verify a backup FIRST.
-- Run with sqlite3 -batch -bail -init /dev/null DB ".read THIS_FILE".
-- This file OWNS its transaction: DO NOT wrap it in BEGIN/COMMIT.
-- Do not generate/switch Prisma clients until this upgrade is committed.
-- All legacy fields/IDs/relations are copied exactly; every existing market remains DATABASE.
-- Custom Market indexes/triggers or extra columns cause a preflight refusal, never silent loss.
PRAGMA foreign_keys=OFF;
BEGIN IMMEDIATE;
CREATE TEMP TABLE "_goosey_backend_migration_guard" ("valid" INTEGER NOT NULL CHECK ("valid" = 1));
INSERT INTO "_goosey_backend_migration_guard" SELECT CASE WHEN
  (SELECT foreign_keys FROM pragma_foreign_keys) = 0
  AND (SELECT count(*) FROM pragma_table_info('Market')) = 36
  AND NOT EXISTS (SELECT 1 FROM pragma_table_info('Market') WHERE name NOT IN ('id', 'slug', 'title', 'shortTitle', 'description', 'rules', 'resolutionSource', 'category', 'status', 'resolution', 'featured', 'color', 'icon', 'closesAt', 'resolvesAt', 'resolvedAt', 'yesShares', 'noShares', 'liquidityParameter', 'payoutMilli', 'feeBps', 'volumeMilli', 'traderCount', 'commentCount', 'version', 'pricingModel', 'bookSequence', 'commandSequence', 'tradeSequence', 'engineVersion', 'acceptingOrders', 'createdById', 'eventId', 'collateralAccountId', 'createdAt', 'updatedAt'))
  AND NOT EXISTS (SELECT 1 FROM sqlite_master WHERE tbl_name = 'Market' AND
    (type = 'trigger' OR (type = 'index' AND sql IS NOT NULL AND name NOT IN (
      'Market_slug_key', 'Market_collateralAccountId_key', 'Market_status_closesAt_idx',
      'Market_eventId_status_closesAt_idx', 'Market_category_status_idx', 'Market_featured_status_idx', 'Market_volumeMilli_idx'))))
  AND NOT EXISTS (SELECT 1 FROM pragma_foreign_key_check)
THEN 1 ELSE 0 END;

-- CreateTable

-- Exact recognized column/FK/index metadata, including order, defaults, uniqueness,
-- partial/expression/descending/collation changes and missing indexes.
WITH expected ("cid","name","type","notnull","default","pk") AS (VALUES
  (0,'id','TEXT',1,NULL,1),
  (1,'slug','TEXT',1,NULL,0),
  (2,'title','TEXT',1,NULL,0),
  (3,'shortTitle','TEXT',1,NULL,0),
  (4,'description','TEXT',1,NULL,0),
  (5,'rules','TEXT',1,NULL,0),
  (6,'resolutionSource','TEXT',1,NULL,0),
  (7,'category','TEXT',1,NULL,0),
  (8,'status','TEXT',1,'''OPEN''',0),
  (9,'resolution','TEXT',0,NULL,0),
  (10,'featured','BOOLEAN',1,'false',0),
  (11,'color','TEXT',1,'''gold''',0),
  (12,'icon','TEXT',1,'''sparkles''',0),
  (13,'closesAt','DATETIME',1,NULL,0),
  (14,'resolvesAt','DATETIME',1,NULL,0),
  (15,'resolvedAt','DATETIME',0,NULL,0),
  (16,'yesShares','INTEGER',1,'0',0),
  (17,'noShares','INTEGER',1,'0',0),
  (18,'liquidityParameter','INTEGER',1,'40',0),
  (19,'payoutMilli','BIGINT',1,'100000',0),
  (20,'feeBps','INTEGER',1,'0',0),
  (21,'volumeMilli','BIGINT',1,'0',0),
  (22,'traderCount','INTEGER',1,'0',0),
  (23,'commentCount','INTEGER',1,'0',0),
  (24,'version','INTEGER',1,'0',0),
  (25,'pricingModel','TEXT',1,'''LMSR''',0),
  (26,'bookSequence','BIGINT',1,'0',0),
  (27,'commandSequence','BIGINT',1,'0',0),
  (28,'tradeSequence','BIGINT',1,'0',0),
  (29,'engineVersion','INTEGER',1,'1',0),
  (30,'acceptingOrders','BOOLEAN',1,'true',0),
  (31,'createdById','TEXT',1,NULL,0),
  (32,'eventId','TEXT',0,NULL,0),
  (33,'collateralAccountId','TEXT',1,NULL,0),
  (34,'createdAt','DATETIME',1,'CURRENT_TIMESTAMP',0),
  (35,'updatedAt','DATETIME',1,NULL,0)
), actual AS (SELECT cid,name,type,"notnull",dflt_value,pk FROM pragma_table_info('Market'))
INSERT INTO "_goosey_backend_migration_guard" SELECT CASE WHEN
  NOT EXISTS (SELECT * FROM expected EXCEPT SELECT * FROM actual)
  AND NOT EXISTS (SELECT * FROM actual EXCEPT SELECT * FROM expected)
THEN 1 ELSE 0 END;

WITH expected ("id","seq","table","from","to","on_update","on_delete","match") AS (VALUES
  (0,0,'LedgerAccount','collateralAccountId','id','CASCADE','RESTRICT','NONE'),
  (1,0,'MarketEvent','eventId','id','CASCADE','SET NULL','NONE'),
  (2,0,'User','createdById','id','CASCADE','RESTRICT','NONE')
), actual AS (SELECT id,seq,"table","from","to",on_update,on_delete,"match" FROM pragma_foreign_key_list('Market'))
INSERT INTO "_goosey_backend_migration_guard" SELECT CASE WHEN
  NOT EXISTS (SELECT * FROM expected EXCEPT SELECT * FROM actual)
  AND NOT EXISTS (SELECT * FROM actual EXCEPT SELECT * FROM expected)
THEN 1 ELSE 0 END;

WITH expected ("name","unique","origin","partial") AS (VALUES
  ('Market_volumeMilli_idx',0,'c',0),
  ('Market_featured_status_idx',0,'c',0),
  ('Market_category_status_idx',0,'c',0),
  ('Market_eventId_status_closesAt_idx',0,'c',0),
  ('Market_status_closesAt_idx',0,'c',0),
  ('Market_collateralAccountId_key',1,'c',0),
  ('Market_slug_key',1,'c',0),
  ('sqlite_autoindex_Market_1',1,'pk',0)
), actual AS (SELECT name,"unique",origin,partial FROM pragma_index_list('Market'))
INSERT INTO "_goosey_backend_migration_guard" SELECT CASE WHEN
  NOT EXISTS (SELECT * FROM expected EXCEPT SELECT * FROM actual)
  AND NOT EXISTS (SELECT * FROM actual EXCEPT SELECT * FROM expected)
THEN 1 ELSE 0 END;

WITH expected ("name","seqno","cid","column","desc","coll","key") AS (VALUES
  ('Market_volumeMilli_idx',0,21,'volumeMilli',0,'BINARY',1),
  ('Market_volumeMilli_idx',1,-1,NULL,0,'BINARY',0),
  ('Market_featured_status_idx',0,10,'featured',0,'BINARY',1),
  ('Market_featured_status_idx',1,8,'status',0,'BINARY',1),
  ('Market_featured_status_idx',2,-1,NULL,0,'BINARY',0),
  ('Market_category_status_idx',0,7,'category',0,'BINARY',1),
  ('Market_category_status_idx',1,8,'status',0,'BINARY',1),
  ('Market_category_status_idx',2,-1,NULL,0,'BINARY',0),
  ('Market_eventId_status_closesAt_idx',0,32,'eventId',0,'BINARY',1),
  ('Market_eventId_status_closesAt_idx',1,8,'status',0,'BINARY',1),
  ('Market_eventId_status_closesAt_idx',2,13,'closesAt',0,'BINARY',1),
  ('Market_eventId_status_closesAt_idx',3,-1,NULL,0,'BINARY',0),
  ('Market_status_closesAt_idx',0,8,'status',0,'BINARY',1),
  ('Market_status_closesAt_idx',1,13,'closesAt',0,'BINARY',1),
  ('Market_status_closesAt_idx',2,-1,NULL,0,'BINARY',0),
  ('Market_collateralAccountId_key',0,33,'collateralAccountId',0,'BINARY',1),
  ('Market_collateralAccountId_key',1,-1,NULL,0,'BINARY',0),
  ('Market_slug_key',0,1,'slug',0,'BINARY',1),
  ('Market_slug_key',1,-1,NULL,0,'BINARY',0),
  ('sqlite_autoindex_Market_1',0,0,'id',0,'BINARY',1),
  ('sqlite_autoindex_Market_1',1,-1,NULL,0,'BINARY',0)
), actual AS (SELECT l.name,i.seqno,i.cid,i.name,i."desc",i.coll,i."key" FROM pragma_index_list('Market') l, pragma_index_xinfo(l.name) i)
INSERT INTO "_goosey_backend_migration_guard" SELECT CASE WHEN
  NOT EXISTS (SELECT * FROM expected EXCEPT SELECT * FROM actual)
  AND NOT EXISTS (SELECT * FROM actual EXCEPT SELECT * FROM expected)
THEN 1 ELSE 0 END;

-- Also recognize the exact source table DDL (ignoring formatting whitespace only),
-- so extra CHECKs, generated columns, conflict policies or collations cannot vanish.
INSERT INTO "_goosey_backend_migration_guard" SELECT CASE WHEN
  (SELECT replace(replace(replace(replace(sql, char(10), ''), char(13), ''), char(9), ''), ' ', '')
   FROM sqlite_master WHERE type='table' AND name='Market') = 'CREATETABLE"Market"("id"TEXTNOTNULLPRIMARYKEY,"slug"TEXTNOTNULL,"title"TEXTNOTNULL,"shortTitle"TEXTNOTNULL,"description"TEXTNOTNULL,"rules"TEXTNOTNULL,"resolutionSource"TEXTNOTNULL,"category"TEXTNOTNULL,"status"TEXTNOTNULLDEFAULT''OPEN'',"resolution"TEXT,"featured"BOOLEANNOTNULLDEFAULTfalse,"color"TEXTNOTNULLDEFAULT''gold'',"icon"TEXTNOTNULLDEFAULT''sparkles'',"closesAt"DATETIMENOTNULL,"resolvesAt"DATETIMENOTNULL,"resolvedAt"DATETIME,"yesShares"INTEGERNOTNULLDEFAULT0,"noShares"INTEGERNOTNULLDEFAULT0,"liquidityParameter"INTEGERNOTNULLDEFAULT40,"payoutMilli"BIGINTNOTNULLDEFAULT100000,"feeBps"INTEGERNOTNULLDEFAULT0,"volumeMilli"BIGINTNOTNULLDEFAULT0,"traderCount"INTEGERNOTNULLDEFAULT0,"commentCount"INTEGERNOTNULLDEFAULT0,"version"INTEGERNOTNULLDEFAULT0,"pricingModel"TEXTNOTNULLDEFAULT''LMSR'',"bookSequence"BIGINTNOTNULLDEFAULT0,"commandSequence"BIGINTNOTNULLDEFAULT0,"tradeSequence"BIGINTNOTNULLDEFAULT0,"engineVersion"INTEGERNOTNULLDEFAULT1,"acceptingOrders"BOOLEANNOTNULLDEFAULTtrue,"createdById"TEXTNOTNULL,"eventId"TEXT,"collateralAccountId"TEXTNOTNULL,"createdAt"DATETIMENOTNULLDEFAULTCURRENT_TIMESTAMP,"updatedAt"DATETIMENOTNULL,CONSTRAINT"Market_createdById_fkey"FOREIGNKEY("createdById")REFERENCES"User"("id")ONDELETERESTRICTONUPDATECASCADE,CONSTRAINT"Market_eventId_fkey"FOREIGNKEY("eventId")REFERENCES"MarketEvent"("id")ONDELETESETNULLONUPDATECASCADE,CONSTRAINT"Market_collateralAccountId_fkey"FOREIGNKEY("collateralAccountId")REFERENCES"LedgerAccount"("id")ONDELETERESTRICTONUPDATECASCADE)'
THEN 1 ELSE 0 END;

CREATE TABLE "new_Market" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "executionBackend" TEXT NOT NULL DEFAULT 'DATABASE',
    "slug" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "shortTitle" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "rules" TEXT NOT NULL,
    "resolutionSource" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "resolution" TEXT,
    "featured" BOOLEAN NOT NULL DEFAULT false,
    "color" TEXT NOT NULL DEFAULT 'gold',
    "icon" TEXT NOT NULL DEFAULT 'sparkles',
    "closesAt" DATETIME NOT NULL,
    "resolvesAt" DATETIME NOT NULL,
    "resolvedAt" DATETIME,
    "yesShares" INTEGER NOT NULL DEFAULT 0,
    "noShares" INTEGER NOT NULL DEFAULT 0,
    "liquidityParameter" INTEGER NOT NULL DEFAULT 40,
    "payoutMilli" BIGINT NOT NULL DEFAULT 100000,
    "feeBps" INTEGER NOT NULL DEFAULT 0,
    "volumeMilli" BIGINT NOT NULL DEFAULT 0,
    "traderCount" INTEGER NOT NULL DEFAULT 0,
    "commentCount" INTEGER NOT NULL DEFAULT 0,
    "version" INTEGER NOT NULL DEFAULT 0,
    "pricingModel" TEXT NOT NULL DEFAULT 'LMSR',
    "bookSequence" BIGINT NOT NULL DEFAULT 0,
    "commandSequence" BIGINT NOT NULL DEFAULT 0,
    "tradeSequence" BIGINT NOT NULL DEFAULT 0,
    "engineVersion" INTEGER NOT NULL DEFAULT 1,
    "acceptingOrders" BOOLEAN NOT NULL DEFAULT true,
    "createdById" TEXT NOT NULL,
    "eventId" TEXT,
    "collateralAccountId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Market_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "Market_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "MarketEvent" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "Market_collateralAccountId_fkey" FOREIGN KEY ("collateralAccountId") REFERENCES "LedgerAccount" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "Market_backend_collateral_check" CHECK (("executionBackend" = 'DATABASE' AND "collateralAccountId" IS NOT NULL) OR ("executionBackend" = 'SOLANA' AND "collateralAccountId" IS NULL))
);

INSERT INTO "new_Market" ("id", "slug", "title", "shortTitle", "description", "rules", "resolutionSource", "category", "status", "resolution", "featured", "color", "icon", "closesAt", "resolvesAt", "resolvedAt", "yesShares", "noShares", "liquidityParameter", "payoutMilli", "feeBps", "volumeMilli", "traderCount", "commentCount", "version", "pricingModel", "bookSequence", "commandSequence", "tradeSequence", "engineVersion", "acceptingOrders", "createdById", "eventId", "collateralAccountId", "createdAt", "updatedAt") SELECT "id", "slug", "title", "shortTitle", "description", "rules", "resolutionSource", "category", "status", "resolution", "featured", "color", "icon", "closesAt", "resolvesAt", "resolvedAt", "yesShares", "noShares", "liquidityParameter", "payoutMilli", "feeBps", "volumeMilli", "traderCount", "commentCount", "version", "pricingModel", "bookSequence", "commandSequence", "tradeSequence", "engineVersion", "acceptingOrders", "createdById", "eventId", "collateralAccountId", "createdAt", "updatedAt" FROM "Market";
-- Prove row count and every copied legacy value in BOTH directions before DROP.
INSERT INTO "_goosey_backend_migration_guard" SELECT CASE WHEN
  (SELECT count(*) FROM "new_Market") = (SELECT count(*) FROM "Market")
  AND NOT EXISTS (SELECT "id", "slug", "title", "shortTitle", "description", "rules", "resolutionSource", "category", "status", "resolution", "featured", "color", "icon", "closesAt", "resolvesAt", "resolvedAt", "yesShares", "noShares", "liquidityParameter", "payoutMilli", "feeBps", "volumeMilli", "traderCount", "commentCount", "version", "pricingModel", "bookSequence", "commandSequence", "tradeSequence", "engineVersion", "acceptingOrders", "createdById", "eventId", "collateralAccountId", "createdAt", "updatedAt" FROM "Market" EXCEPT SELECT "id", "slug", "title", "shortTitle", "description", "rules", "resolutionSource", "category", "status", "resolution", "featured", "color", "icon", "closesAt", "resolvesAt", "resolvedAt", "yesShares", "noShares", "liquidityParameter", "payoutMilli", "feeBps", "volumeMilli", "traderCount", "commentCount", "version", "pricingModel", "bookSequence", "commandSequence", "tradeSequence", "engineVersion", "acceptingOrders", "createdById", "eventId", "collateralAccountId", "createdAt", "updatedAt" FROM "new_Market")
  AND NOT EXISTS (SELECT "id", "slug", "title", "shortTitle", "description", "rules", "resolutionSource", "category", "status", "resolution", "featured", "color", "icon", "closesAt", "resolvesAt", "resolvedAt", "yesShares", "noShares", "liquidityParameter", "payoutMilli", "feeBps", "volumeMilli", "traderCount", "commentCount", "version", "pricingModel", "bookSequence", "commandSequence", "tradeSequence", "engineVersion", "acceptingOrders", "createdById", "eventId", "collateralAccountId", "createdAt", "updatedAt" FROM "new_Market" EXCEPT SELECT "id", "slug", "title", "shortTitle", "description", "rules", "resolutionSource", "category", "status", "resolution", "featured", "color", "icon", "closesAt", "resolvesAt", "resolvedAt", "yesShares", "noShares", "liquidityParameter", "payoutMilli", "feeBps", "volumeMilli", "traderCount", "commentCount", "version", "pricingModel", "bookSequence", "commandSequence", "tradeSequence", "engineVersion", "acceptingOrders", "createdById", "eventId", "collateralAccountId", "createdAt", "updatedAt" FROM "Market")
THEN 1 ELSE 0 END;
DROP TABLE "Market";
ALTER TABLE "new_Market" RENAME TO "Market";

-- CreateIndex
CREATE UNIQUE INDEX "Market_slug_key" ON "Market"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "Market_collateralAccountId_key" ON "Market"("collateralAccountId");

-- CreateIndex
CREATE INDEX "Market_status_closesAt_idx" ON "Market"("status", "closesAt");

-- CreateIndex
CREATE INDEX "Market_eventId_status_closesAt_idx" ON "Market"("eventId", "status", "closesAt");

-- CreateIndex
CREATE INDEX "Market_category_status_idx" ON "Market"("category", "status");

-- CreateIndex
CREATE INDEX "Market_featured_status_idx" ON "Market"("featured", "status");

-- CreateIndex
CREATE INDEX "Market_volumeMilli_idx" ON "Market"("volumeMilli");

-- CreateIndex
CREATE INDEX "Market_executionBackend_status_closesAt_idx" ON "Market"("executionBackend", "status", "closesAt");

-- CreateTable
CREATE TABLE "SolanaMarketBinding" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "marketId" TEXT NOT NULL,
    "cluster" TEXT NOT NULL,
    "genesisHash" TEXT NOT NULL,
    "programAddress" TEXT NOT NULL,
    "marketAddress" TEXT NOT NULL,
    "chainMarketId" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "SolanaMarketBinding_marketId_fkey" FOREIGN KEY ("marketId") REFERENCES "Market" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "SolanaMarketBinding_cluster_check" CHECK ("cluster" IN ('localnet', 'devnet')),
    CONSTRAINT "SolanaMarketBinding_chain_id_check" CHECK (
      length("chainMarketId") BETWEEN 1 AND 20 AND "chainMarketId" NOT GLOB '*[^0-9]*'
      AND ("chainMarketId" = '0' OR substr("chainMarketId", 1, 1) BETWEEN '1' AND '9')
      AND (length("chainMarketId") < 20 OR "chainMarketId" <= '18446744073709551615'))
);

-- CreateIndex
CREATE UNIQUE INDEX "SolanaMarketBinding_marketId_key" ON "SolanaMarketBinding"("marketId");

-- CreateIndex
CREATE UNIQUE INDEX "SolanaMarketBinding_domain_address_key" ON "SolanaMarketBinding"("genesisHash", "programAddress", "marketAddress");

-- CreateIndex
CREATE UNIQUE INDEX "SolanaMarketBinding_domain_id_key" ON "SolanaMarketBinding"("genesisHash", "programAddress", "chainMarketId");

CREATE TRIGGER "Market_executionBackend_immutable"
BEFORE UPDATE OF "executionBackend" ON "Market"
WHEN NEW."executionBackend" IS NOT OLD."executionBackend"
BEGIN
  SELECT RAISE(ABORT, 'Market executionBackend is immutable');
END;

CREATE TRIGGER "SolanaMarketBinding_backend_insert"
BEFORE INSERT ON "SolanaMarketBinding"
WHEN NOT EXISTS (SELECT 1 FROM "Market" WHERE id = NEW."marketId" AND "executionBackend" = 'SOLANA' AND "collateralAccountId" IS NULL)
BEGIN
  SELECT RAISE(ABORT, 'Solana binding requires a SOLANA market without SQL collateral');
END;

CREATE TRIGGER "SolanaMarketBinding_immutable_update"
BEFORE UPDATE ON "SolanaMarketBinding"
WHEN NEW."id" IS NOT OLD."id" OR NEW."marketId" IS NOT OLD."marketId" OR NEW."cluster" IS NOT OLD."cluster"
  OR NEW."genesisHash" IS NOT OLD."genesisHash" OR NEW."programAddress" IS NOT OLD."programAddress"
  OR NEW."marketAddress" IS NOT OLD."marketAddress" OR NEW."chainMarketId" IS NOT OLD."chainMarketId"
  OR NEW."createdAt" IS NOT OLD."createdAt"
BEGIN
  SELECT RAISE(ABORT, 'Solana market binding is immutable');
END;

CREATE TRIGGER "SolanaMarketBinding_immutable_delete"
BEFORE DELETE ON "SolanaMarketBinding"
BEGIN
  SELECT RAISE(ABORT, 'Solana market binding is retained and cannot be replaced');
END;

-- Unlike a bare PRAGMA report, this CHECK aborts a -bail run before COMMIT on any FK violation.
INSERT INTO "_goosey_backend_migration_guard"
SELECT CASE WHEN NOT EXISTS (SELECT 1 FROM pragma_foreign_key_check) THEN 1 ELSE 0 END;
DROP TABLE "_goosey_backend_migration_guard";
COMMIT;
PRAGMA foreign_keys=ON;
