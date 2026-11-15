-- Additive: the previous release never reads this column. Existing own-key subscribers are on
-- the Standard tier, which a null also reads as.
ALTER TABLE "billing_accounts" ADD COLUMN "byokTier" TEXT;

UPDATE "billing_accounts" SET "byokTier" = 'standard' WHERE "byokPriceCents" IS NOT NULL;
