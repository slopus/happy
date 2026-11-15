-- Sole statement so CREATE INDEX CONCURRENTLY runs outside an implicit
-- transaction (see prior concurrent index migrations).
CREATE INDEX CONCURRENTLY "external_messages_externalConversationId_senderIsBot_create_idx" ON "external_messages"("externalConversationId", "senderIsBot", "createdAt");
