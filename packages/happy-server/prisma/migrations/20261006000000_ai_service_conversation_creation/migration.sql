-- Optional scoped creation key. Existing callers retain UUID creation semantics.
ALTER TABLE "AIServiceBinding" ADD COLUMN "appConversationId" TEXT;
ALTER TABLE "AIServiceBinding" ADD COLUMN "creationInput" JSONB;
CREATE UNIQUE INDEX "AIServiceBinding_authorizationId_appId_appConversationId_key"
    ON "AIServiceBinding" ("authorizationId", "appId", "appConversationId");
