ALTER TABLE "phone_outbound" ADD COLUMN IF NOT EXISTS "nextAttemptAt" TIMESTAMP(3);
