-- Sole statement, own transaction — VALIDATE CONSTRAINT only needs a
-- SHARE UPDATE EXCLUSIVE lock (concurrent reads/writes allowed) as long
-- as the prior migration's ADD CONSTRAINT NOT VALID has already committed
-- and released its lock.
ALTER TABLE "runs" VALIDATE CONSTRAINT "runs_routineId_fkey";
