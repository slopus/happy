CREATE TABLE "call_push_devices" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "expoTokenDigest" TEXT UNIQUE,
  "voipTokenDigest" TEXT UNIQUE,
  "userId" TEXT NOT NULL REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "sessionId" TEXT NOT NULL,
  "ciphertext" TEXT NOT NULL,
  "updatedAt" TIMESTAMP(3) NOT NULL
);
CREATE INDEX "call_push_devices_userId_sessionId_idx" ON "call_push_devices"("userId", "sessionId");
ALTER TABLE "call_push_devices" ENABLE ROW LEVEL SECURITY;
CREATE POLICY call_push_devices_system ON "call_push_devices"
  USING ((SELECT app_rls_bypass()));
