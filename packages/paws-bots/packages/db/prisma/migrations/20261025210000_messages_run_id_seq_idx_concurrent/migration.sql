-- Sole statement so CREATE INDEX CONCURRENTLY runs outside an implicit
-- transaction. Run replies are read by runId; without this every read scanned
-- the whole messages table.
CREATE INDEX CONCURRENTLY "messages_runId_seq_idx" ON "messages"("runId", "seq");
