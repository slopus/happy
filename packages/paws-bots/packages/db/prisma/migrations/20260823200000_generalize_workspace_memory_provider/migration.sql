-- Replace the original provider-specific columns with an extensible provider configuration.
ALTER TABLE "workspace_memory_configs"
ADD COLUMN "provider" TEXT,
ADD COLUMN "settings" JSONB;

UPDATE "workspace_memory_configs"
SET
  "provider" = 'supermemory',
  "settings" = jsonb_build_object('mode', "mode", 'baseUrl', "baseUrl");

ALTER TABLE "workspace_memory_configs"
ALTER COLUMN "provider" SET NOT NULL,
ALTER COLUMN "settings" SET NOT NULL,
DROP CONSTRAINT "workspace_memory_configs_mode_check",
DROP COLUMN "mode",
DROP COLUMN "baseUrl";
