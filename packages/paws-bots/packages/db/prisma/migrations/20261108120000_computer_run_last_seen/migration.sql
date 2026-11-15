-- Additive: older releases never read or write it.
ALTER TABLE "computer_runs" ADD COLUMN "lastSeenAt" TIMESTAMP(3);
