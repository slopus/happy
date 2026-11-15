ALTER TABLE "billing_accounts" ADD COLUMN "paidAt" TIMESTAMP(3);
-- Only a subscription active now is known to have paid; any other is treated as never paid.
UPDATE "billing_accounts" SET "paidAt" = "subscribedAt" WHERE "status" = 'active';
