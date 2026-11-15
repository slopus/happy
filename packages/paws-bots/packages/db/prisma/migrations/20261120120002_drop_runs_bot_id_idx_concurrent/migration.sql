-- Sole statement so DROP INDEX CONCURRENTLY runs outside an implicit transaction.
-- runs_botId_createdAt_idx leads with botId and serves every bot-only lookup.
DROP INDEX CONCURRENTLY IF EXISTS "runs_botId_idx";
