ALTER TABLE "computers" ADD COLUMN "maintenanceId" TEXT;
CREATE TABLE "computer_updates" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "computerId" TEXT NOT NULL REFERENCES "computers"("id") ON DELETE CASCADE,
  "botId" TEXT NOT NULL,
  "action" TEXT NOT NULL DEFAULT 'update',
  "status" TEXT NOT NULL DEFAULT 'queued',
  "stage" TEXT NOT NULL DEFAULT 'preparing',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL
);
CREATE INDEX "computer_updates_computerId_createdAt_idx" ON "computer_updates"("computerId", "createdAt");
CREATE INDEX "computer_updates_status_updatedAt_idx" ON "computer_updates"("status", "updatedAt");
