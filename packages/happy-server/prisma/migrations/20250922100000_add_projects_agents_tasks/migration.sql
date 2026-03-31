-- CreateEnum
DO $$ BEGIN
    CREATE TYPE "TaskStatus" AS ENUM ('running', 'waiting_for_permission', 'done', 'failed');
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

-- CreateTable
CREATE TABLE IF NOT EXISTS "Agent" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "avatar" TEXT,
    "agentType" TEXT NOT NULL,
    "systemPrompt" TEXT,
    "model" TEXT,
    "permissionMode" TEXT,
    "allowedTools" JSONB,
    "disallowedTools" JSONB,
    "mcpServers" JSONB,
    "environmentVariables" JSONB,
    "maxTurns" INTEGER,
    "autoTerminate" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Agent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "Project" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "workingDirectory" TEXT,
    "machineId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Project_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "ProjectAgent" (
    "projectId" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,

    CONSTRAINT "ProjectAgent_pkey" PRIMARY KEY ("projectId","agentId")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "Task" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "status" "TaskStatus" NOT NULL DEFAULT 'running',
    "happySessionId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "Task_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX IF NOT EXISTS "Agent_accountId_idx" ON "Agent"("accountId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "Project_accountId_idx" ON "Project"("accountId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "ProjectAgent_projectId_idx" ON "ProjectAgent"("projectId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "ProjectAgent_agentId_idx" ON "ProjectAgent"("agentId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "Task_projectId_idx" ON "Task"("projectId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "Task_agentId_idx" ON "Task"("agentId");

-- AddForeignKey
ALTER TABLE "Agent" ADD CONSTRAINT "Agent_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Project" ADD CONSTRAINT "Project_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProjectAgent" ADD CONSTRAINT "ProjectAgent_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProjectAgent" ADD CONSTRAINT "ProjectAgent_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "Agent"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Task" ADD CONSTRAINT "Task_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Task" ADD CONSTRAINT "Task_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "Agent"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
