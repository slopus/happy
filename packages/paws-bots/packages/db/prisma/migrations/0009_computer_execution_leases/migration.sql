-- Per-bot Team Computer execution leases so two Team bots can run at once
-- without sharing one computer-wide fence.
CREATE TABLE "computer_execution_leases" (
    "id" TEXT NOT NULL,
    "computerId" TEXT NOT NULL,
    "botId" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "fence" INTEGER NOT NULL DEFAULT 0,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "computer_execution_leases_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "computer_execution_leases_computerId_botId_key"
ON "computer_execution_leases"("computerId", "botId");

CREATE INDEX "computer_execution_leases_runId_idx"
ON "computer_execution_leases"("runId");

CREATE INDEX "computer_execution_leases_computerId_expiresAt_idx"
ON "computer_execution_leases"("computerId", "expiresAt");

ALTER TABLE "computer_execution_leases"
ADD CONSTRAINT "computer_execution_leases_computerId_fkey"
FOREIGN KEY ("computerId") REFERENCES "computers"("id") ON DELETE CASCADE ON UPDATE CASCADE;
