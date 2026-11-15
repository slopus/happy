CREATE TABLE "work_activity_tokens" (
  "tokenDigest" TEXT NOT NULL PRIMARY KEY,
  "userId" TEXT NOT NULL REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "sessionId" TEXT NOT NULL,
  "ciphertext" TEXT NOT NULL,
  "lastState" TEXT,
  "lastWaiting" INTEGER NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "work_activity_tokens_userId_idx" ON "work_activity_tokens"("userId");
CREATE INDEX "work_activity_tokens_sessionId_idx" ON "work_activity_tokens"("sessionId");
ALTER TABLE "work_activity_tokens" ENABLE ROW LEVEL SECURITY;
CREATE POLICY work_activity_tokens_system ON "work_activity_tokens"
  USING ((SELECT app_rls_bypass()));
