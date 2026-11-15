ALTER TABLE "bots" ADD COLUMN "spawnKey" TEXT;

CREATE UNIQUE INDEX "bots_workspaceId_spawnKey_key" ON "bots"("workspaceId", "spawnKey");
