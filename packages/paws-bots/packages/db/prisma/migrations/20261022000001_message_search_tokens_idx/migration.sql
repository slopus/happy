-- Sole statement so the index builds outside an implicit transaction.
CREATE INDEX CONCURRENTLY "messages_searchTokens_idx" ON "messages" USING GIN ("searchTokens");
