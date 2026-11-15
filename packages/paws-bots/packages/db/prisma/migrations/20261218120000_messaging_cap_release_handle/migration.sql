-- Additive: a nullable column the previous release never reads or writes.
ALTER TABLE "messaging_identities" ADD COLUMN IF NOT EXISTS "capReleaseHandle" TEXT;
