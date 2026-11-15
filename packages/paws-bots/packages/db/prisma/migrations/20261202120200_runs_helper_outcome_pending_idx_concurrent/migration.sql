-- Sole statement so CREATE INDEX CONCURRENTLY runs outside an implicit
-- transaction. The job reconciler pages background-helper runs whose outcome has
-- not been returned in updatedAt order; only those few runs belong in the index.
CREATE INDEX CONCURRENTLY "runs_helper_outcome_pending_idx"
ON "runs" ("updatedAt", "id")
WHERE "trigger" = 'helper' AND "botOutcomeReturnedAt" IS NULL
  AND "status" IN ('completed', 'failed', 'cancelled');
