-- Tie request idempotency to the user message rather than the current set of fan-out runs.
ALTER TABLE "messages" ADD COLUMN "clientNonce" TEXT;
ALTER TABLE "runs" ADD COLUMN "sourceMessageId" TEXT;

CREATE UNIQUE INDEX "messages_threadId_clientNonce_key"
ON "messages"("threadId", "clientNonce");

CREATE INDEX "runs_sourceMessageId_idx" ON "runs"("sourceMessageId");
CREATE INDEX "runs_threadId_status_createdAt_idx" ON "runs"("threadId", "status", "createdAt");

ALTER TABLE "runs"
ADD CONSTRAINT "runs_sourceMessageId_fkey"
FOREIGN KEY ("sourceMessageId") REFERENCES "messages"("id")
ON DELETE SET NULL ON UPDATE CASCADE;

-- Direct bot deletion must fail instead of silently leaving an invalid one-member group.
-- The supported deletion path explicitly removes the membership or the whole group first.
ALTER TABLE "chat_group_members"
DROP CONSTRAINT "chat_group_members_botId_fkey";

ALTER TABLE "chat_group_members"
ADD CONSTRAINT "chat_group_members_botId_fkey"
FOREIGN KEY ("botId") REFERENCES "bots"("id")
ON DELETE NO ACTION ON UPDATE CASCADE
DEFERRABLE INITIALLY DEFERRED;

-- Group attachments outlive individual membership changes and are removed with the group.
ALTER TABLE "artifacts" ADD COLUMN "groupId" TEXT;
ALTER TABLE "artifacts" ALTER COLUMN "botId" DROP NOT NULL;

ALTER TABLE "artifacts" DROP CONSTRAINT "artifacts_botId_fkey";

ALTER TABLE "artifacts"
ADD CONSTRAINT "artifacts_botId_fkey"
FOREIGN KEY ("botId") REFERENCES "bots"("id")
ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "artifacts"
ADD CONSTRAINT "artifacts_groupId_fkey"
FOREIGN KEY ("groupId") REFERENCES "chat_groups"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

CREATE INDEX "artifacts_groupId_idx" ON "artifacts"("groupId");
