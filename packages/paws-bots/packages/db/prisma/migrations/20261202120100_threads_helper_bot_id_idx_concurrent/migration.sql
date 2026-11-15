-- Sole statement so CREATE INDEX CONCURRENTLY runs outside an implicit
-- transaction. Deleting a bot finds the threads of its background helpers.
CREATE INDEX CONCURRENTLY "threads_helperBotId_idx" ON "threads" ("helperBotId");
