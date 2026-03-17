-- AlterTable
ALTER TABLE "OrchestratorTask" ADD COLUMN     "dependsOnTaskKeys" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "nextAttemptAt" TIMESTAMP(3),
ADD COLUMN     "retryBackoffMs" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "retryMaxAttempts" INTEGER NOT NULL DEFAULT 1;

-- CreateIndex
CREATE INDEX "OrchestratorTask_runId_status_nextAttemptAt_seq_idx" ON "OrchestratorTask"("runId", "status", "nextAttemptAt", "seq");
