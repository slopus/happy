-- Additive: older releases never read or write it.
ALTER TABLE "computers" ADD COLUMN "autoRecoveredAt" TIMESTAMP(3);
