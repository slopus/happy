-- Additive: the previous release never reads these tables.
CREATE TABLE "payment_wallets" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "ciphertext" TEXT NOT NULL,
    "verificationUrl" TEXT,
    "userCode" TEXT,
    "expiresAt" TIMESTAMP(3),
    "nextPollAt" TIMESTAMP(3),
    "pollIntervalMs" INTEGER,
    "refreshAt" TIMESTAMP(3),
    "connectedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "payment_wallets_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "payment_wallets_userId_key" ON "payment_wallets"("userId");

ALTER TABLE "payment_wallets" ADD CONSTRAINT "payment_wallets_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "purchases" (
    "id" TEXT NOT NULL,
    "operationKey" TEXT NOT NULL,
    "spaceId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "botId" TEXT NOT NULL,
    "threadId" TEXT NOT NULL,
    "threadGeneration" INTEGER NOT NULL,
    "provider" TEXT NOT NULL,
    "remoteId" TEXT NOT NULL,
    "merchantName" TEXT NOT NULL,
    "merchantUrl" TEXT NOT NULL,
    "amount" INTEGER NOT NULL,
    "currency" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "approvalUrl" TEXT,
    "nextPollAt" TIMESTAMP(3),
    "wokenStatus" TEXT,
    "cardCiphertext" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "purchases_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "purchases_operationKey_key" ON "purchases"("operationKey");
CREATE INDEX "purchases_nextPollAt_idx" ON "purchases"("nextPollAt");
CREATE INDEX "purchases_spaceId_userId_createdAt_idx" ON "purchases"("spaceId", "userId", "createdAt");

ALTER TABLE "purchases" ADD CONSTRAINT "purchases_spaceId_fkey" FOREIGN KEY ("spaceId") REFERENCES "spaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Same policies as user_voice_credentials and model_oauth_sessions.
ALTER TABLE "payment_wallets" ENABLE ROW LEVEL SECURITY;
CREATE POLICY payment_wallets_tenant ON "payment_wallets"
  USING ("userId" = NULLIF(current_setting('app.user_id', true), ''));
CREATE POLICY payment_wallets_system ON "payment_wallets"
  USING (current_setting('app.rls_bypass', true) = 'on');

ALTER TABLE "purchases" ENABLE ROW LEVEL SECURITY;
CREATE POLICY purchases_tenant ON "purchases"
  USING ("spaceId" = NULLIF(current_setting('app.space_id', true), ''));
CREATE POLICY purchases_system ON "purchases"
  USING (current_setting('app.rls_bypass', true) = 'on');
