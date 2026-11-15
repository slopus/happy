-- Sole statement so CREATE INDEX CONCURRENTLY runs outside an implicit
-- transaction. Matches listSpaceRuns("recent"): terminal, non-ticket runs.
CREATE INDEX CONCURRENTLY "runs_recent_activity_idx"
ON "runs" ("spaceId", "userId", "completedAt" DESC, "updatedAt" DESC, "id" DESC)
WHERE "status" IN ('completed', 'failed', 'cancelled')
  AND "trigger" NOT IN ('tickets');
