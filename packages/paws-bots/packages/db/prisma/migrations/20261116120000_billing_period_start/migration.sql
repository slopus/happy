ALTER TABLE "billing_accounts" ADD COLUMN "currentPeriodStartsAt" TIMESTAMP(3);

-- Until each subscription's next sync stores the real start, infer it from the stored end: a
-- trial runs 7 days and every paid plan renews monthly.
UPDATE "billing_accounts"
SET "currentPeriodStartsAt" = CASE
  WHEN "status" = 'trialing' AND "trialEndsAt" IS NOT NULL THEN "trialEndsAt" - INTERVAL '7 days'
  ELSE "currentPeriodEndsAt" - INTERVAL '1 month'
END
WHERE "currentPeriodEndsAt" IS NOT NULL;
