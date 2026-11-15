-- Additive: older releases never read or write it.
ALTER TABLE "mcp_servers" ADD COLUMN "verbatimResults" BOOLEAN NOT NULL DEFAULT false;
