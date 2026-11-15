-- CreateTable
CREATE TABLE "chat_groups" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "chat_groups_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "chat_group_members" (
    "id" TEXT NOT NULL,
    "groupId" TEXT NOT NULL,
    "botId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "chat_group_members_pkey" PRIMARY KEY ("id")
);

-- AlterTable
ALTER TABLE "threads" ALTER COLUMN "botId" DROP NOT NULL;

-- AlterTable
ALTER TABLE "threads" ADD COLUMN "groupId" TEXT;

-- AlterTable
ALTER TABLE "messages" ADD COLUMN "botId" TEXT;
ALTER TABLE "messages" ADD COLUMN "replyToMessageId" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "threads_groupId_key" ON "threads"("groupId");

-- CreateIndex
CREATE INDEX "chat_groups_workspaceId_userId_updatedAt_idx" ON "chat_groups"("workspaceId", "userId", "updatedAt");

-- CreateIndex
CREATE UNIQUE INDEX "chat_group_members_groupId_botId_key" ON "chat_group_members"("groupId", "botId");

-- CreateIndex
CREATE INDEX "chat_group_members_botId_idx" ON "chat_group_members"("botId");

-- AddForeignKey
ALTER TABLE "chat_groups" ADD CONSTRAINT "chat_groups_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chat_group_members" ADD CONSTRAINT "chat_group_members_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "chat_groups"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chat_group_members" ADD CONSTRAINT "chat_group_members_botId_fkey" FOREIGN KEY ("botId") REFERENCES "bots"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "threads" ADD CONSTRAINT "threads_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "chat_groups"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "messages" ADD CONSTRAINT "messages_replyToMessageId_fkey" FOREIGN KEY ("replyToMessageId") REFERENCES "messages"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Ensure each thread is either a 1:1 bot thread or a group thread
ALTER TABLE "threads" ADD CONSTRAINT "threads_bot_or_group_chk" CHECK (
    ("botId" IS NOT NULL AND "groupId" IS NULL) OR ("botId" IS NULL AND "groupId" IS NOT NULL)
);
