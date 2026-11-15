-- Plugin marketplace: link plugin installs to the skills and MCP servers they create, so
-- removing a plugin removes them, and keep the text reference files a skill ships.

ALTER TABLE "agent_skills" ADD COLUMN "installId" TEXT;
ALTER TABLE "mcp_servers" ADD COLUMN "installId" TEXT;

ALTER TABLE "agent_skills"
  ADD CONSTRAINT "agent_skills_installId_fkey"
  FOREIGN KEY ("installId") REFERENCES "capability_installs"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "mcp_servers"
  ADD CONSTRAINT "mcp_servers_installId_fkey"
  FOREIGN KEY ("installId") REFERENCES "capability_installs"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

CREATE INDEX "agent_skills_installId_idx" ON "agent_skills"("installId");
CREATE INDEX "mcp_servers_installId_idx" ON "mcp_servers"("installId");

-- Text reference files that ship beside a skill's SKILL.md (plugin skills).
ALTER TABLE "agent_skills" ADD COLUMN "files" JSONB;
