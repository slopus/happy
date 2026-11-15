-- Additive: previous API/worker releases continue using their local registrations.
CREATE TABLE "push_tokens" (
  "userId" TEXT NOT NULL PRIMARY KEY REFERENCES "user"("id") ON DELETE CASCADE,
  "ciphertext" TEXT NOT NULL,
  "tokenDigest" TEXT NOT NULL UNIQUE,
  "sessionId" TEXT NOT NULL,
  "updatedAt" TIMESTAMP(3) NOT NULL
);
ALTER TABLE "push_tokens" ENABLE ROW LEVEL SECURITY;
CREATE POLICY push_tokens_system ON "push_tokens"
  USING (current_setting('app.rls_bypass', true) = 'on');
