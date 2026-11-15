-- Additive: older releases never read or write it.
ALTER TABLE "threads" ADD COLUMN "historyCompactionRetryAfterSeq" INTEGER;
