-- Sole statement so CREATE INDEX CONCURRENTLY runs outside an implicit
-- transaction. Bot deletes cascade to runs and the execution lease fence reads
-- runs by botId alone; (spaceId, botId) cannot serve either.
CREATE INDEX CONCURRENTLY "runs_botId_idx" ON "runs"("botId");
