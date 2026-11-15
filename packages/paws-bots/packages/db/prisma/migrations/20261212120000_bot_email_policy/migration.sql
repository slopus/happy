-- Legacy and previous-release reservations have unknown recipient counts; charge their maximum.
ALTER TABLE "user" ADD COLUMN "botEmailDailyLimit" INTEGER NOT NULL DEFAULT 10 CHECK ("botEmailDailyLimit" BETWEEN 0 AND 1000);
ALTER TABLE "user" ADD COLUMN "botEmailRepliesEnabled" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "bot_email_sends" ADD COLUMN "recipientCount" INTEGER NOT NULL DEFAULT 10 CHECK ("recipientCount" BETWEEN 1 AND 10);
ALTER TABLE "user" ADD COLUMN "botEmailAllowedRecipients" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
