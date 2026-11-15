-- Archive is the safe default. Permanent deletion keeps a workspace-scoped audit
-- record and can optionally preserve bot memory as shared user memory.
ALTER TABLE "bots" ADD COLUMN "archivedAt" TIMESTAMP(3);

CREATE TABLE "bot_deletions" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "deletedByUserId" TEXT NOT NULL,
    "memoriesPreserved" BOOLEAN NOT NULL,
    "deletedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "bot_deletions_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "bot_deletions_workspaceId_deletedAt_idx"
ON "bot_deletions"("workspaceId", "deletedAt");

CREATE INDEX "bots_workspaceId_userId_archivedAt_pinned_updatedAt_idx"
ON "bots"("workspaceId", "userId", "archivedAt", "pinned", "updatedAt");

DROP INDEX "bots_workspaceId_userId_pinned_updatedAt_idx";

ALTER TABLE "bot_deletions" ADD CONSTRAINT "bot_deletions_workspaceId_fkey"
FOREIGN KEY ("workspaceId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
