-- Additive: the previous release neither writes nor reads it.
ALTER TABLE "external_effects" ADD COLUMN "batchActions" JSONB;
