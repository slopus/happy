-- deferred
-- Read state lives in thread_reads (20261202120000_thread_reads). The release that wrote it on
-- the thread has stopped, so its columns and the trigger that mirrored them go.
DROP TRIGGER IF EXISTS threads_mirror_unread ON "threads";
DROP FUNCTION IF EXISTS thread_reads_mirror_unread();
ALTER TABLE "threads" DROP COLUMN "unread", DROP COLUMN "lastReadSeq";
