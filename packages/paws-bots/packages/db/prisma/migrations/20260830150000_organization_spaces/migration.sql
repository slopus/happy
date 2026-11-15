BEGIN;

-- Organizations remain the company/account boundary. Spaces are the private
-- data, bot, and execution boundary inside an organization.
CREATE TABLE "spaces" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "spaces_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "space_members" (
    "id" TEXT NOT NULL,
    "spaceId" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "space_members_pkey" PRIMARY KEY ("id")
);

-- Preserve every existing resource ID and scope by giving each organization
-- a default space with the same ID. No bot, thread, memory, or secret row
-- needs to be rewritten.
INSERT INTO "spaces" ("id", "organizationId", "name", "createdAt")
SELECT "id", "id", "name", "createdAt"
FROM "organization";

INSERT INTO "space_members" (
    "id",
    "spaceId",
    "organizationId",
    "userId",
    "createdAt"
)
SELECT "id", "organizationId", "organizationId", "userId", "createdAt"
FROM "member";

CREATE UNIQUE INDEX "spaces_id_organizationId_key"
ON "spaces"("id", "organizationId");
CREATE INDEX "spaces_organizationId_createdAt_idx"
ON "spaces"("organizationId", "createdAt");
CREATE UNIQUE INDEX "space_members_spaceId_userId_key"
ON "space_members"("spaceId", "userId");
CREATE INDEX "space_members_organizationId_userId_idx"
ON "space_members"("organizationId", "userId");
CREATE INDEX "space_members_userId_createdAt_idx"
ON "space_members"("userId", "createdAt");

ALTER TABLE "spaces"
ADD CONSTRAINT "spaces_organizationId_fkey"
FOREIGN KEY ("organizationId") REFERENCES "organization"("id")
ON DELETE CASCADE ON UPDATE CASCADE NOT VALID;

ALTER TABLE "space_members"
ADD CONSTRAINT "space_members_spaceId_organizationId_fkey"
FOREIGN KEY ("spaceId", "organizationId")
REFERENCES "spaces"("id", "organizationId")
ON DELETE CASCADE ON UPDATE CASCADE NOT VALID;

ALTER TABLE "space_members"
ADD CONSTRAINT "space_members_organizationId_userId_fkey"
FOREIGN KEY ("organizationId", "userId")
REFERENCES "member"("organizationId", "userId")
ON DELETE CASCADE ON UPDATE CASCADE NOT VALID;

COMMIT;

-- Install each resource's space foreign key alongside its existing
-- organization foreign key. NOT VALID keeps this transaction metadata-only.
BEGIN;

ALTER TABLE "action_approval_rules" ADD CONSTRAINT "action_approval_rules_space_fkey" FOREIGN KEY ("workspaceId") REFERENCES "spaces"("id") ON DELETE CASCADE ON UPDATE CASCADE NOT VALID;
ALTER TABLE "action_auto_review_preferences" ADD CONSTRAINT "action_auto_review_preferences_space_fkey" FOREIGN KEY ("workspaceId") REFERENCES "spaces"("id") ON DELETE CASCADE ON UPDATE CASCADE NOT VALID;
ALTER TABLE "bots" ADD CONSTRAINT "bots_space_fkey" FOREIGN KEY ("workspaceId") REFERENCES "spaces"("id") ON DELETE CASCADE ON UPDATE CASCADE NOT VALID;
ALTER TABLE "bot_sections" ADD CONSTRAINT "bot_sections_space_fkey" FOREIGN KEY ("workspaceId") REFERENCES "spaces"("id") ON DELETE CASCADE ON UPDATE CASCADE NOT VALID;
ALTER TABLE "bot_deletions" ADD CONSTRAINT "bot_deletions_space_fkey" FOREIGN KEY ("workspaceId") REFERENCES "spaces"("id") ON DELETE CASCADE ON UPDATE CASCADE NOT VALID;
ALTER TABLE "chat_groups" ADD CONSTRAINT "chat_groups_space_fkey" FOREIGN KEY ("workspaceId") REFERENCES "spaces"("id") ON DELETE CASCADE ON UPDATE CASCADE NOT VALID;
ALTER TABLE "threads" ADD CONSTRAINT "threads_space_fkey" FOREIGN KEY ("workspaceId") REFERENCES "spaces"("id") ON DELETE CASCADE ON UPDATE CASCADE NOT VALID;
ALTER TABLE "events" ADD CONSTRAINT "events_space_fkey" FOREIGN KEY ("workspaceId") REFERENCES "spaces"("id") ON DELETE CASCADE ON UPDATE CASCADE NOT VALID;
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_space_fkey" FOREIGN KEY ("workspaceId") REFERENCES "spaces"("id") ON DELETE CASCADE ON UPDATE CASCADE NOT VALID;
ALTER TABLE "runs" ADD CONSTRAINT "runs_space_fkey" FOREIGN KEY ("workspaceId") REFERENCES "spaces"("id") ON DELETE CASCADE ON UPDATE CASCADE NOT VALID;
ALTER TABLE "external_effects" ADD CONSTRAINT "external_effects_space_fkey" FOREIGN KEY ("workspaceId") REFERENCES "spaces"("id") ON DELETE CASCADE ON UPDATE CASCADE NOT VALID;
ALTER TABLE "routines" ADD CONSTRAINT "routines_space_fkey" FOREIGN KEY ("workspaceId") REFERENCES "spaces"("id") ON DELETE CASCADE ON UPDATE CASCADE NOT VALID;
ALTER TABLE "scratchpad_items" ADD CONSTRAINT "scratchpad_items_space_fkey" FOREIGN KEY ("workspaceId") REFERENCES "spaces"("id") ON DELETE CASCADE ON UPDATE CASCADE NOT VALID;
ALTER TABLE "taught_skills" ADD CONSTRAINT "taught_skills_space_fkey" FOREIGN KEY ("workspaceId") REFERENCES "spaces"("id") ON DELETE CASCADE ON UPDATE CASCADE NOT VALID;
ALTER TABLE "agent_skills" ADD CONSTRAINT "agent_skills_space_fkey" FOREIGN KEY ("workspaceId") REFERENCES "spaces"("id") ON DELETE CASCADE ON UPDATE CASCADE NOT VALID;
ALTER TABLE "connections" ADD CONSTRAINT "connections_space_fkey" FOREIGN KEY ("workspaceId") REFERENCES "spaces"("id") ON DELETE CASCADE ON UPDATE CASCADE NOT VALID;
ALTER TABLE "capability_installs" ADD CONSTRAINT "capability_installs_space_fkey" FOREIGN KEY ("workspaceId") REFERENCES "spaces"("id") ON DELETE CASCADE ON UPDATE CASCADE NOT VALID;
ALTER TABLE "memory_documents" ADD CONSTRAINT "memory_documents_space_fkey" FOREIGN KEY ("workspaceId") REFERENCES "spaces"("id") ON DELETE CASCADE ON UPDATE CASCADE NOT VALID;
ALTER TABLE "agent_homes" ADD CONSTRAINT "agent_homes_space_fkey" FOREIGN KEY ("workspaceId") REFERENCES "spaces"("id") ON DELETE CASCADE ON UPDATE CASCADE NOT VALID;
ALTER TABLE "browser_profiles" ADD CONSTRAINT "browser_profiles_space_fkey" FOREIGN KEY ("workspaceId") REFERENCES "spaces"("id") ON DELETE CASCADE ON UPDATE CASCADE NOT VALID;
ALTER TABLE "computers" ADD CONSTRAINT "computers_space_fkey" FOREIGN KEY ("workspaceId") REFERENCES "spaces"("id") ON DELETE CASCADE ON UPDATE CASCADE NOT VALID;
ALTER TABLE "artifacts" ADD CONSTRAINT "artifacts_space_fkey" FOREIGN KEY ("workspaceId") REFERENCES "spaces"("id") ON DELETE CASCADE ON UPDATE CASCADE NOT VALID;
ALTER TABLE "usage_records" ADD CONSTRAINT "usage_records_space_fkey" FOREIGN KEY ("workspaceId") REFERENCES "spaces"("id") ON DELETE CASCADE ON UPDATE CASCADE NOT VALID;
ALTER TABLE "notification_preferences" ADD CONSTRAINT "notification_preferences_space_fkey" FOREIGN KEY ("workspaceId") REFERENCES "spaces"("id") ON DELETE CASCADE ON UPDATE CASCADE NOT VALID;
ALTER TABLE "workspace_memory_configs" ADD CONSTRAINT "workspace_memory_configs_space_fkey" FOREIGN KEY ("workspaceId") REFERENCES "spaces"("id") ON DELETE CASCADE ON UPDATE CASCADE NOT VALID;
ALTER TABLE "mcp_servers" ADD CONSTRAINT "mcp_servers_space_fkey" FOREIGN KEY ("workspaceId") REFERENCES "spaces"("id") ON DELETE CASCADE ON UPDATE CASCADE NOT VALID;

COMMIT;

-- Validate the replacement constraints under PostgreSQL's weaker validation
-- locks after the short write-blocking constraint installation transaction.
BEGIN;

ALTER TABLE "spaces" VALIDATE CONSTRAINT "spaces_organizationId_fkey";
ALTER TABLE "space_members" VALIDATE CONSTRAINT "space_members_spaceId_organizationId_fkey";
ALTER TABLE "space_members" VALIDATE CONSTRAINT "space_members_organizationId_userId_fkey";
ALTER TABLE "action_approval_rules" VALIDATE CONSTRAINT "action_approval_rules_space_fkey";
ALTER TABLE "action_auto_review_preferences" VALIDATE CONSTRAINT "action_auto_review_preferences_space_fkey";
ALTER TABLE "bots" VALIDATE CONSTRAINT "bots_space_fkey";
ALTER TABLE "bot_sections" VALIDATE CONSTRAINT "bot_sections_space_fkey";
ALTER TABLE "bot_deletions" VALIDATE CONSTRAINT "bot_deletions_space_fkey";
ALTER TABLE "chat_groups" VALIDATE CONSTRAINT "chat_groups_space_fkey";
ALTER TABLE "threads" VALIDATE CONSTRAINT "threads_space_fkey";
ALTER TABLE "events" VALIDATE CONSTRAINT "events_space_fkey";
ALTER TABLE "tasks" VALIDATE CONSTRAINT "tasks_space_fkey";
ALTER TABLE "runs" VALIDATE CONSTRAINT "runs_space_fkey";
ALTER TABLE "external_effects" VALIDATE CONSTRAINT "external_effects_space_fkey";
ALTER TABLE "routines" VALIDATE CONSTRAINT "routines_space_fkey";
ALTER TABLE "scratchpad_items" VALIDATE CONSTRAINT "scratchpad_items_space_fkey";
ALTER TABLE "taught_skills" VALIDATE CONSTRAINT "taught_skills_space_fkey";
ALTER TABLE "agent_skills" VALIDATE CONSTRAINT "agent_skills_space_fkey";
ALTER TABLE "connections" VALIDATE CONSTRAINT "connections_space_fkey";
ALTER TABLE "capability_installs" VALIDATE CONSTRAINT "capability_installs_space_fkey";
ALTER TABLE "memory_documents" VALIDATE CONSTRAINT "memory_documents_space_fkey";
ALTER TABLE "agent_homes" VALIDATE CONSTRAINT "agent_homes_space_fkey";
ALTER TABLE "browser_profiles" VALIDATE CONSTRAINT "browser_profiles_space_fkey";
ALTER TABLE "computers" VALIDATE CONSTRAINT "computers_space_fkey";
ALTER TABLE "artifacts" VALIDATE CONSTRAINT "artifacts_space_fkey";
ALTER TABLE "usage_records" VALIDATE CONSTRAINT "usage_records_space_fkey";
ALTER TABLE "notification_preferences" VALIDATE CONSTRAINT "notification_preferences_space_fkey";
ALTER TABLE "workspace_memory_configs" VALIDATE CONSTRAINT "workspace_memory_configs_space_fkey";
ALTER TABLE "mcp_servers" VALIDATE CONSTRAINT "mcp_servers_space_fkey";

COMMIT;

-- Validation is complete, so the final name swap only holds brief metadata
-- locks and preserves Prisma's established constraint names.
BEGIN;

ALTER TABLE "action_approval_rules" DROP CONSTRAINT "action_approval_rules_workspaceId_fkey";
ALTER TABLE "action_approval_rules" RENAME CONSTRAINT "action_approval_rules_space_fkey" TO "action_approval_rules_workspaceId_fkey";
ALTER TABLE "action_auto_review_preferences" DROP CONSTRAINT "action_auto_review_preferences_workspaceId_fkey";
ALTER TABLE "action_auto_review_preferences" RENAME CONSTRAINT "action_auto_review_preferences_space_fkey" TO "action_auto_review_preferences_workspaceId_fkey";
ALTER TABLE "bots" DROP CONSTRAINT "bots_workspaceId_fkey";
ALTER TABLE "bots" RENAME CONSTRAINT "bots_space_fkey" TO "bots_workspaceId_fkey";
ALTER TABLE "bot_sections" DROP CONSTRAINT "bot_sections_workspaceId_fkey";
ALTER TABLE "bot_sections" RENAME CONSTRAINT "bot_sections_space_fkey" TO "bot_sections_workspaceId_fkey";
ALTER TABLE "bot_deletions" DROP CONSTRAINT "bot_deletions_workspaceId_fkey";
ALTER TABLE "bot_deletions" RENAME CONSTRAINT "bot_deletions_space_fkey" TO "bot_deletions_workspaceId_fkey";
ALTER TABLE "chat_groups" DROP CONSTRAINT "chat_groups_workspaceId_fkey";
ALTER TABLE "chat_groups" RENAME CONSTRAINT "chat_groups_space_fkey" TO "chat_groups_workspaceId_fkey";
ALTER TABLE "threads" DROP CONSTRAINT "threads_workspaceId_fkey";
ALTER TABLE "threads" RENAME CONSTRAINT "threads_space_fkey" TO "threads_workspaceId_fkey";
ALTER TABLE "events" DROP CONSTRAINT "events_workspaceId_fkey";
ALTER TABLE "events" RENAME CONSTRAINT "events_space_fkey" TO "events_workspaceId_fkey";
ALTER TABLE "tasks" DROP CONSTRAINT "tasks_workspaceId_fkey";
ALTER TABLE "tasks" RENAME CONSTRAINT "tasks_space_fkey" TO "tasks_workspaceId_fkey";
ALTER TABLE "runs" DROP CONSTRAINT "runs_workspaceId_fkey";
ALTER TABLE "runs" RENAME CONSTRAINT "runs_space_fkey" TO "runs_workspaceId_fkey";
ALTER TABLE "external_effects" DROP CONSTRAINT "external_effects_workspaceId_fkey";
ALTER TABLE "external_effects" RENAME CONSTRAINT "external_effects_space_fkey" TO "external_effects_workspaceId_fkey";
ALTER TABLE "routines" DROP CONSTRAINT "routines_workspaceId_fkey";
ALTER TABLE "routines" RENAME CONSTRAINT "routines_space_fkey" TO "routines_workspaceId_fkey";
ALTER TABLE "scratchpad_items" DROP CONSTRAINT "scratchpad_items_workspaceId_fkey";
ALTER TABLE "scratchpad_items" RENAME CONSTRAINT "scratchpad_items_space_fkey" TO "scratchpad_items_workspaceId_fkey";
ALTER TABLE "taught_skills" DROP CONSTRAINT "taught_skills_workspaceId_fkey";
ALTER TABLE "taught_skills" RENAME CONSTRAINT "taught_skills_space_fkey" TO "taught_skills_workspaceId_fkey";
ALTER TABLE "agent_skills" DROP CONSTRAINT "agent_skills_workspaceId_fkey";
ALTER TABLE "agent_skills" RENAME CONSTRAINT "agent_skills_space_fkey" TO "agent_skills_workspaceId_fkey";
ALTER TABLE "connections" DROP CONSTRAINT "connections_workspaceId_fkey";
ALTER TABLE "connections" RENAME CONSTRAINT "connections_space_fkey" TO "connections_workspaceId_fkey";
ALTER TABLE "capability_installs" DROP CONSTRAINT "capability_installs_workspaceId_fkey";
ALTER TABLE "capability_installs" RENAME CONSTRAINT "capability_installs_space_fkey" TO "capability_installs_workspaceId_fkey";
ALTER TABLE "memory_documents" DROP CONSTRAINT "memory_documents_workspaceId_fkey";
ALTER TABLE "memory_documents" RENAME CONSTRAINT "memory_documents_space_fkey" TO "memory_documents_workspaceId_fkey";
ALTER TABLE "agent_homes" DROP CONSTRAINT "agent_homes_workspaceId_fkey";
ALTER TABLE "agent_homes" RENAME CONSTRAINT "agent_homes_space_fkey" TO "agent_homes_workspaceId_fkey";
ALTER TABLE "browser_profiles" DROP CONSTRAINT "browser_profiles_workspaceId_fkey";
ALTER TABLE "browser_profiles" RENAME CONSTRAINT "browser_profiles_space_fkey" TO "browser_profiles_workspaceId_fkey";
ALTER TABLE "computers" DROP CONSTRAINT "computers_workspaceId_fkey";
ALTER TABLE "computers" RENAME CONSTRAINT "computers_space_fkey" TO "computers_workspaceId_fkey";
ALTER TABLE "artifacts" DROP CONSTRAINT "artifacts_workspaceId_fkey";
ALTER TABLE "artifacts" RENAME CONSTRAINT "artifacts_space_fkey" TO "artifacts_workspaceId_fkey";
ALTER TABLE "usage_records" DROP CONSTRAINT "usage_records_workspaceId_fkey";
ALTER TABLE "usage_records" RENAME CONSTRAINT "usage_records_space_fkey" TO "usage_records_workspaceId_fkey";
ALTER TABLE "notification_preferences" DROP CONSTRAINT "notification_preferences_workspaceId_fkey";
ALTER TABLE "notification_preferences" RENAME CONSTRAINT "notification_preferences_space_fkey" TO "notification_preferences_workspaceId_fkey";
ALTER TABLE "workspace_memory_configs" DROP CONSTRAINT "workspace_memory_configs_workspaceId_fkey";
ALTER TABLE "workspace_memory_configs" RENAME CONSTRAINT "workspace_memory_configs_space_fkey" TO "workspace_memory_configs_workspaceId_fkey";
ALTER TABLE "mcp_servers" DROP CONSTRAINT "mcp_servers_workspaceId_fkey";
ALTER TABLE "mcp_servers" RENAME CONSTRAINT "mcp_servers_space_fkey" TO "mcp_servers_workspaceId_fkey";

COMMIT;
