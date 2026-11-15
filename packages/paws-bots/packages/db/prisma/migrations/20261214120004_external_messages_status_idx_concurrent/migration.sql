-- Sole statement so CREATE INDEX CONCURRENTLY runs outside an implicit transaction.
CREATE INDEX CONCURRENTLY IF NOT EXISTS "external_messages_externalConversationId_status_createdAt_idx" ON "external_messages"("externalConversationId", "status", "createdAt");
