-- Sole statement so CREATE INDEX CONCURRENTLY runs outside an implicit
-- transaction. Deleting a task cascades to its runs by taskId, which scanned
-- the whole runs table without this index.
CREATE INDEX CONCURRENTLY "runs_taskId_idx" ON "runs"("taskId");
