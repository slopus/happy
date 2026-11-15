CREATE TABLE "bot_secrets" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "userId" TEXT NOT NULL REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "spaceId" TEXT NOT NULL REFERENCES "spaces"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "botId" TEXT NOT NULL REFERENCES "bots"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "name" TEXT NOT NULL,
  "origin" TEXT NOT NULL,
  "auth" JSONB NOT NULL,
  "ciphertext" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL
);
CREATE UNIQUE INDEX "bot_secrets_userId_spaceId_botId_name_key" ON "bot_secrets"("userId", "spaceId", "botId", "name");
CREATE INDEX "bot_secrets_botId_idx" ON "bot_secrets"("botId");
CREATE INDEX "bot_secrets_spaceId_idx" ON "bot_secrets"("spaceId");
