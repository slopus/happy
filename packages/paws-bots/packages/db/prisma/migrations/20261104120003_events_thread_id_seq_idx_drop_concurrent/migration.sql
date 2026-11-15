-- Duplicates the events_threadId_seq_key unique index.
DROP INDEX CONCURRENTLY IF EXISTS "events_threadId_seq_idx";
