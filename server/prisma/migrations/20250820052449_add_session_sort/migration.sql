-- CreateIndex
CREATE INDEX "Session_accountId_updatedAt_idx" ON "Session"("accountId", "updatedAt" DESC);
