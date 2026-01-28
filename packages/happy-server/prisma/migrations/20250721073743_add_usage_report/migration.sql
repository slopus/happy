-- CreateTable
CREATE TABLE "UsageReport" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "sessionId" TEXT,
    "data" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "UsageReport_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "UsageReport_accountId_idx" ON "UsageReport"("accountId");

-- CreateIndex
CREATE INDEX "UsageReport_sessionId_idx" ON "UsageReport"("sessionId");

-- CreateIndex
CREATE UNIQUE INDEX "UsageReport_accountId_sessionId_key_key" ON "UsageReport"("accountId", "sessionId", "key");

-- AddForeignKey
ALTER TABLE "UsageReport" ADD CONSTRAINT "UsageReport_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UsageReport" ADD CONSTRAINT "UsageReport_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "Session"("id") ON DELETE SET NULL ON UPDATE CASCADE;
