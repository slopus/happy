-- Additive: the previous release never reads this table.
CREATE TABLE "bot_email_sends" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "botId" TEXT NOT NULL,
    "sentAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "bot_email_sends_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "bot_email_sends_userId_sentAt_idx" ON "bot_email_sends"("userId", "sentAt");

ALTER TABLE "bot_email_sends" ADD CONSTRAINT "bot_email_sends_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- An owner's sends span their Spaces, so only system steps read or write them.
ALTER TABLE "bot_email_sends" ENABLE ROW LEVEL SECURITY;
CREATE POLICY bot_email_sends_system ON "bot_email_sends"
  USING ((SELECT app_rls_bypass()));
