-- Sole statement so CREATE INDEX CONCURRENTLY runs outside an implicit transaction.
CREATE INDEX CONCURRENTLY IF NOT EXISTS "external_messages_externalConversationId_senderId_judgedAt_idx" ON "external_messages"("externalConversationId", "senderId", "judgedAt");
