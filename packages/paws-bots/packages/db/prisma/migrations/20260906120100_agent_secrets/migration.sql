-- Space-owner managed agent environment secrets (provider-neutral).
-- Distinct from bot_secrets, which are HTTP destination credentials.

CREATE TABLE "agent_secrets" (
  "id" TEXT NOT NULL,
  "spaceId" TEXT NOT NULL,
  "createdByUserId" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "secretId" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "agent_secrets_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "agent_secrets_name_check" CHECK ("name" ~ '^[A-Z_][A-Z0-9_]{0,63}$')
);

CREATE UNIQUE INDEX "agent_secrets_secretId_key" ON "agent_secrets"("secretId");
CREATE UNIQUE INDEX "agent_secrets_spaceId_name_key" ON "agent_secrets"("spaceId", "name");
CREATE INDEX "agent_secrets_spaceId_updatedAt_idx" ON "agent_secrets"("spaceId", "updatedAt");

ALTER TABLE "agent_secrets"
  ADD CONSTRAINT "agent_secrets_spaceId_fkey"
  FOREIGN KEY ("spaceId") REFERENCES "spaces"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "agent_secrets"
  ADD CONSTRAINT "agent_secrets_createdByUserId_fkey"
  FOREIGN KEY ("createdByUserId") REFERENCES "user"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "agent_secrets"
  ADD CONSTRAINT "agent_secrets_secretId_fkey"
  FOREIGN KEY ("secretId") REFERENCES "secrets"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
