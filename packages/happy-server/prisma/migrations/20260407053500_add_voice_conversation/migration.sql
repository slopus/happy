-- CreateTable
CREATE TABLE "VoiceConversation" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "elevenLabsConversationId" TEXT NOT NULL,
    "durationSecs" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "VoiceConversation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "VoiceConversation_elevenLabsConversationId_key" ON "VoiceConversation"("elevenLabsConversationId");

-- CreateIndex
CREATE INDEX "VoiceConversation_accountId_createdAt_idx" ON "VoiceConversation"("accountId", "createdAt" DESC);

-- AddForeignKey
ALTER TABLE "VoiceConversation" ADD CONSTRAINT "VoiceConversation_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
