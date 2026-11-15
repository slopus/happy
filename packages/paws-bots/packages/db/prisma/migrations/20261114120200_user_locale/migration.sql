-- Additive: older releases never read or write it.
ALTER TABLE "user" ADD COLUMN "locale" TEXT;
