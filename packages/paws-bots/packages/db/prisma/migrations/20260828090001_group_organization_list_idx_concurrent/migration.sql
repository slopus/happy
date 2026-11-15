CREATE INDEX CONCURRENTLY IF NOT EXISTS "chat_groups_workspaceId_userId_archivedAt_pinned_updatedAt_idx" ON "chat_groups"("workspaceId", "userId", "archivedAt", "pinned", "updatedAt");
