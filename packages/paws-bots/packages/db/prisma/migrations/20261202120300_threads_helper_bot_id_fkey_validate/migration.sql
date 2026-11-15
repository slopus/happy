-- Sole statement, own transaction: VALIDATE CONSTRAINT takes only a SHARE UPDATE EXCLUSIVE
-- lock, so chat reads and writes continue while it scans.
ALTER TABLE "threads" VALIDATE CONSTRAINT "threads_helperBotId_fkey";
