-- AlterTable
ALTER TABLE "bots" ADD COLUMN     "memoryScope" TEXT;

-- AddConstraint
ALTER TABLE "bots" ADD CONSTRAINT "bots_memoryScope_check" CHECK ("memoryScope" IS NULL OR "memoryScope" IN ('isolated', 'shared')) NOT VALID;

-- CreateTable
CREATE TABLE "workspace_memory_configs" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "mode" TEXT NOT NULL,
    "baseUrl" TEXT NOT NULL,
    "secretId" TEXT NOT NULL,
    "defaultMemoryScope" TEXT NOT NULL DEFAULT 'isolated',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "workspace_memory_configs_pkey" PRIMARY KEY ("id")
);

-- AddConstraint
ALTER TABLE "workspace_memory_configs" ADD CONSTRAINT "workspace_memory_configs_mode_check" CHECK ("mode" IN ('cloud', 'local'));

-- AddConstraint
ALTER TABLE "workspace_memory_configs" ADD CONSTRAINT "workspace_memory_configs_defaultMemoryScope_check" CHECK ("defaultMemoryScope" IN ('isolated', 'shared'));

-- CreateIndex
CREATE UNIQUE INDEX "workspace_memory_configs_workspaceId_key" ON "workspace_memory_configs"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "workspace_memory_configs_secretId_key" ON "workspace_memory_configs"("secretId");

-- AddForeignKey
ALTER TABLE "workspace_memory_configs" ADD CONSTRAINT "workspace_memory_configs_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workspace_memory_configs" ADD CONSTRAINT "workspace_memory_configs_secretId_fkey" FOREIGN KEY ("secretId") REFERENCES "secrets"("id") ON DELETE CASCADE ON UPDATE CASCADE;
