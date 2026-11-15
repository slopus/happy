-- Additive: older releases keep writing homeRevision without it.
ALTER TABLE "computers" ADD COLUMN "homeRevisionAt" TIMESTAMP(3);
