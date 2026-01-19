-- CreateTable
CREATE TABLE "AccessKey" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "machineId" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "data" TEXT NOT NULL,
    "dataVersion" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AccessKey_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AccessKey_accountId_idx" ON "AccessKey"("accountId");

-- CreateIndex
CREATE INDEX "AccessKey_sessionId_idx" ON "AccessKey"("sessionId");

-- CreateIndex
CREATE INDEX "AccessKey_machineId_idx" ON "AccessKey"("machineId");

-- CreateIndex
CREATE UNIQUE INDEX "AccessKey_accountId_machineId_sessionId_key" ON "AccessKey"("accountId", "machineId", "sessionId");

-- AddForeignKey
ALTER TABLE "AccessKey" ADD CONSTRAINT "AccessKey_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AccessKey" ADD CONSTRAINT "AccessKey_accountId_machineId_fkey" FOREIGN KEY ("accountId", "machineId") REFERENCES "Machine"("accountId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AccessKey" ADD CONSTRAINT "AccessKey_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "Session"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
