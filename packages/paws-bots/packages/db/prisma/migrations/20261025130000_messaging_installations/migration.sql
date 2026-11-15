CREATE TABLE "messaging_installations" ("id" TEXT PRIMARY KEY, "provider" TEXT NOT NULL, "workspaceId" TEXT NOT NULL,
 "workspaceName" TEXT NOT NULL, "ciphertext" TEXT NOT NULL,
 "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL,
 "spaceId" TEXT NOT NULL REFERENCES "spaces"("id") ON DELETE CASCADE ON UPDATE CASCADE,
 "userId" TEXT NOT NULL REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE,
 "botId" TEXT NOT NULL REFERENCES "bots"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
ALTER TABLE "messaging_installations" ENABLE ROW LEVEL SECURITY;
CREATE POLICY messaging_installations_system ON "messaging_installations" USING (current_setting('app.rls_bypass', true) = 'on');
CREATE POLICY messaging_installations_tenant ON "messaging_installations" USING (
 "spaceId" = NULLIF(current_setting('app.space_id', true), '') AND
 "userId" = NULLIF(current_setting('app.user_id', true), ''));
CREATE TABLE "messaging_install_sessions" ("id" TEXT PRIMARY KEY, "provider" TEXT NOT NULL, "expiresAt" TIMESTAMP(3) NOT NULL,
 "spaceId" TEXT NOT NULL REFERENCES "spaces"("id") ON DELETE CASCADE ON UPDATE CASCADE,
 "userId" TEXT NOT NULL REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE,
 "botId" TEXT NOT NULL REFERENCES "bots"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
ALTER TABLE "messaging_install_sessions" ENABLE ROW LEVEL SECURITY;
CREATE POLICY messaging_install_sessions_system ON "messaging_install_sessions" USING (current_setting('app.rls_bypass', true) = 'on');
CREATE POLICY messaging_install_sessions_tenant ON "messaging_install_sessions" USING (
 "spaceId" = NULLIF(current_setting('app.space_id', true), '') AND
 "userId" = NULLIF(current_setting('app.user_id', true), ''));
CREATE UNIQUE INDEX "messaging_installations_provider_workspaceId_key" ON "messaging_installations"("provider", "workspaceId");
CREATE INDEX "messaging_installations_spaceId_userId_idx" ON "messaging_installations"("spaceId", "userId");
CREATE INDEX "messaging_install_sessions_expiresAt_idx" ON "messaging_install_sessions"("expiresAt");

ALTER TABLE "messaging_identities" ADD COLUMN "installationId" TEXT;
ALTER TABLE "messaging_identities" ADD CONSTRAINT "messaging_identities_installationId_fkey"
FOREIGN KEY ("installationId") REFERENCES "messaging_installations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
CREATE INDEX "messaging_identities_installationId_idx" ON "messaging_identities"("installationId");
