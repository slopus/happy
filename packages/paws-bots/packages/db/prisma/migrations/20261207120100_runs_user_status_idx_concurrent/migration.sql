-- Sole statement so CREATE INDEX CONCURRENTLY runs outside an implicit
-- transaction. A phone's live status card reads one user's active runs.
CREATE INDEX CONCURRENTLY "runs_userId_status_createdAt_idx"
ON "runs" ("userId", "status", "createdAt");
