CREATE TABLE "work_activity_start_tokens" (
  "tokenDigest" TEXT NOT NULL PRIMARY KEY,
  "userId" TEXT NOT NULL REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "sessionId" TEXT NOT NULL,
  "ciphertext" TEXT NOT NULL,
  "startedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "work_activity_start_tokens_userId_idx" ON "work_activity_start_tokens"("userId");
CREATE INDEX "work_activity_start_tokens_sessionId_idx" ON "work_activity_start_tokens"("sessionId");
ALTER TABLE "work_activity_start_tokens" ENABLE ROW LEVEL SECURITY;
CREATE POLICY work_activity_start_tokens_system ON "work_activity_start_tokens"
  USING ((SELECT app_rls_bypass()));
