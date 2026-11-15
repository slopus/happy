ALTER TABLE "bots" ADD COLUMN "pinned" BOOLEAN NOT NULL DEFAULT false;

DROP INDEX "bots_workspaceId_userId_idx";

CREATE INDEX "bots_workspaceId_userId_pinned_updatedAt_idx"
ON "bots"("workspaceId", "userId", "pinned", "updatedAt");
