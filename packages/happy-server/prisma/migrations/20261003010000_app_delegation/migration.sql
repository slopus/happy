-- CreateTable
CREATE TABLE "AppDelegation" (
    "id" TEXT NOT NULL,
    "appId" TEXT NOT NULL,
    "storedBytes" INTEGER NOT NULL DEFAULT 0,
    "challengeHash" TEXT NOT NULL,
    "publicKey" TEXT NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'pending',
    "requestExpiresAt" TIMESTAMP(3) NOT NULL,
    "accountId" TEXT,
    "machineId" TEXT,
    "expiresAt" TIMESTAMP(3),
    "credentialHash" TEXT,
    "appEnvelope" TEXT,
    "machineEnvelope" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AppDelegation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AppChatWorker" (
    "machineId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "protocol" INTEGER NOT NULL,
    "activeUntil" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AppChatWorker_pkey" PRIMARY KEY ("machineId")
);

-- CreateTable
CREATE TABLE "AppChatConversation" (
    "id" TEXT NOT NULL,
    "grantId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AppChatConversation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AppChatTurn" (
    "id" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "input" TEXT NOT NULL,
    "output" TEXT,
    "sequence" INTEGER NOT NULL DEFAULT 0,
    "state" TEXT NOT NULL DEFAULT 'queued',
    "lease" TEXT,
    "leaseUntil" TIMESTAMP(3),
    "deadline" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AppChatTurn_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AppDelegation_accountId_createdAt_idx" ON "AppDelegation"("accountId", "createdAt");

-- CreateIndex
CREATE INDEX "AppDelegation_requestExpiresAt_idx" ON "AppDelegation"("requestExpiresAt");

-- CreateIndex
CREATE INDEX "AppChatConversation_grantId_createdAt_idx" ON "AppChatConversation"("grantId", "createdAt");

-- CreateIndex
CREATE INDEX "AppChatTurn_conversationId_createdAt_idx" ON "AppChatTurn"("conversationId", "createdAt");

-- CreateIndex
CREATE INDEX "AppChatTurn_state_createdAt_idx" ON "AppChatTurn"("state", "createdAt");

-- AddForeignKey
ALTER TABLE "AppDelegation" ADD CONSTRAINT "AppDelegation_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AppChatWorker" ADD CONSTRAINT "AppChatWorker_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AppChatConversation" ADD CONSTRAINT "AppChatConversation_grantId_fkey" FOREIGN KEY ("grantId") REFERENCES "AppDelegation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AppChatTurn" ADD CONSTRAINT "AppChatTurn_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "AppChatConversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;
