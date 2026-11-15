-- Sole statement so CREATE INDEX CONCURRENTLY runs outside an implicit
-- transaction. The job reconciler pages bot-message runs whose outcome has not
-- been returned in updatedAt order; only those few runs belong in the index.
CREATE INDEX CONCURRENTLY "runs_bot_outcome_pending_idx"
ON "runs" ("updatedAt", "id")
WHERE "trigger" = 'bot_message' AND "botOutcomeReturnedAt" IS NULL;
