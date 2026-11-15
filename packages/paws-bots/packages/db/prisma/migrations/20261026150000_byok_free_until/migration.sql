ALTER TABLE "model_credit_accounts" ADD COLUMN "byokFreeUntil" TIMESTAMP(3);

-- Organizations already on their own key keep it free for 30 days after the plan becomes paid.
UPDATE "model_credit_accounts" SET "byokFreeUntil" = now() + interval '30 days' WHERE "mode" = 'byok';
