ALTER TABLE "billing_accounts" ADD COLUMN "byokPriceCents" INTEGER;

-- Own-key subscriptions so far were all bought at $10 a month. Store it now so subscribers see
-- what they pay before their next sync, which overwrites it from the provider.
UPDATE "billing_accounts"
SET "byokPriceCents" = 1000
WHERE "subscriptionId" IS NOT NULL
  AND "creditAmountCents" IS NULL
  AND "status" IN ('trialing', 'active', 'past_due', 'unpaid', 'paused');
