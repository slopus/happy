-- Additive: a nullable column the previous release never reads or writes.
ALTER TABLE "messages" ADD COLUMN IF NOT EXISTS "toolHistory" TEXT;
