-- Reply lookups happen on active threads, so build the index without blocking message writes.
CREATE INDEX CONCURRENTLY "messages_replyToMessageId_idx"
ON "messages"("replyToMessageId");
