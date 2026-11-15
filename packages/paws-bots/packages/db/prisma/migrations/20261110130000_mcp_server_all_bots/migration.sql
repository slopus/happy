-- Servers added before this keep reaching only their assigned agents: a server a bot added
-- and the user has not approved yet has no assignment either, so none is widened here.
ALTER TABLE "mcp_servers" ADD COLUMN "allBots" BOOLEAN NOT NULL DEFAULT false;
