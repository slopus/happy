-- CreateTable
CREATE TABLE "OrchestratorRun" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "controllerSessionId" TEXT,
    "title" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "maxConcurrency" INTEGER NOT NULL DEFAULT 2,
    "idempotencyKey" TEXT,
    "metadata" JSONB,
    "cancelRequestedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OrchestratorRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OrchestratorTask" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "seq" INTEGER NOT NULL,
    "taskKey" TEXT,
    "title" TEXT,
    "provider" TEXT NOT NULL,
    "prompt" TEXT NOT NULL,
    "timeoutMs" INTEGER,
    "targetMachineId" TEXT,
    "status" TEXT NOT NULL,
    "outputSummary" TEXT,
    "outputText" TEXT,
    "errorCode" TEXT,
    "errorMessage" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OrchestratorTask_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OrchestratorExecution" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "taskId" TEXT NOT NULL,
    "workerSessionId" TEXT,
    "machineId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "attempt" INTEGER NOT NULL DEFAULT 1,
    "dispatchToken" TEXT NOT NULL,
    "timeoutMs" INTEGER,
    "pid" INTEGER,
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "exitCode" INTEGER,
    "signal" TEXT,
    "outputSummary" TEXT,
    "outputText" TEXT,
    "errorCode" TEXT,
    "errorMessage" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OrchestratorExecution_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "OrchestratorRun_accountId_idempotencyKey_key" ON "OrchestratorRun"("accountId", "idempotencyKey");

-- CreateIndex
CREATE INDEX "OrchestratorRun_accountId_createdAt_idx" ON "OrchestratorRun"("accountId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "OrchestratorRun_accountId_status_updatedAt_idx" ON "OrchestratorRun"("accountId", "status", "updatedAt" DESC);

-- CreateIndex
CREATE INDEX "OrchestratorRun_controllerSessionId_idx" ON "OrchestratorRun"("controllerSessionId");

-- CreateIndex
CREATE UNIQUE INDEX "OrchestratorTask_runId_seq_key" ON "OrchestratorTask"("runId", "seq");

-- CreateIndex
CREATE UNIQUE INDEX "OrchestratorTask_runId_taskKey_key" ON "OrchestratorTask"("runId", "taskKey");

-- CreateIndex
CREATE INDEX "OrchestratorTask_runId_status_seq_idx" ON "OrchestratorTask"("runId", "status", "seq");

-- CreateIndex
CREATE INDEX "OrchestratorTask_targetMachineId_idx" ON "OrchestratorTask"("targetMachineId");

-- CreateIndex
CREATE UNIQUE INDEX "OrchestratorExecution_dispatchToken_key" ON "OrchestratorExecution"("dispatchToken");

-- CreateIndex
CREATE INDEX "OrchestratorExecution_runId_status_createdAt_idx" ON "OrchestratorExecution"("runId", "status", "createdAt");

-- CreateIndex
CREATE INDEX "OrchestratorExecution_taskId_status_createdAt_idx" ON "OrchestratorExecution"("taskId", "status", "createdAt");

-- CreateIndex
CREATE INDEX "OrchestratorExecution_machineId_status_createdAt_idx" ON "OrchestratorExecution"("machineId", "status", "createdAt");

-- CreateIndex
CREATE INDEX "OrchestratorExecution_workerSessionId_idx" ON "OrchestratorExecution"("workerSessionId");

-- AddForeignKey
ALTER TABLE "OrchestratorRun" ADD CONSTRAINT "OrchestratorRun_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrchestratorRun" ADD CONSTRAINT "OrchestratorRun_controllerSessionId_fkey" FOREIGN KEY ("controllerSessionId") REFERENCES "Session"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrchestratorTask" ADD CONSTRAINT "OrchestratorTask_runId_fkey" FOREIGN KEY ("runId") REFERENCES "OrchestratorRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrchestratorExecution" ADD CONSTRAINT "OrchestratorExecution_runId_fkey" FOREIGN KEY ("runId") REFERENCES "OrchestratorRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrchestratorExecution" ADD CONSTRAINT "OrchestratorExecution_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "OrchestratorTask"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrchestratorExecution" ADD CONSTRAINT "OrchestratorExecution_workerSessionId_fkey" FOREIGN KEY ("workerSessionId") REFERENCES "Session"("id") ON DELETE SET NULL ON UPDATE CASCADE;
