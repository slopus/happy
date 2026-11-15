-- Sole statement so CREATE INDEX CONCURRENTLY runs outside an implicit
-- transaction. The bot list reads each bot thread's latest run.
CREATE INDEX CONCURRENTLY "runs_threadId_createdAt_id_idx" ON "runs" ("threadId", "createdAt", "id");
