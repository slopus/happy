-- Additive: older releases never read or write it.
ALTER TABLE "computers" ADD COLUMN "restorePending" BOOLEAN NOT NULL DEFAULT false;
