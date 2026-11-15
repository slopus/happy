-- Additive: older releases never read or write it.
ALTER TABLE "spaces" ADD COLUMN "deletionAttemptId" TEXT;
