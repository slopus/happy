ALTER TABLE "user" ADD COLUMN "marketingEmailOptOutAt" TIMESTAMP(3);

CREATE TABLE "email_sends" (
  "userId" TEXT NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
  "kind" TEXT NOT NULL,
  "sentAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY ("userId", "kind")
);
ALTER TABLE "email_sends" ENABLE ROW LEVEL SECURITY;
CREATE POLICY email_sends_system ON "email_sends"
  USING (current_setting('app.rls_bypass', true) = 'on');
