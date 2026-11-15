-- Duplicates the messages_threadId_seq_key unique index.
DROP INDEX CONCURRENTLY IF EXISTS "messages_threadId_seq_idx";
