CREATE TABLE "cloud_agents" (
  "id" TEXT NOT NULL,
  "operationKey" TEXT NOT NULL,
  "providerKey" TEXT NOT NULL,
  "spaceId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "botId" TEXT NOT NULL,
  "threadId" TEXT NOT NULL,
  "messageId" TEXT,
  "remoteId" TEXT,
  "latestRunId" TEXT,
  "title" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'running',
  "url" TEXT NOT NULL DEFAULT '',
  "branch" TEXT,
  "prUrl" TEXT,
  "launchRequest" JSONB NOT NULL,
  "launchDispatched" BOOLEAN NOT NULL DEFAULT false,
  "followup" JSONB,
  "followupDispatching" BOOLEAN NOT NULL DEFAULT false,
  "cancelRequested" BOOLEAN NOT NULL DEFAULT false,
  "generation" INTEGER NOT NULL DEFAULT 0,
  "wakeGeneration" INTEGER NOT NULL DEFAULT -1,
  "version" INTEGER NOT NULL DEFAULT 0,
  "leaseToken" TEXT,
  "leaseExpiresAt" TIMESTAMP(3),
  "nextPollAt" TIMESTAMP(3) DEFAULT CURRENT_TIMESTAMP,
  "errorCount" INTEGER NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "cloud_agents_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "cloud_agents_operationKey_key" ON "cloud_agents"("operationKey");
CREATE INDEX "cloud_agents_providerKey_nextPollAt_idx" ON "cloud_agents"("providerKey", "nextPollAt");
CREATE INDEX "cloud_agents_spaceId_userId_id_idx" ON "cloud_agents"("spaceId", "userId", "id");
