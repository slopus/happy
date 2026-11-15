-- Provider-neutral team/external room conversations on the messaging surface.
-- Slack (and later Teams/Discord) are adapters; this schema is not Slack-shaped.

CREATE TABLE "external_conversations" (
    "id" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "externalKey" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "displayName" TEXT,
    "participantNames" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "teamChatAmbientEnabled" BOOLEAN,
    "teamChatRules" TEXT,
    "automatedSenderPolicies" JSONB NOT NULL DEFAULT '{}',
    "spaceId" TEXT NOT NULL,
    "botId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "external_conversations_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "external_messages" (
    "id" TEXT NOT NULL,
    "externalConversationId" TEXT NOT NULL,
    "providerEventId" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'direct',
    "senderId" TEXT NOT NULL,
    "senderName" TEXT NOT NULL,
    "senderIsBot" BOOLEAN NOT NULL DEFAULT false,
    "content" TEXT NOT NULL,
    "replyThreadId" TEXT,
    "batchContext" TEXT,
    "engagementReason" TEXT,
    "judgedAt" TIMESTAMP(3),
    "status" TEXT NOT NULL DEFAULT 'received',
    "runId" TEXT,
    "threadMessageId" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" TIMESTAMP(3),
    "lastError" TEXT,
    "providerReplyHandle" TEXT,
    "deliveredAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "external_messages_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "threads" ADD COLUMN "externalConversationId" TEXT;

ALTER TABLE "bots"
  ADD COLUMN "teamChatAmbientEnabled" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "teamChatRules" TEXT NOT NULL DEFAULT '';

ALTER TABLE "runs" ADD COLUMN "teamChatMirroredAt" TIMESTAMP(3);

CREATE UNIQUE INDEX "external_conversations_provider_workspaceId_externalKey_key"
ON "external_conversations"("provider", "workspaceId", "externalKey");
CREATE INDEX "external_conversations_spaceId_botId_idx"
ON "external_conversations"("spaceId", "botId");
CREATE UNIQUE INDEX "threads_externalConversationId_key"
ON "threads"("externalConversationId");
CREATE UNIQUE INDEX "external_messages_runId_key" ON "external_messages"("runId");
CREATE UNIQUE INDEX "external_messages_threadMessageId_key" ON "external_messages"("threadMessageId");
CREATE UNIQUE INDEX "external_messages_externalConversationId_providerEventId_key"
ON "external_messages"("externalConversationId", "providerEventId");
CREATE INDEX "external_messages_status_nextAttemptAt_idx"
ON "external_messages"("status", "nextAttemptAt");
CREATE INDEX "runs_trigger_status_teamChatMirroredAt_updatedAt_idx"
ON "runs"("trigger", "status", "teamChatMirroredAt", "updatedAt");

ALTER TABLE "external_conversations"
ADD CONSTRAINT "external_conversations_spaceId_fkey"
FOREIGN KEY ("spaceId") REFERENCES "spaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "external_conversations"
ADD CONSTRAINT "external_conversations_botId_fkey"
FOREIGN KEY ("botId") REFERENCES "bots"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "threads"
ADD CONSTRAINT "threads_externalConversationId_fkey"
FOREIGN KEY ("externalConversationId") REFERENCES "external_conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "external_messages"
ADD CONSTRAINT "external_messages_externalConversationId_fkey"
FOREIGN KEY ("externalConversationId") REFERENCES "external_conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "external_messages"
ADD CONSTRAINT "external_messages_runId_fkey"
FOREIGN KEY ("runId") REFERENCES "runs"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "external_messages"
ADD CONSTRAINT "external_messages_threadMessageId_fkey"
FOREIGN KEY ("threadMessageId") REFERENCES "messages"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "threads" DROP CONSTRAINT "threads_bot_or_group_chk";
ALTER TABLE "threads" ADD CONSTRAINT "threads_owner_chk" CHECK (
  num_nonnulls("botId", "groupId", "externalConversationId") = 1
);
