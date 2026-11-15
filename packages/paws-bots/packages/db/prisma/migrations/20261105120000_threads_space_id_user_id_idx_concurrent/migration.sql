-- Sole statement so CREATE INDEX CONCURRENTLY runs outside an implicit
-- transaction. Cross-chat history search finds a user's own threads in a space.
CREATE INDEX CONCURRENTLY "threads_spaceId_userId_idx" ON "threads" ("spaceId", "userId");
