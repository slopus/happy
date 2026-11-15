-- Additive: the previous release never reads this table.
CREATE TABLE "feedback_reports" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "spaceId" TEXT NOT NULL,
    "botId" TEXT NOT NULL,
    "threadId" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "feedback_reports_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "feedback_reports_userId_createdAt_idx" ON "feedback_reports"("userId", "createdAt");

CREATE INDEX "feedback_reports_createdAt_idx" ON "feedback_reports"("createdAt");

ALTER TABLE "feedback_reports" ADD CONSTRAINT "feedback_reports_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "feedback_reports" ADD CONSTRAINT "feedback_reports_spaceId_fkey" FOREIGN KEY ("spaceId") REFERENCES "spaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Same policies as trusted_link_sites: a user reaches only their own reports.
ALTER TABLE "feedback_reports" ENABLE ROW LEVEL SECURITY;
CREATE POLICY feedback_reports_tenant ON "feedback_reports"
  USING ("userId" = NULLIF(current_setting('app.user_id', true), ''));
CREATE POLICY feedback_reports_system ON "feedback_reports"
  USING (current_setting('app.rls_bypass', true) = 'on');
