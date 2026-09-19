-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "username" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "emailVerifiedAt" TIMESTAMPTZ(3),
    "role" TEXT NOT NULL DEFAULT 'USER',
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "bio" TEXT NOT NULL DEFAULT '',
    "profilePublic" BOOLEAN NOT NULL DEFAULT false,
    "leaderboardVisible" BOOLEAN NOT NULL DEFAULT false,
    "balanceMilli" BIGINT NOT NULL DEFAULT 0,
    "realizedPnlMilli" BIGINT NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    "lastActiveAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AccountToken" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "purpose" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,
    "consumedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "AccountToken_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Session" (
    "id" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "userAgent" TEXT,
    "ipHash" TEXT,

    CONSTRAINT "Session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Market" (
    "id" TEXT NOT NULL,
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
    "closesAt" TIMESTAMPTZ(3) NOT NULL,
    "resolvesAt" TIMESTAMPTZ(3) NOT NULL,
    "resolvedAt" TIMESTAMPTZ(3),
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
    "collateralAccountId" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "Market_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MarketEvent" (
    "id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "shortTitle" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "featured" BOOLEAN NOT NULL DEFAULT false,
    "color" TEXT NOT NULL DEFAULT 'gold',
    "icon" TEXT NOT NULL DEFAULT 'sparkles',
    "startsAt" TIMESTAMPTZ(3) NOT NULL,
    "endsAt" TIMESTAMPTZ(3) NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 0,
    "createdById" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "MarketEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MarketEventCreationRequest" (
    "id" TEXT NOT NULL,
    "actorUserId" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "requestHash" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MarketEventCreationRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Position" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "marketId" TEXT NOT NULL,
    "yesShares" INTEGER NOT NULL DEFAULT 0,
    "noShares" INTEGER NOT NULL DEFAULT 0,
    "netCostMilli" BIGINT NOT NULL DEFAULT 0,
    "yesCostBasisMilli" BIGINT NOT NULL DEFAULT 0,
    "noCostBasisMilli" BIGINT NOT NULL DEFAULT 0,
    "realizedPnlMilli" BIGINT NOT NULL DEFAULT 0,
    "reservedYesShares" INTEGER NOT NULL DEFAULT 0,
    "reservedNoShares" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "Position_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Trade" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "marketId" TEXT NOT NULL,
    "side" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "amountMilli" BIGINT NOT NULL,
    "feeMilli" BIGINT NOT NULL DEFAULT 0,
    "priceBeforeBps" INTEGER NOT NULL,
    "priceAfterBps" INTEGER NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Trade_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MarketOrder" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "marketId" TEXT NOT NULL,
    "clientOrderId" TEXT NOT NULL,
    "outcome" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "bookSide" TEXT NOT NULL,
    "limitPriceMilli" BIGINT NOT NULL,
    "originalQuantity" INTEGER NOT NULL,
    "remainingQuantity" INTEGER NOT NULL,
    "filledQuantity" INTEGER NOT NULL DEFAULT 0,
    "canceledQuantity" INTEGER NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "timeInForce" TEXT NOT NULL DEFAULT 'GTC',
    "postOnly" BOOLEAN NOT NULL DEFAULT false,
    "stpOwnerId" TEXT NOT NULL,
    "selfTradePrevention" TEXT NOT NULL DEFAULT 'CANCEL_AGGRESSOR',
    "reservedCashMilli" BIGINT NOT NULL DEFAULT 0,
    "reservedFeeMilli" BIGINT NOT NULL DEFAULT 0,
    "reservedShares" INTEGER NOT NULL DEFAULT 0,
    "cumulativeFeeMilli" BIGINT NOT NULL DEFAULT 0,
    "acceptedSequence" BIGINT NOT NULL,
    "prioritySequence" BIGINT NOT NULL,
    "terminalSequence" BIGINT,
    "version" INTEGER NOT NULL DEFAULT 0,
    "orderChainId" TEXT NOT NULL,
    "replacementVersion" INTEGER NOT NULL DEFAULT 0,
    "replacedOrderId" TEXT,
    "expiresAt" TIMESTAMPTZ(3),
    "cancelOnPause" BOOLEAN NOT NULL DEFAULT true,
    "reduceOnly" BOOLEAN NOT NULL DEFAULT false,
    "terminalReason" TEXT,
    "terminalAt" TIMESTAMPTZ(3),
    "canceledAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "MarketOrder_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OrderFill" (
    "id" TEXT NOT NULL,
    "marketId" TEXT NOT NULL,
    "makerOrderId" TEXT NOT NULL,
    "takerOrderId" TEXT NOT NULL,
    "canonicalYesPriceMilli" BIGINT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "makerFeeMilli" BIGINT NOT NULL DEFAULT 0,
    "takerFeeMilli" BIGINT NOT NULL DEFAULT 0,
    "matchType" TEXT NOT NULL,
    "commandSequence" BIGINT NOT NULL,
    "tradeSequence" BIGINT NOT NULL,
    "effectIndex" INTEGER NOT NULL,
    "journalEntryId" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OrderFill_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OrderEvent" (
    "id" TEXT NOT NULL,
    "marketId" TEXT NOT NULL,
    "userId" TEXT,
    "commandSequence" BIGINT NOT NULL,
    "eventSequence" BIGINT NOT NULL,
    "effectIndex" INTEGER NOT NULL,
    "type" TEXT NOT NULL,
    "visibility" TEXT NOT NULL DEFAULT 'PUBLIC',
    "payload" TEXT NOT NULL,
    "schemaVersion" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OrderEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OrderCommand" (
    "id" TEXT NOT NULL,
    "marketId" TEXT NOT NULL,
    "actorUserId" TEXT NOT NULL,
    "orderId" TEXT,
    "scope" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "requestHash" TEXT NOT NULL,
    "commandType" TEXT NOT NULL,
    "commandSequence" BIGINT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PROCESSING',
    "responseCode" INTEGER,
    "responseBody" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMPTZ(3),

    CONSTRAINT "OrderCommand_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OrderReservation" (
    "orderId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "marketId" TEXT NOT NULL,
    "cashAccountId" TEXT,
    "reserveJournalId" TEXT,
    "releaseJournalId" TEXT,
    "reservedPrincipalMilli" BIGINT NOT NULL DEFAULT 0,
    "reservedFeeMilli" BIGINT NOT NULL DEFAULT 0,
    "reservedYesQuantity" INTEGER NOT NULL DEFAULT 0,
    "reservedNoQuantity" INTEGER NOT NULL DEFAULT 0,
    "version" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "OrderReservation_pkey" PRIMARY KEY ("orderId")
);

-- CreateTable
CREATE TABLE "LedgerAccount" (
    "id" TEXT NOT NULL,
    "ownerType" TEXT NOT NULL,
    "ownerId" TEXT,
    "purpose" TEXT NOT NULL,
    "balanceMilli" BIGINT NOT NULL DEFAULT 0,
    "allowsNegative" BOOLEAN NOT NULL DEFAULT false,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "LedgerAccount_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "JournalEntry" (
    "id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'POSTED',
    "referenceType" TEXT NOT NULL,
    "referenceId" TEXT NOT NULL,
    "idempotencyScope" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "actorUserId" TEXT,
    "metadata" TEXT NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "postedAt" TIMESTAMPTZ(3) DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "JournalEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LedgerPosting" (
    "id" TEXT NOT NULL,
    "journalEntryId" TEXT NOT NULL,
    "ledgerAccountId" TEXT NOT NULL,
    "amountMilli" BIGINT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LedgerPosting_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TradeQuote" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "marketId" TEXT NOT NULL,
    "side" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "amountMilli" BIGINT NOT NULL,
    "feeMilli" BIGINT NOT NULL DEFAULT 0,
    "marketVersion" INTEGER NOT NULL,
    "maxDebitMilli" BIGINT,
    "minCreditMilli" BIGINT,
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,
    "consumedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TradeQuote_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "IdempotencyRequest" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "route" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "requestHash" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PROCESSING',
    "responseCode" INTEGER,
    "responseBody" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "IdempotencyRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PositionSettlement" (
    "id" TEXT NOT NULL,
    "marketId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "payoutMilli" BIGINT NOT NULL,
    "journalEntryId" TEXT,
    "settlementRunId" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PositionSettlement_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MarketResolutionProposal" (
    "id" TEXT NOT NULL,
    "marketId" TEXT NOT NULL,
    "proposerId" TEXT NOT NULL,
    "approverId" TEXT,
    "outcome" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "evidence" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "reviewNote" TEXT NOT NULL DEFAULT '',
    "idempotencyKey" TEXT NOT NULL,
    "requestHash" TEXT NOT NULL,
    "pendingKey" TEXT,
    "approvalIdempotencyKey" TEXT,
    "approvalRequestHash" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "decidedAt" TIMESTAMPTZ(3),

    CONSTRAINT "MarketResolutionProposal_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MarketSettlementRun" (
    "id" TEXT NOT NULL,
    "marketId" TEXT NOT NULL,
    "proposalId" TEXT NOT NULL,
    "outcome" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "evidence" TEXT NOT NULL,
    "approvedById" TEXT NOT NULL,
    "approvalIdempotencyKey" TEXT NOT NULL,
    "approvalRequestHash" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'READY',
    "cursorPositionId" TEXT,
    "totalPositions" INTEGER NOT NULL,
    "processedCount" INTEGER NOT NULL DEFAULT 0,
    "totalPayoutMilli" BIGINT NOT NULL DEFAULT 0,
    "batchCount" INTEGER NOT NULL DEFAULT 0,
    "claimToken" TEXT,
    "leaseExpiresAt" TIMESTAMPTZ(3),
    "lastError" TEXT,
    "startedAt" TIMESTAMPTZ(3),
    "completedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "MarketSettlementRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WorkerState" (
    "id" TEXT NOT NULL,
    "workerName" TEXT NOT NULL,
    "instanceId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'STARTING',
    "startedAt" TIMESTAMPTZ(3) NOT NULL,
    "lastHeartbeatAt" TIMESTAMPTZ(3) NOT NULL,
    "lastCycleStartedAt" TIMESTAMPTZ(3),
    "lastCycleSucceededAt" TIMESTAMPTZ(3),
    "lastCycleFailedAt" TIMESTAMPTZ(3),
    "stoppedAt" TIMESTAMPTZ(3),
    "consecutiveFailures" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "cycleCount" BIGINT NOT NULL DEFAULT 0,
    "successCount" BIGINT NOT NULL DEFAULT 0,
    "failureCount" BIGINT NOT NULL DEFAULT 0,
    "closedMarketCount" BIGINT NOT NULL DEFAULT 0,
    "completedRunCount" BIGINT NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "WorkerState_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MarketPriceSnapshot" (
    "id" TEXT NOT NULL,
    "marketId" TEXT NOT NULL,
    "yesProbabilityBps" INTEGER NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MarketPriceSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Comment" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "marketId" TEXT NOT NULL,
    "parentId" TEXT,
    "body" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'VISIBLE',
    "positionSideSnapshot" TEXT,
    "positionQtySnapshot" INTEGER,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "Comment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CommentReport" (
    "id" TEXT NOT NULL,
    "commentId" TEXT NOT NULL,
    "reporterId" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "details" TEXT NOT NULL DEFAULT '',
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "resolvedById" TEXT,
    "resolution" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMPTZ(3),

    CONSTRAINT "CommentReport_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WatchlistEntry" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "marketId" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WatchlistEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MarketSuggestion" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "marketId" TEXT,
    "reviewedById" TEXT,
    "reviewNote" TEXT NOT NULL DEFAULT '',
    "reviewedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "MarketSuggestion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RateLimitBucket" (
    "key" TEXT NOT NULL,
    "points" INTEGER NOT NULL DEFAULT 0,
    "resetAt" TIMESTAMPTZ(3) NOT NULL,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "RateLimitBucket_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "AuditLog" (
    "id" TEXT NOT NULL,
    "actorUserId" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "metadata" TEXT NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Notification" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "href" TEXT,
    "readAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Notification_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RegistrationInvite" (
    "id" TEXT NOT NULL,
    "codeHash" TEXT NOT NULL,
    "issuanceKey" TEXT,
    "requestHash" TEXT,
    "label" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "maxUses" INTEGER NOT NULL DEFAULT 1,
    "useCount" INTEGER NOT NULL DEFAULT 0,
    "expiresAt" TIMESTAMPTZ(3),
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RegistrationInvite_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RegistrationInviteClaim" (
    "id" TEXT NOT NULL,
    "inviteId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "claimedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RegistrationInviteClaim_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE UNIQUE INDEX "User_username_key" ON "User"("username");

-- CreateIndex
CREATE INDEX "User_role_status_idx" ON "User"("role", "status");

-- CreateIndex
CREATE INDEX "User_balanceMilli_idx" ON "User"("balanceMilli");

-- CreateIndex
CREATE UNIQUE INDEX "AccountToken_tokenHash_key" ON "AccountToken"("tokenHash");

-- CreateIndex
CREATE INDEX "AccountToken_userId_purpose_consumedAt_idx" ON "AccountToken"("userId", "purpose", "consumedAt");

-- CreateIndex
CREATE INDEX "AccountToken_purpose_expiresAt_idx" ON "AccountToken"("purpose", "expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "Session_tokenHash_key" ON "Session"("tokenHash");

-- CreateIndex
CREATE INDEX "Session_userId_idx" ON "Session"("userId");

-- CreateIndex
CREATE INDEX "Session_expiresAt_idx" ON "Session"("expiresAt");

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
CREATE UNIQUE INDEX "MarketEvent_slug_key" ON "MarketEvent"("slug");

-- CreateIndex
CREATE INDEX "MarketEvent_featured_startsAt_idx" ON "MarketEvent"("featured", "startsAt");

-- CreateIndex
CREATE INDEX "MarketEvent_category_startsAt_idx" ON "MarketEvent"("category", "startsAt");

-- CreateIndex
CREATE INDEX "MarketEvent_startsAt_endsAt_idx" ON "MarketEvent"("startsAt", "endsAt");

-- CreateIndex
CREATE INDEX "MarketEvent_createdById_createdAt_idx" ON "MarketEvent"("createdById", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "MarketEventCreationRequest_eventId_key" ON "MarketEventCreationRequest"("eventId");

-- CreateIndex
CREATE INDEX "MarketEventCreationRequest_createdAt_idx" ON "MarketEventCreationRequest"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "MarketEventCreationRequest_actorUserId_key_key" ON "MarketEventCreationRequest"("actorUserId", "key");

-- CreateIndex
CREATE INDEX "Position_marketId_idx" ON "Position"("marketId");

-- CreateIndex
CREATE UNIQUE INDEX "Position_userId_marketId_key" ON "Position"("userId", "marketId");

-- CreateIndex
CREATE INDEX "Trade_marketId_createdAt_idx" ON "Trade"("marketId", "createdAt");

-- CreateIndex
CREATE INDEX "Trade_userId_createdAt_idx" ON "Trade"("userId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "Trade_userId_idempotencyKey_key" ON "Trade"("userId", "idempotencyKey");

-- CreateIndex
CREATE UNIQUE INDEX "MarketOrder_replacedOrderId_key" ON "MarketOrder"("replacedOrderId");

-- CreateIndex
CREATE INDEX "MarketOrder_marketId_bookSide_status_limitPriceMilli_priori_idx" ON "MarketOrder"("marketId", "bookSide", "status", "limitPriceMilli", "prioritySequence", "id");

-- CreateIndex
CREATE INDEX "MarketOrder_marketId_userId_status_createdAt_id_idx" ON "MarketOrder"("marketId", "userId", "status", "createdAt", "id");

-- CreateIndex
CREATE INDEX "MarketOrder_status_remainingQuantity_expiresAt_id_idx" ON "MarketOrder"("status", "remainingQuantity", "expiresAt", "id");

-- CreateIndex
CREATE UNIQUE INDEX "MarketOrder_userId_clientOrderId_key" ON "MarketOrder"("userId", "clientOrderId");

-- CreateIndex
CREATE UNIQUE INDEX "MarketOrder_marketId_prioritySequence_key" ON "MarketOrder"("marketId", "prioritySequence");

-- CreateIndex
CREATE UNIQUE INDEX "MarketOrder_orderChainId_replacementVersion_key" ON "MarketOrder"("orderChainId", "replacementVersion");

-- CreateIndex
CREATE UNIQUE INDEX "OrderFill_journalEntryId_key" ON "OrderFill"("journalEntryId");

-- CreateIndex
CREATE INDEX "OrderFill_marketId_createdAt_id_idx" ON "OrderFill"("marketId", "createdAt", "id");

-- CreateIndex
CREATE INDEX "OrderFill_makerOrderId_createdAt_id_idx" ON "OrderFill"("makerOrderId", "createdAt", "id");

-- CreateIndex
CREATE INDEX "OrderFill_takerOrderId_createdAt_id_idx" ON "OrderFill"("takerOrderId", "createdAt", "id");

-- CreateIndex
CREATE UNIQUE INDEX "OrderFill_marketId_commandSequence_effectIndex_key" ON "OrderFill"("marketId", "commandSequence", "effectIndex");

-- CreateIndex
CREATE UNIQUE INDEX "OrderFill_marketId_tradeSequence_key" ON "OrderFill"("marketId", "tradeSequence");

-- CreateIndex
CREATE INDEX "OrderEvent_marketId_eventSequence_idx" ON "OrderEvent"("marketId", "eventSequence");

-- CreateIndex
CREATE INDEX "OrderEvent_userId_eventSequence_idx" ON "OrderEvent"("userId", "eventSequence");

-- CreateIndex
CREATE UNIQUE INDEX "OrderEvent_marketId_commandSequence_effectIndex_key" ON "OrderEvent"("marketId", "commandSequence", "effectIndex");

-- CreateIndex
CREATE UNIQUE INDEX "OrderEvent_marketId_eventSequence_key" ON "OrderEvent"("marketId", "eventSequence");

-- CreateIndex
CREATE INDEX "OrderCommand_marketId_commandSequence_idx" ON "OrderCommand"("marketId", "commandSequence");

-- CreateIndex
CREATE INDEX "OrderCommand_orderId_idx" ON "OrderCommand"("orderId");

-- CreateIndex
CREATE UNIQUE INDEX "OrderCommand_actorUserId_scope_idempotencyKey_key" ON "OrderCommand"("actorUserId", "scope", "idempotencyKey");

-- CreateIndex
CREATE UNIQUE INDEX "OrderCommand_marketId_commandSequence_key" ON "OrderCommand"("marketId", "commandSequence");

-- CreateIndex
CREATE UNIQUE INDEX "OrderReservation_reserveJournalId_key" ON "OrderReservation"("reserveJournalId");

-- CreateIndex
CREATE UNIQUE INDEX "OrderReservation_releaseJournalId_key" ON "OrderReservation"("releaseJournalId");

-- CreateIndex
CREATE INDEX "OrderReservation_userId_marketId_idx" ON "OrderReservation"("userId", "marketId");

-- CreateIndex
CREATE INDEX "OrderReservation_cashAccountId_idx" ON "OrderReservation"("cashAccountId");

-- CreateIndex
CREATE INDEX "LedgerAccount_ownerType_ownerId_idx" ON "LedgerAccount"("ownerType", "ownerId");

-- CreateIndex
CREATE UNIQUE INDEX "LedgerAccount_ownerType_ownerId_purpose_key" ON "LedgerAccount"("ownerType", "ownerId", "purpose");

-- CreateIndex
CREATE INDEX "JournalEntry_referenceType_referenceId_idx" ON "JournalEntry"("referenceType", "referenceId");

-- CreateIndex
CREATE INDEX "JournalEntry_actorUserId_createdAt_idx" ON "JournalEntry"("actorUserId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "JournalEntry_idempotencyScope_idempotencyKey_key" ON "JournalEntry"("idempotencyScope", "idempotencyKey");

-- CreateIndex
CREATE INDEX "LedgerPosting_journalEntryId_idx" ON "LedgerPosting"("journalEntryId");

-- CreateIndex
CREATE INDEX "LedgerPosting_ledgerAccountId_createdAt_idx" ON "LedgerPosting"("ledgerAccountId", "createdAt");

-- CreateIndex
CREATE INDEX "TradeQuote_userId_expiresAt_idx" ON "TradeQuote"("userId", "expiresAt");

-- CreateIndex
CREATE INDEX "TradeQuote_marketId_createdAt_idx" ON "TradeQuote"("marketId", "createdAt");

-- CreateIndex
CREATE INDEX "IdempotencyRequest_expiresAt_idx" ON "IdempotencyRequest"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "IdempotencyRequest_userId_route_key_key" ON "IdempotencyRequest"("userId", "route", "key");

-- CreateIndex
CREATE UNIQUE INDEX "PositionSettlement_journalEntryId_key" ON "PositionSettlement"("journalEntryId");

-- CreateIndex
CREATE INDEX "PositionSettlement_userId_createdAt_idx" ON "PositionSettlement"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "PositionSettlement_settlementRunId_createdAt_idx" ON "PositionSettlement"("settlementRunId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "PositionSettlement_marketId_userId_key" ON "PositionSettlement"("marketId", "userId");

-- CreateIndex
CREATE UNIQUE INDEX "MarketResolutionProposal_pendingKey_key" ON "MarketResolutionProposal"("pendingKey");

-- CreateIndex
CREATE INDEX "MarketResolutionProposal_marketId_status_createdAt_idx" ON "MarketResolutionProposal"("marketId", "status", "createdAt");

-- CreateIndex
CREATE INDEX "MarketResolutionProposal_status_createdAt_idx" ON "MarketResolutionProposal"("status", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "MarketResolutionProposal_proposerId_idempotencyKey_key" ON "MarketResolutionProposal"("proposerId", "idempotencyKey");

-- CreateIndex
CREATE UNIQUE INDEX "MarketResolutionProposal_approverId_approvalIdempotencyKey_key" ON "MarketResolutionProposal"("approverId", "approvalIdempotencyKey");

-- CreateIndex
CREATE UNIQUE INDEX "MarketSettlementRun_marketId_key" ON "MarketSettlementRun"("marketId");

-- CreateIndex
CREATE UNIQUE INDEX "MarketSettlementRun_proposalId_key" ON "MarketSettlementRun"("proposalId");

-- CreateIndex
CREATE INDEX "MarketSettlementRun_status_leaseExpiresAt_createdAt_idx" ON "MarketSettlementRun"("status", "leaseExpiresAt", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "MarketSettlementRun_approvedById_approvalIdempotencyKey_key" ON "MarketSettlementRun"("approvedById", "approvalIdempotencyKey");

-- CreateIndex
CREATE UNIQUE INDEX "WorkerState_workerName_key" ON "WorkerState"("workerName");

-- CreateIndex
CREATE INDEX "WorkerState_status_lastHeartbeatAt_idx" ON "WorkerState"("status", "lastHeartbeatAt");

-- CreateIndex
CREATE INDEX "MarketPriceSnapshot_marketId_createdAt_idx" ON "MarketPriceSnapshot"("marketId", "createdAt");

-- CreateIndex
CREATE INDEX "Comment_marketId_createdAt_idx" ON "Comment"("marketId", "createdAt");

-- CreateIndex
CREATE INDEX "Comment_parentId_idx" ON "Comment"("parentId");

-- CreateIndex
CREATE INDEX "CommentReport_status_createdAt_idx" ON "CommentReport"("status", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "CommentReport_commentId_reporterId_key" ON "CommentReport"("commentId", "reporterId");

-- CreateIndex
CREATE UNIQUE INDEX "WatchlistEntry_userId_marketId_key" ON "WatchlistEntry"("userId", "marketId");

-- CreateIndex
CREATE INDEX "MarketSuggestion_status_createdAt_idx" ON "MarketSuggestion"("status", "createdAt");

-- CreateIndex
CREATE INDEX "RateLimitBucket_resetAt_idx" ON "RateLimitBucket"("resetAt");

-- CreateIndex
CREATE INDEX "AuditLog_entityType_entityId_idx" ON "AuditLog"("entityType", "entityId");

-- CreateIndex
CREATE INDEX "AuditLog_actorUserId_createdAt_idx" ON "AuditLog"("actorUserId", "createdAt");

-- CreateIndex
CREATE INDEX "AuditLog_createdAt_id_idx" ON "AuditLog"("createdAt", "id");

-- CreateIndex
CREATE INDEX "Notification_userId_readAt_createdAt_idx" ON "Notification"("userId", "readAt", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "RegistrationInvite_codeHash_key" ON "RegistrationInvite"("codeHash");

-- CreateIndex
CREATE UNIQUE INDEX "RegistrationInvite_issuanceKey_key" ON "RegistrationInvite"("issuanceKey");

-- CreateIndex
CREATE INDEX "RegistrationInvite_status_expiresAt_idx" ON "RegistrationInvite"("status", "expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "RegistrationInviteClaim_userId_key" ON "RegistrationInviteClaim"("userId");

-- CreateIndex
CREATE INDEX "RegistrationInviteClaim_inviteId_claimedAt_idx" ON "RegistrationInviteClaim"("inviteId", "claimedAt");

-- CreateIndex
CREATE UNIQUE INDEX "RegistrationInviteClaim_inviteId_userId_key" ON "RegistrationInviteClaim"("inviteId", "userId");

-- AddForeignKey
ALTER TABLE "AccountToken" ADD CONSTRAINT "AccountToken_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Session" ADD CONSTRAINT "Session_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Market" ADD CONSTRAINT "Market_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Market" ADD CONSTRAINT "Market_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "MarketEvent"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Market" ADD CONSTRAINT "Market_collateralAccountId_fkey" FOREIGN KEY ("collateralAccountId") REFERENCES "LedgerAccount"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MarketEvent" ADD CONSTRAINT "MarketEvent_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MarketEventCreationRequest" ADD CONSTRAINT "MarketEventCreationRequest_actorUserId_fkey" FOREIGN KEY ("actorUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MarketEventCreationRequest" ADD CONSTRAINT "MarketEventCreationRequest_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "MarketEvent"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Position" ADD CONSTRAINT "Position_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Position" ADD CONSTRAINT "Position_marketId_fkey" FOREIGN KEY ("marketId") REFERENCES "Market"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Trade" ADD CONSTRAINT "Trade_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Trade" ADD CONSTRAINT "Trade_marketId_fkey" FOREIGN KEY ("marketId") REFERENCES "Market"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MarketOrder" ADD CONSTRAINT "MarketOrder_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MarketOrder" ADD CONSTRAINT "MarketOrder_marketId_fkey" FOREIGN KEY ("marketId") REFERENCES "Market"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MarketOrder" ADD CONSTRAINT "MarketOrder_replacedOrderId_fkey" FOREIGN KEY ("replacedOrderId") REFERENCES "MarketOrder"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderFill" ADD CONSTRAINT "OrderFill_marketId_fkey" FOREIGN KEY ("marketId") REFERENCES "Market"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderFill" ADD CONSTRAINT "OrderFill_makerOrderId_fkey" FOREIGN KEY ("makerOrderId") REFERENCES "MarketOrder"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderFill" ADD CONSTRAINT "OrderFill_takerOrderId_fkey" FOREIGN KEY ("takerOrderId") REFERENCES "MarketOrder"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderFill" ADD CONSTRAINT "OrderFill_journalEntryId_fkey" FOREIGN KEY ("journalEntryId") REFERENCES "JournalEntry"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderEvent" ADD CONSTRAINT "OrderEvent_marketId_fkey" FOREIGN KEY ("marketId") REFERENCES "Market"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderEvent" ADD CONSTRAINT "OrderEvent_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderCommand" ADD CONSTRAINT "OrderCommand_marketId_fkey" FOREIGN KEY ("marketId") REFERENCES "Market"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderCommand" ADD CONSTRAINT "OrderCommand_actorUserId_fkey" FOREIGN KEY ("actorUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderCommand" ADD CONSTRAINT "OrderCommand_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "MarketOrder"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderReservation" ADD CONSTRAINT "OrderReservation_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "MarketOrder"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderReservation" ADD CONSTRAINT "OrderReservation_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderReservation" ADD CONSTRAINT "OrderReservation_marketId_fkey" FOREIGN KEY ("marketId") REFERENCES "Market"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderReservation" ADD CONSTRAINT "OrderReservation_cashAccountId_fkey" FOREIGN KEY ("cashAccountId") REFERENCES "LedgerAccount"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JournalEntry" ADD CONSTRAINT "JournalEntry_actorUserId_fkey" FOREIGN KEY ("actorUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LedgerPosting" ADD CONSTRAINT "LedgerPosting_journalEntryId_fkey" FOREIGN KEY ("journalEntryId") REFERENCES "JournalEntry"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LedgerPosting" ADD CONSTRAINT "LedgerPosting_ledgerAccountId_fkey" FOREIGN KEY ("ledgerAccountId") REFERENCES "LedgerAccount"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TradeQuote" ADD CONSTRAINT "TradeQuote_marketId_fkey" FOREIGN KEY ("marketId") REFERENCES "Market"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PositionSettlement" ADD CONSTRAINT "PositionSettlement_marketId_fkey" FOREIGN KEY ("marketId") REFERENCES "Market"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PositionSettlement" ADD CONSTRAINT "PositionSettlement_settlementRunId_fkey" FOREIGN KEY ("settlementRunId") REFERENCES "MarketSettlementRun"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MarketResolutionProposal" ADD CONSTRAINT "MarketResolutionProposal_marketId_fkey" FOREIGN KEY ("marketId") REFERENCES "Market"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MarketResolutionProposal" ADD CONSTRAINT "MarketResolutionProposal_proposerId_fkey" FOREIGN KEY ("proposerId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MarketResolutionProposal" ADD CONSTRAINT "MarketResolutionProposal_approverId_fkey" FOREIGN KEY ("approverId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MarketSettlementRun" ADD CONSTRAINT "MarketSettlementRun_marketId_fkey" FOREIGN KEY ("marketId") REFERENCES "Market"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MarketSettlementRun" ADD CONSTRAINT "MarketSettlementRun_proposalId_fkey" FOREIGN KEY ("proposalId") REFERENCES "MarketResolutionProposal"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MarketSettlementRun" ADD CONSTRAINT "MarketSettlementRun_approvedById_fkey" FOREIGN KEY ("approvedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MarketPriceSnapshot" ADD CONSTRAINT "MarketPriceSnapshot_marketId_fkey" FOREIGN KEY ("marketId") REFERENCES "Market"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Comment" ADD CONSTRAINT "Comment_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Comment" ADD CONSTRAINT "Comment_marketId_fkey" FOREIGN KEY ("marketId") REFERENCES "Market"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Comment" ADD CONSTRAINT "Comment_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "Comment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CommentReport" ADD CONSTRAINT "CommentReport_commentId_fkey" FOREIGN KEY ("commentId") REFERENCES "Comment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CommentReport" ADD CONSTRAINT "CommentReport_reporterId_fkey" FOREIGN KEY ("reporterId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CommentReport" ADD CONSTRAINT "CommentReport_resolvedById_fkey" FOREIGN KEY ("resolvedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WatchlistEntry" ADD CONSTRAINT "WatchlistEntry_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WatchlistEntry" ADD CONSTRAINT "WatchlistEntry_marketId_fkey" FOREIGN KEY ("marketId") REFERENCES "Market"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MarketSuggestion" ADD CONSTRAINT "MarketSuggestion_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MarketSuggestion" ADD CONSTRAINT "MarketSuggestion_reviewedById_fkey" FOREIGN KEY ("reviewedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MarketSuggestion" ADD CONSTRAINT "MarketSuggestion_marketId_fkey" FOREIGN KEY ("marketId") REFERENCES "Market"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_actorUserId_fkey" FOREIGN KEY ("actorUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RegistrationInvite" ADD CONSTRAINT "RegistrationInvite_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RegistrationInviteClaim" ADD CONSTRAINT "RegistrationInviteClaim_inviteId_fkey" FOREIGN KEY ("inviteId") REFERENCES "RegistrationInvite"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RegistrationInviteClaim" ADD CONSTRAINT "RegistrationInviteClaim_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
