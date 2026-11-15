CREATE TABLE "steering_messages" (
    "id" TEXT NOT NULL,
    "messageId" TEXT NOT NULL,
    "botId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "runId" TEXT,
    "claimedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "steering_messages_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "steering_messages_messageId_botId_key"
ON "steering_messages"("messageId", "botId");

CREATE INDEX "steering_messages_botId_runId_createdAt_idx"
ON "steering_messages"("botId", "runId", "createdAt");

CREATE INDEX "steering_messages_runId_idx" ON "steering_messages"("runId");

ALTER TABLE "steering_messages"
ADD CONSTRAINT "steering_messages_messageId_fkey"
FOREIGN KEY ("messageId") REFERENCES "messages"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "steering_messages"
ADD CONSTRAINT "steering_messages_botId_fkey"
FOREIGN KEY ("botId") REFERENCES "bots"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "steering_messages"
ADD CONSTRAINT "steering_messages_runId_fkey"
FOREIGN KEY ("runId") REFERENCES "runs"("id") ON DELETE SET NULL ON UPDATE CASCADE;