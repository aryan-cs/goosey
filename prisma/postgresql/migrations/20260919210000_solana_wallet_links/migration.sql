CREATE TABLE "SolanaWalletLinkChallenge" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "sessionId" TEXT NOT NULL,
  "purpose" TEXT NOT NULL DEFAULT 'LINK_WALLET',
  "origin" TEXT NOT NULL,
  "domain" TEXT NOT NULL,
  "uri" TEXT NOT NULL,
  "chainId" TEXT NOT NULL,
  "genesisHash" TEXT NOT NULL,
  "walletAddress" TEXT NOT NULL,
  "nonceHash" TEXT NOT NULL,
  "messageHash" TEXT NOT NULL,
  "issuedAt" TIMESTAMPTZ(3) NOT NULL,
  "expiresAt" TIMESTAMPTZ(3) NOT NULL,
  "consumedAt" TIMESTAMPTZ(3),
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "SolanaWalletLinkChallenge_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "SolanaWalletLink" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "chainId" TEXT NOT NULL,
  "genesisHash" TEXT NOT NULL,
  "walletAddress" TEXT NOT NULL,
  "verifiedAt" TIMESTAMPTZ(3) NOT NULL,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "SolanaWalletLink_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "SolanaWalletLinkChallenge_nonceHash_key" ON "SolanaWalletLinkChallenge"("nonceHash");
CREATE INDEX "SolanaWalletLinkChallenge_userId_sessionId_consumedAt_idx" ON "SolanaWalletLinkChallenge"("userId", "sessionId", "consumedAt");
CREATE INDEX "SolanaWalletLinkChallenge_expiresAt_idx" ON "SolanaWalletLinkChallenge"("expiresAt");
CREATE UNIQUE INDEX "SolanaWalletLink_chainId_genesisHash_walletAddress_key" ON "SolanaWalletLink"("chainId", "genesisHash", "walletAddress");
CREATE UNIQUE INDEX "SolanaWalletLink_userId_chainId_genesisHash_key" ON "SolanaWalletLink"("userId", "chainId", "genesisHash");
CREATE INDEX "SolanaWalletLink_userId_idx" ON "SolanaWalletLink"("userId");

ALTER TABLE "SolanaWalletLinkChallenge" ADD CONSTRAINT "SolanaWalletLinkChallenge_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "SolanaWalletLink" ADD CONSTRAINT "SolanaWalletLink_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
