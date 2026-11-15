-- Additive: older releases never read or write it.
ALTER TABLE "mcp_servers" ADD COLUMN "hasArgs" BOOLEAN NOT NULL DEFAULT false;
UPDATE "mcp_servers" SET "hasArgs" = true WHERE jsonb_typeof("args") = 'array' AND jsonb_array_length("args") > 0;
