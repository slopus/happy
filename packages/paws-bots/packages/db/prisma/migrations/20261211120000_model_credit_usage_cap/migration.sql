ALTER TABLE "user" ADD COLUMN "modelCreditCapMicros" BIGINT;
ALTER TABLE "user" ADD CONSTRAINT "user_model_credit_cap_nonnegative"
 CHECK ("modelCreditCapMicros" IS NULL OR "modelCreditCapMicros" >= 0);
