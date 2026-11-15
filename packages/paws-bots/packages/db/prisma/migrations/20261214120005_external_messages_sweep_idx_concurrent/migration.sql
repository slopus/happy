-- Sole statement so CREATE INDEX CONCURRENTLY runs outside an implicit transaction.
CREATE INDEX CONCURRENTLY IF NOT EXISTS "external_messages_status_updatedAt_idx" ON "external_messages"("status", "updatedAt");
