-- Additive vault access settings. The legacy access guard migration hides restricted items
-- from older runtime connections while keeping unrestricted items usable.
CREATE TABLE "vault_credential_limits" (
  "id" TEXT NOT NULL,
  "credentialId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "spaceId" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "vault_credential_limits_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "vault_credential_limits_credentialId_fkey" FOREIGN KEY ("credentialId")
    REFERENCES "vault_credentials"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "vault_credential_limits_spaceId_fkey" FOREIGN KEY ("spaceId")
    REFERENCES "spaces"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "vault_credential_limits_credentialId_spaceId_key"
  ON "vault_credential_limits"("credentialId", "spaceId");
CREATE INDEX "vault_credential_limits_userId_spaceId_idx"
  ON "vault_credential_limits"("userId", "spaceId");

CREATE TABLE "vault_credential_bots" (
  "id" TEXT NOT NULL,
  "credentialId" TEXT NOT NULL,
  "botId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "spaceId" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "vault_credential_bots_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "vault_credential_bots_credentialId_fkey" FOREIGN KEY ("credentialId")
    REFERENCES "vault_credentials"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "vault_credential_bots_botId_fkey" FOREIGN KEY ("botId")
    REFERENCES "bots"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "vault_credential_bots_spaceId_fkey" FOREIGN KEY ("spaceId")
    REFERENCES "spaces"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "vault_credential_bots_credentialId_botId_key"
  ON "vault_credential_bots"("credentialId", "botId");
CREATE INDEX "vault_credential_bots_userId_spaceId_botId_idx"
  ON "vault_credential_bots"("userId", "spaceId", "botId");

-- The owner reads and changes the limits and bots chosen in the Space they act in.
ALTER TABLE "vault_credential_limits" ENABLE ROW LEVEL SECURITY;
CREATE POLICY vault_credential_limits_tenant ON "vault_credential_limits"
  USING ("userId" = NULLIF(current_setting('app.user_id', true), '')
    AND "spaceId" = NULLIF(current_setting('app.space_id', true), ''));
CREATE POLICY vault_credential_limits_system ON "vault_credential_limits"
  USING ((SELECT app_rls_bypass()));
ALTER TABLE "vault_credential_bots" ENABLE ROW LEVEL SECURITY;
CREATE POLICY vault_credential_bots_tenant ON "vault_credential_bots"
  USING ("userId" = NULLIF(current_setting('app.user_id', true), '')
    AND "spaceId" = NULLIF(current_setting('app.space_id', true), ''));
CREATE POLICY vault_credential_bots_system ON "vault_credential_bots"
  USING ((SELECT app_rls_bypass()));
