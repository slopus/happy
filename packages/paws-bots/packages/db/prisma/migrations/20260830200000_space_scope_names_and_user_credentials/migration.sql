BEGIN;

-- These metadata renames need ACCESS EXCLUSIVE locks. Fail the deployment
-- promptly under contention instead of leaving application traffic queued
-- behind a migration waiting indefinitely for a lock.
SET LOCAL lock_timeout = '5s';

-- A space is the application privacy boundary. Make the default-space and
-- ownership invariants explicit before clients can create more of them.
ALTER TABLE "spaces"
  ADD COLUMN "isDefault" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "createdByUserId" TEXT;

UPDATE "spaces" AS space
SET "isDefault" = (space."id" = space."organizationId");

WITH first_members AS (
  SELECT DISTINCT ON (membership."spaceId")
    membership."spaceId",
    membership."userId"
  FROM "space_members" AS membership
  ORDER BY membership."spaceId", membership."createdAt", membership."id"
)
UPDATE "spaces" AS space
SET "createdByUserId" = first_members."userId"
FROM first_members
WHERE space."id" = first_members."spaceId";

CREATE UNIQUE INDEX "spaces_organizationId_default_key"
ON "spaces"("organizationId")
WHERE "isDefault";
CREATE INDEX "spaces_createdByUserId_idx" ON "spaces"("createdByUserId");
ALTER TABLE "spaces"
  ADD CONSTRAINT "spaces_createdByUserId_fkey"
  FOREIGN KEY ("createdByUserId") REFERENCES "user"("id")
  ON DELETE SET NULL ON UPDATE CASCADE NOT VALID;

ALTER TABLE "space_members" ADD COLUMN "role" TEXT NOT NULL DEFAULT 'member';
UPDATE "space_members" AS membership
SET "role" = member."role"
FROM "member" AS member
WHERE member."organizationId" = membership."organizationId"
  AND member."userId" = membership."userId"
  AND membership."role" IS DISTINCT FROM member."role";

-- Future organization invitations must not create members who cannot enter
-- the organization's general Space. Invitations are currently disabled, but
-- enforcing this at the data boundary keeps the invariant true when enabled.
CREATE FUNCTION ensure_default_space_membership() RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO "space_members" (
    "id", "spaceId", "organizationId", "userId", "role", "createdAt"
  )
  SELECT
    'default-space-member:' || NEW."id",
    space."id",
    NEW."organizationId",
    NEW."userId",
    NEW."role",
    NEW."createdAt"
  FROM "spaces" AS space
  WHERE space."organizationId" = NEW."organizationId"
    AND space."isDefault"
  ON CONFLICT ("spaceId", "userId") DO NOTHING;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "member_default_space_membership"
AFTER INSERT ON "member"
FOR EACH ROW EXECUTE FUNCTION ensure_default_space_membership();

-- The old column name described the former Organization boundary. These are
-- metadata-only renames; values and rows are unchanged.
ALTER TABLE "action_approval_rules" RENAME COLUMN "workspaceId" TO "spaceId";
ALTER TABLE "action_auto_review_preferences" RENAME COLUMN "workspaceId" TO "spaceId";
ALTER TABLE "bots" RENAME COLUMN "workspaceId" TO "spaceId";
ALTER TABLE "bot_sections" RENAME COLUMN "workspaceId" TO "spaceId";
ALTER TABLE "bot_deletions" RENAME COLUMN "workspaceId" TO "spaceId";
ALTER TABLE "chat_groups" RENAME COLUMN "workspaceId" TO "spaceId";
ALTER TABLE "threads" RENAME COLUMN "workspaceId" TO "spaceId";
ALTER TABLE "events" RENAME COLUMN "workspaceId" TO "spaceId";
ALTER TABLE "tasks" RENAME COLUMN "workspaceId" TO "spaceId";
ALTER TABLE "runs" RENAME COLUMN "workspaceId" TO "spaceId";
ALTER TABLE "external_effects" RENAME COLUMN "workspaceId" TO "spaceId";
ALTER TABLE "routines" RENAME COLUMN "workspaceId" TO "spaceId";
ALTER TABLE "scratchpad_items" RENAME COLUMN "workspaceId" TO "spaceId";
ALTER TABLE "taught_skills" RENAME COLUMN "workspaceId" TO "spaceId";
ALTER TABLE "agent_skills" RENAME COLUMN "workspaceId" TO "spaceId";
ALTER TABLE "connections" RENAME COLUMN "workspaceId" TO "spaceId";
ALTER TABLE "capability_installs" RENAME COLUMN "workspaceId" TO "spaceId";
ALTER TABLE "memory_documents" RENAME COLUMN "workspaceId" TO "spaceId";
ALTER TABLE "agent_homes" RENAME COLUMN "workspaceId" TO "spaceId";
ALTER TABLE "browser_profiles" RENAME COLUMN "workspaceId" TO "spaceId";
ALTER TABLE "computers" RENAME COLUMN "workspaceId" TO "spaceId";
ALTER TABLE "artifacts" RENAME COLUMN "workspaceId" TO "spaceId";
ALTER TABLE "usage_records" RENAME COLUMN "workspaceId" TO "spaceId";
ALTER TABLE "notification_preferences" RENAME COLUMN "workspaceId" TO "spaceId";
ALTER TABLE "workspace_memory_configs" RENAME COLUMN "workspaceId" TO "spaceId";
ALTER TABLE "mcp_servers" RENAME COLUMN "workspaceId" TO "spaceId";
ALTER TABLE "mcp_oauth_sessions" RENAME COLUMN "workspaceId" TO "spaceId";
ALTER TABLE "bot_mcp_servers" RENAME COLUMN "workspaceId" TO "spaceId";
ALTER TABLE "phone_identities" RENAME COLUMN "workspaceId" TO "spaceId";
ALTER TABLE "secrets" RENAME COLUMN "workspaceId" TO "spaceId";
ALTER TABLE "user_model_credentials" RENAME COLUMN "workspaceId" TO "spaceId";
ALTER TABLE "user_voice_credentials" RENAME COLUMN "workspaceId" TO "spaceId";

-- Preserve per-space defaults while lifting encrypted model and voice
-- credentials to User scope. A credential can be selected independently in
-- any space without duplicating or exposing data-bearing integrations.
CREATE TABLE "space_model_preferences" (
  "id" TEXT NOT NULL,
  "spaceId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "credentialId" TEXT NOT NULL,
  "modelId" TEXT,
  "isDefault" BOOLEAN NOT NULL DEFAULT false,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "space_model_preferences_pkey" PRIMARY KEY ("id")
);

INSERT INTO "space_model_preferences" (
  "id", "spaceId", "userId", "credentialId", "modelId", "isDefault", "createdAt", "updatedAt"
)
SELECT
  'model-' || "id", "spaceId", "userId", "id", "defaultModel", "isDefault", "createdAt", "updatedAt"
FROM "user_model_credentials";

CREATE TABLE "space_voice_preferences" (
  "id" TEXT NOT NULL,
  "spaceId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "credentialId" TEXT NOT NULL,
  "voiceId" TEXT NOT NULL DEFAULT '',
  "isDefault" BOOLEAN NOT NULL DEFAULT false,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "space_voice_preferences_pkey" PRIMARY KEY ("id")
);

INSERT INTO "space_voice_preferences" (
  "id", "spaceId", "userId", "credentialId", "voiceId", "isDefault", "createdAt", "updatedAt"
)
SELECT
  'voice-' || "id", "spaceId", "userId", "id", "voiceId", "isDefault", "createdAt", "updatedAt"
FROM "user_voice_credentials";

-- Model and voice keys are the only account-level secrets. Connection, MCP,
-- memory-provider, webhook, and other data-bearing secrets stay in one space.
ALTER TABLE "secrets" ALTER COLUMN "spaceId" DROP NOT NULL;
UPDATE "secrets"
SET "spaceId" = NULL
WHERE "id" IN (
  SELECT "secretId" FROM "user_model_credentials"
  UNION
  SELECT "secretId" FROM "user_voice_credentials"
);
DELETE FROM "secrets" AS secret
WHERE secret."kind" IN ('model', 'voice')
  AND NOT EXISTS (
    SELECT 1 FROM "user_model_credentials" AS credential
    WHERE credential."secretId" = secret."id"
  )
  AND NOT EXISTS (
    SELECT 1 FROM "user_voice_credentials" AS credential
    WHERE credential."secretId" = secret."id"
  );
DELETE FROM "secrets" AS secret
WHERE secret."spaceId" IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM "spaces" AS space WHERE space."id" = secret."spaceId"
  );
ALTER TABLE "secrets"
  ADD CONSTRAINT "secrets_spaceId_fkey"
  FOREIGN KEY ("spaceId") REFERENCES "spaces"("id")
  ON DELETE CASCADE ON UPDATE CASCADE NOT VALID;
ALTER TABLE "secrets"
  ADD CONSTRAINT "secrets_scope_check"
  CHECK (
    ("kind" IN ('model', 'voice') AND "spaceId" IS NULL)
    OR ("kind" NOT IN ('model', 'voice') AND "spaceId" IS NOT NULL)
  ) NOT VALID;
ALTER TABLE "mcp_oauth_sessions"
  ADD CONSTRAINT "mcp_oauth_sessions_spaceId_fkey"
  FOREIGN KEY ("spaceId") REFERENCES "spaces"("id")
  ON DELETE CASCADE ON UPDATE CASCADE NOT VALID;
ALTER TABLE "bot_mcp_servers"
  ADD CONSTRAINT "bot_mcp_servers_spaceId_fkey"
  FOREIGN KEY ("spaceId") REFERENCES "spaces"("id")
  ON DELETE CASCADE ON UPDATE CASCADE NOT VALID;
ALTER TABLE "phone_identities"
  ADD CONSTRAINT "phone_identities_spaceId_fkey"
  FOREIGN KEY ("spaceId") REFERENCES "spaces"("id")
  ON DELETE CASCADE ON UPDATE CASCADE NOT VALID;

DROP INDEX "user_model_credentials_userId_workspaceId_idx";
ALTER TABLE "user_model_credentials"
  DROP COLUMN "spaceId",
  DROP COLUMN "isDefault",
  DROP COLUMN "defaultModel";
CREATE UNIQUE INDEX "user_model_credentials_id_userId_key"
ON "user_model_credentials"("id", "userId");
CREATE INDEX "user_model_credentials_userId_provider_updatedAt_idx"
ON "user_model_credentials"("userId", "provider", "updatedAt");

DROP INDEX "user_voice_credentials_userId_workspaceId_provider_key";
ALTER TABLE "user_voice_credentials"
  DROP COLUMN "spaceId",
  DROP COLUMN "isDefault",
  DROP COLUMN "voiceId";
CREATE UNIQUE INDEX "user_voice_credentials_id_userId_key"
ON "user_voice_credentials"("id", "userId");
CREATE INDEX "user_voice_credentials_userId_provider_updatedAt_idx"
ON "user_voice_credentials"("userId", "provider", "updatedAt");

-- Match the current schema default; older migrations left this at dedicated.
ALTER TABLE "computers" ALTER COLUMN "scope" SET DEFAULT 'team';

CREATE UNIQUE INDEX "space_model_preferences_spaceId_userId_credentialId_key"
ON "space_model_preferences"("spaceId", "userId", "credentialId");
CREATE INDEX "space_model_preferences_spaceId_userId_isDefault_updatedAt_idx"
ON "space_model_preferences"("spaceId", "userId", "isDefault", "updatedAt");
CREATE INDEX "space_model_preferences_credentialId_idx"
ON "space_model_preferences"("credentialId");
WITH ranked_defaults AS (
  SELECT "id", row_number() OVER (
    PARTITION BY "spaceId", "userId"
    ORDER BY "updatedAt" DESC, "createdAt" DESC, "id" DESC
  ) AS rank
  FROM "space_model_preferences"
  WHERE "isDefault"
)
UPDATE "space_model_preferences" AS preference
SET "isDefault" = false
FROM ranked_defaults
WHERE preference."id" = ranked_defaults."id"
  AND ranked_defaults.rank > 1;
CREATE UNIQUE INDEX "space_model_preferences_default_key"
ON "space_model_preferences"("spaceId", "userId")
WHERE "isDefault";

CREATE UNIQUE INDEX "space_voice_preferences_spaceId_userId_credentialId_key"
ON "space_voice_preferences"("spaceId", "userId", "credentialId");
CREATE INDEX "space_voice_preferences_spaceId_userId_isDefault_updatedAt_idx"
ON "space_voice_preferences"("spaceId", "userId", "isDefault", "updatedAt");
CREATE INDEX "space_voice_preferences_credentialId_idx"
ON "space_voice_preferences"("credentialId");
WITH ranked_defaults AS (
  SELECT "id", row_number() OVER (
    PARTITION BY "spaceId", "userId"
    ORDER BY "updatedAt" DESC, "createdAt" DESC, "id" DESC
  ) AS rank
  FROM "space_voice_preferences"
  WHERE "isDefault"
)
UPDATE "space_voice_preferences" AS preference
SET "isDefault" = false
FROM ranked_defaults
WHERE preference."id" = ranked_defaults."id"
  AND ranked_defaults.rank > 1;
CREATE UNIQUE INDEX "space_voice_preferences_default_key"
ON "space_voice_preferences"("spaceId", "userId")
WHERE "isDefault";

ALTER TABLE "space_model_preferences"
  ADD CONSTRAINT "space_model_preferences_spaceId_userId_fkey"
  FOREIGN KEY ("spaceId", "userId") REFERENCES "space_members"("spaceId", "userId")
  ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "space_model_preferences_credentialId_userId_fkey"
  FOREIGN KEY ("credentialId", "userId") REFERENCES "user_model_credentials"("id", "userId")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "space_voice_preferences"
  ADD CONSTRAINT "space_voice_preferences_spaceId_userId_fkey"
  FOREIGN KEY ("spaceId", "userId") REFERENCES "space_members"("spaceId", "userId")
  ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "space_voice_preferences_credentialId_userId_fkey"
  FOREIGN KEY ("credentialId", "userId") REFERENCES "user_voice_credentials"("id", "userId")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "workspace_memory_configs" RENAME TO "space_memory_configs";

COMMIT;

BEGIN;

SET LOCAL lock_timeout = '5s';

ALTER TABLE "spaces" VALIDATE CONSTRAINT "spaces_createdByUserId_fkey";
ALTER TABLE "secrets" VALIDATE CONSTRAINT "secrets_spaceId_fkey";
ALTER TABLE "secrets" VALIDATE CONSTRAINT "secrets_scope_check";
ALTER TABLE "mcp_oauth_sessions" VALIDATE CONSTRAINT "mcp_oauth_sessions_spaceId_fkey";
ALTER TABLE "bot_mcp_servers" VALIDATE CONSTRAINT "bot_mcp_servers_spaceId_fkey";
ALTER TABLE "phone_identities" VALIDATE CONSTRAINT "phone_identities_spaceId_fkey";

-- Keep database object names aligned with the schema so future migrations do
-- not mistake metadata renames for dropped indexes or constraints.
ALTER TABLE "action_approval_rules" RENAME CONSTRAINT "action_approval_rules_workspaceId_fkey" TO "action_approval_rules_spaceId_fkey";
ALTER TABLE "action_auto_review_preferences" RENAME CONSTRAINT "action_auto_review_preferences_workspaceId_fkey" TO "action_auto_review_preferences_spaceId_fkey";
ALTER TABLE "bots" RENAME CONSTRAINT "bots_workspaceId_fkey" TO "bots_spaceId_fkey";
ALTER TABLE "bot_sections" RENAME CONSTRAINT "bot_sections_workspaceId_fkey" TO "bot_sections_spaceId_fkey";
ALTER TABLE "bot_deletions" RENAME CONSTRAINT "bot_deletions_workspaceId_fkey" TO "bot_deletions_spaceId_fkey";
ALTER TABLE "chat_groups" RENAME CONSTRAINT "chat_groups_workspaceId_fkey" TO "chat_groups_spaceId_fkey";
ALTER TABLE "threads" RENAME CONSTRAINT "threads_workspaceId_fkey" TO "threads_spaceId_fkey";
ALTER TABLE "events" RENAME CONSTRAINT "events_workspaceId_fkey" TO "events_spaceId_fkey";
ALTER TABLE "tasks" RENAME CONSTRAINT "tasks_workspaceId_fkey" TO "tasks_spaceId_fkey";
ALTER TABLE "runs" RENAME CONSTRAINT "runs_workspaceId_fkey" TO "runs_spaceId_fkey";
ALTER TABLE "external_effects" RENAME CONSTRAINT "external_effects_workspaceId_fkey" TO "external_effects_spaceId_fkey";
ALTER TABLE "routines" RENAME CONSTRAINT "routines_workspaceId_fkey" TO "routines_spaceId_fkey";
ALTER TABLE "scratchpad_items" RENAME CONSTRAINT "scratchpad_items_workspaceId_fkey" TO "scratchpad_items_spaceId_fkey";
ALTER TABLE "taught_skills" RENAME CONSTRAINT "taught_skills_workspaceId_fkey" TO "taught_skills_spaceId_fkey";
ALTER TABLE "agent_skills" RENAME CONSTRAINT "agent_skills_workspaceId_fkey" TO "agent_skills_spaceId_fkey";
ALTER TABLE "connections" RENAME CONSTRAINT "connections_workspaceId_fkey" TO "connections_spaceId_fkey";
ALTER TABLE "capability_installs" RENAME CONSTRAINT "capability_installs_workspaceId_fkey" TO "capability_installs_spaceId_fkey";
ALTER TABLE "memory_documents" RENAME CONSTRAINT "memory_documents_workspaceId_fkey" TO "memory_documents_spaceId_fkey";
ALTER TABLE "agent_homes" RENAME CONSTRAINT "agent_homes_workspaceId_fkey" TO "agent_homes_spaceId_fkey";
ALTER TABLE "browser_profiles" RENAME CONSTRAINT "browser_profiles_workspaceId_fkey" TO "browser_profiles_spaceId_fkey";
ALTER TABLE "computers" RENAME CONSTRAINT "computers_workspaceId_fkey" TO "computers_spaceId_fkey";
ALTER TABLE "artifacts" RENAME CONSTRAINT "artifacts_workspaceId_fkey" TO "artifacts_spaceId_fkey";
ALTER TABLE "usage_records" RENAME CONSTRAINT "usage_records_workspaceId_fkey" TO "usage_records_spaceId_fkey";
ALTER TABLE "notification_preferences" RENAME CONSTRAINT "notification_preferences_workspaceId_fkey" TO "notification_preferences_spaceId_fkey";
ALTER TABLE "space_memory_configs" RENAME CONSTRAINT "workspace_memory_configs_workspaceId_fkey" TO "space_memory_configs_spaceId_fkey";
ALTER TABLE "space_memory_configs" RENAME CONSTRAINT "workspace_memory_configs_secretId_fkey" TO "space_memory_configs_secretId_fkey";
ALTER TABLE "mcp_servers" RENAME CONSTRAINT "mcp_servers_workspaceId_fkey" TO "mcp_servers_spaceId_fkey";

ALTER INDEX IF EXISTS "action_approval_rules_workspaceId_createdByUserId_idx" RENAME TO "action_approval_rules_spaceId_createdByUserId_idx";
ALTER INDEX IF EXISTS "action_approval_rules_workspaceId_createdByUserId_effect_matchKind_matchValue_key" RENAME TO "action_approval_rules_spaceId_createdByUserId_effect_matchK_key";
ALTER INDEX IF EXISTS "action_auto_review_preferences_workspaceId_userId_key" RENAME TO "action_auto_review_preferences_spaceId_userId_key";
ALTER INDEX IF EXISTS "bots_workspaceId_spawnKey_key" RENAME TO "bots_spaceId_spawnKey_key";
ALTER INDEX IF EXISTS "bots_workspaceId_userId_archivedAt_pinned_updatedAt_idx" RENAME TO "bots_spaceId_userId_archivedAt_pinned_updatedAt_idx";
ALTER INDEX IF EXISTS "bot_sections_workspaceId_userId_name_key" RENAME TO "bot_sections_spaceId_userId_name_key";
ALTER INDEX IF EXISTS "bot_sections_workspaceId_userId_position_createdAt_idx" RENAME TO "bot_sections_spaceId_userId_position_createdAt_idx";
ALTER INDEX IF EXISTS "bot_deletions_workspaceId_deletedAt_idx" RENAME TO "bot_deletions_spaceId_deletedAt_idx";
ALTER INDEX IF EXISTS "chat_groups_workspaceId_userId_archivedAt_pinned_updatedAt_idx" RENAME TO "chat_groups_spaceId_userId_archivedAt_pinned_updatedAt_idx";
ALTER INDEX IF EXISTS "threads_workspaceId_idx" RENAME TO "threads_spaceId_idx";
ALTER INDEX IF EXISTS "events_workspaceId_createdAt_idx" RENAME TO "events_spaceId_createdAt_idx";
ALTER INDEX IF EXISTS "tasks_workspaceId_botId_idx" RENAME TO "tasks_spaceId_botId_idx";
ALTER INDEX IF EXISTS "runs_workspaceId_botId_idx" RENAME TO "runs_spaceId_botId_idx";
ALTER INDEX IF EXISTS "runs_workspaceId_clientNonce_key" RENAME TO "runs_spaceId_clientNonce_key";
ALTER INDEX IF EXISTS "routines_workspaceId_botId_idx" RENAME TO "routines_spaceId_botId_idx";
ALTER INDEX IF EXISTS "scratchpad_items_workspaceId_botId_status_idx" RENAME TO "scratchpad_items_spaceId_botId_status_idx";
ALTER INDEX IF EXISTS "scratchpad_items_workspaceId_botId_updatedAt_idx" RENAME TO "scratchpad_items_spaceId_botId_updatedAt_idx";
ALTER INDEX IF EXISTS "taught_skills_workspaceId_botId_idx" RENAME TO "taught_skills_spaceId_botId_idx";
ALTER INDEX IF EXISTS "taught_skills_workspaceId_botId_status_idx" RENAME TO "taught_skills_spaceId_botId_status_idx";
ALTER INDEX IF EXISTS "agent_skills_workspaceId_userId_idx" RENAME TO "agent_skills_spaceId_userId_idx";
ALTER INDEX IF EXISTS "agent_skills_workspaceId_userId_name_lower_key" RENAME TO "agent_skills_spaceId_userId_name_lower_key";
ALTER INDEX IF EXISTS "connections_workspaceId_userId_connectorId_idx" RENAME TO "connections_spaceId_userId_connectorId_idx";
ALTER INDEX IF EXISTS "capability_installs_workspaceId_userId_idx" RENAME TO "capability_installs_spaceId_userId_idx";
ALTER INDEX IF EXISTS "memory_documents_workspaceId_userId_idx" RENAME TO "memory_documents_spaceId_userId_idx";
ALTER INDEX IF EXISTS "memory_documents_workspaceId_scope_botId_path_key" RENAME TO "memory_documents_spaceId_scope_botId_path_key";
ALTER INDEX IF EXISTS "computers_workspaceId_scope_idx" RENAME TO "computers_spaceId_scope_idx";
ALTER INDEX IF EXISTS "artifacts_workspaceId_botId_idx" RENAME TO "artifacts_spaceId_botId_idx";
ALTER INDEX IF EXISTS "usage_records_workspaceId_userId_createdAt_idx" RENAME TO "usage_records_spaceId_userId_createdAt_idx";
ALTER INDEX IF EXISTS "notification_preferences_workspaceId_userId_key" RENAME TO "notification_preferences_spaceId_userId_key";
ALTER INDEX IF EXISTS "workspace_memory_configs_pkey" RENAME TO "space_memory_configs_pkey";
ALTER INDEX IF EXISTS "workspace_memory_configs_workspaceId_key" RENAME TO "space_memory_configs_spaceId_key";
ALTER INDEX IF EXISTS "workspace_memory_configs_secretId_key" RENAME TO "space_memory_configs_secretId_key";
ALTER INDEX IF EXISTS "secrets_userId_workspaceId_idx" RENAME TO "secrets_userId_spaceId_idx";
ALTER INDEX IF EXISTS "mcp_servers_workspaceId_userId_slug_key" RENAME TO "mcp_servers_spaceId_userId_slug_key";
ALTER INDEX IF EXISTS "mcp_servers_workspaceId_userId_idx" RENAME TO "mcp_servers_spaceId_userId_idx";
ALTER INDEX IF EXISTS "mcp_oauth_sessions_workspaceId_userId_createdAt_idx" RENAME TO "mcp_oauth_sessions_spaceId_userId_createdAt_idx";
ALTER INDEX IF EXISTS "bot_mcp_servers_workspaceId_userId_botId_idx" RENAME TO "bot_mcp_servers_spaceId_userId_botId_idx";

COMMIT;
