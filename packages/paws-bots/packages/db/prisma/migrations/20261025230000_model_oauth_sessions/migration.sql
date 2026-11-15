-- Additive: the previous release keeps its sign-ins in memory and never reads this table.
CREATE TABLE "model_oauth_sessions" (
    "id" TEXT NOT NULL,
    "spaceId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "scope" TEXT NOT NULL,
    "ciphertext" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "model_oauth_sessions_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "model_oauth_sessions_userId_provider_idx" ON "model_oauth_sessions"("userId", "provider");
CREATE INDEX "model_oauth_sessions_scope_idx" ON "model_oauth_sessions"("scope");
CREATE INDEX "model_oauth_sessions_createdAt_idx" ON "model_oauth_sessions"("createdAt");

ALTER TABLE "model_oauth_sessions" ADD CONSTRAINT "model_oauth_sessions_spaceId_fkey" FOREIGN KEY ("spaceId") REFERENCES "spaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Same policies as mcp_oauth_sessions (20261022120000_row_level_security_tenant_tables).
ALTER TABLE "model_oauth_sessions" ENABLE ROW LEVEL SECURITY;
CREATE POLICY model_oauth_sessions_tenant ON "model_oauth_sessions"
  USING ("spaceId" = NULLIF(current_setting('app.space_id', true), ''));
CREATE POLICY model_oauth_sessions_system ON "model_oauth_sessions"
  USING (current_setting('app.rls_bypass', true) = 'on');
