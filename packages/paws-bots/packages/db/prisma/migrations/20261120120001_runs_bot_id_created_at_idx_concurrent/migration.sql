-- Sole statement so CREATE INDEX CONCURRENTLY runs outside an implicit
-- transaction. The saved home retention sweep reads each bot's latest run.
CREATE INDEX CONCURRENTLY "runs_botId_createdAt_idx" ON "runs" ("botId", "createdAt");
