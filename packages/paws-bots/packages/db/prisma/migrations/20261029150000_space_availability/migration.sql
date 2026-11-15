-- Skills, MCP servers and plugin or tool-source installs belong to the account that added them
-- and are available in the space they were added in, every space ("allSpaces"), or chosen further
-- spaces. Additive: existing rows keep allSpaces false and no further spaces, so each stays
-- available only where it is today, and the previous release reads them unchanged.

ALTER TABLE "agent_skills" ADD COLUMN "allSpaces" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "mcp_servers" ADD COLUMN "allSpaces" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "capability_installs" ADD COLUMN "allSpaces" BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE "agent_skill_spaces" (
  "skillId" TEXT NOT NULL,
  "spaceId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  CONSTRAINT "agent_skill_spaces_pkey" PRIMARY KEY ("skillId", "spaceId"),
  CONSTRAINT "agent_skill_spaces_skillId_fkey" FOREIGN KEY ("skillId")
    REFERENCES "agent_skills"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "agent_skill_spaces_spaceId_fkey" FOREIGN KEY ("spaceId")
    REFERENCES "spaces"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "agent_skill_spaces_spaceId_userId_idx" ON "agent_skill_spaces"("spaceId", "userId");

CREATE TABLE "mcp_server_spaces" (
  "serverId" TEXT NOT NULL,
  "spaceId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  CONSTRAINT "mcp_server_spaces_pkey" PRIMARY KEY ("serverId", "spaceId"),
  CONSTRAINT "mcp_server_spaces_serverId_fkey" FOREIGN KEY ("serverId")
    REFERENCES "mcp_servers"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "mcp_server_spaces_spaceId_fkey" FOREIGN KEY ("spaceId")
    REFERENCES "spaces"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "mcp_server_spaces_spaceId_userId_idx" ON "mcp_server_spaces"("spaceId", "userId");

CREATE TABLE "capability_install_spaces" (
  "installId" TEXT NOT NULL,
  "spaceId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  CONSTRAINT "capability_install_spaces_pkey" PRIMARY KEY ("installId", "spaceId"),
  CONSTRAINT "capability_install_spaces_installId_fkey" FOREIGN KEY ("installId")
    REFERENCES "capability_installs"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "capability_install_spaces_spaceId_fkey" FOREIGN KEY ("spaceId")
    REFERENCES "spaces"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "capability_install_spaces_spaceId_userId_idx"
  ON "capability_install_spaces"("spaceId", "userId");

-- The credential of an item available beyond one space belongs to the account (spaceId NULL),
-- so every space the item reaches can read it, as model and voice credentials already do.
-- Only loosened: every row the previous release writes still satisfies it.
ALTER TABLE "secrets" DROP CONSTRAINT "secrets_scope_check";
ALTER TABLE "secrets" ADD CONSTRAINT "secrets_scope_check"
  CHECK ("kind" NOT IN ('model', 'voice') OR "spaceId" IS NULL) NOT VALID;
ALTER TABLE "secrets" VALIDATE CONSTRAINT "secrets_scope_check";

-- Availability rows are their owner's alone, in whichever of the owner's spaces they are read.
DO $$
DECLARE
  protected text;
BEGIN
  FOREACH protected IN ARRAY ARRAY['agent_skill_spaces', 'mcp_server_spaces', 'capability_install_spaces'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', protected);
    EXECUTE format(
      'CREATE POLICY %I ON %I USING ("userId" = NULLIF(current_setting(''app.user_id'', true), ''''))',
      protected || '_tenant', protected);
    EXECUTE format(
      'CREATE POLICY %I ON %I USING (current_setting(''app.rls_bypass'', true) = ''on'')',
      protected || '_system', protected);
  END LOOP;
END $$;

-- Permissive, so the existing "added in this space" policies still apply beside it: the owner
-- also reaches an item from any other space it is available in, and nobody else does.
CREATE POLICY agent_skills_available ON "agent_skills"
  USING (
    "userId" = NULLIF(current_setting('app.user_id', true), '')
    AND (
      "allSpaces"
      OR EXISTS (
        SELECT 1 FROM "agent_skill_spaces" a
        WHERE a."skillId" = "agent_skills"."id"
          AND a."spaceId" = NULLIF(current_setting('app.space_id', true), '')
      )
    )
  );
CREATE POLICY mcp_servers_available ON "mcp_servers"
  USING (
    "userId" = NULLIF(current_setting('app.user_id', true), '')
    AND (
      "allSpaces"
      OR EXISTS (
        SELECT 1 FROM "mcp_server_spaces" a
        WHERE a."serverId" = "mcp_servers"."id"
          AND a."spaceId" = NULLIF(current_setting('app.space_id', true), '')
      )
    )
  );
