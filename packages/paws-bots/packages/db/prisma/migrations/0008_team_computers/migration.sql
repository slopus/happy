-- Existing bots keep their dedicated computers. New bots default to the
-- workspace Team Computer through application-level provisioning.
ALTER TABLE "bots"
  ADD COLUMN "computerId" TEXT,
  ADD COLUMN "computerSwitching" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "computers"
  ADD COLUMN "scope" TEXT NOT NULL DEFAULT 'dedicated',
  ADD COLUMN "scopeKey" TEXT,
  ADD COLUMN "homeKey" TEXT,
  ADD COLUMN "homeRevision" TEXT NOT NULL DEFAULT 'empty',
  ADD COLUMN "controlBotId" TEXT,
  ADD COLUMN "executionRunId" TEXT,
  ADD COLUMN "executionBotId" TEXT,
  ADD COLUMN "executionLeaseExpiresAt" TIMESTAMP(3),
  ADD COLUMN "executionFence" INTEGER NOT NULL DEFAULT 0;

UPDATE "computers" AS computer
SET
  "scopeKey" = 'bot:' || computer."botId",
  "homeKey" = computer."botId",
  "controlBotId" = CASE WHEN computer."controlLeaseId" IS NULL THEN NULL ELSE computer."botId" END,
  "homeRevision" = COALESCE(home."revision", 'empty')
FROM "agent_homes" AS home
WHERE home."botId" = computer."botId";

UPDATE "computers"
SET
  "scopeKey" = COALESCE("scopeKey", 'bot:' || "botId"),
  "homeKey" = COALESCE("homeKey", "botId");

UPDATE "bots" AS bot
SET "computerId" = computer."id"
FROM "computers" AS computer
WHERE computer."botId" = bot."id";

ALTER TABLE "computers" DROP CONSTRAINT "computers_botId_fkey";
DROP INDEX "computers_botId_key";
ALTER TABLE "computers" DROP COLUMN "botId";
ALTER TABLE "computers" ALTER COLUMN "scopeKey" SET NOT NULL;
ALTER TABLE "computers" ALTER COLUMN "homeKey" SET NOT NULL;
ALTER TABLE "computers" ADD CONSTRAINT "computers_scope_check"
  CHECK ("scope" IN ('team', 'dedicated'));

CREATE UNIQUE INDEX "computers_scopeKey_key" ON "computers"("scopeKey");
CREATE UNIQUE INDEX "computers_homeKey_key" ON "computers"("homeKey");
CREATE INDEX "computers_workspaceId_scope_idx" ON "computers"("workspaceId", "scope");
CREATE INDEX "bots_computerId_idx" ON "bots"("computerId");

ALTER TABLE "bots" ADD CONSTRAINT "bots_computerId_fkey"
  FOREIGN KEY ("computerId") REFERENCES "computers"("id") ON DELETE SET NULL ON UPDATE CASCADE;
