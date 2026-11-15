-- Sole statement in this migration so it runs outside an implicit
-- transaction: CREATE INDEX CONCURRENTLY errors inside one, and only
-- applies concurrently as a top-level statement (see prior migration).
CREATE UNIQUE INDEX CONCURRENTLY "runs_retryOfRunId_key" ON "runs"("retryOfRunId");
