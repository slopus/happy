-- CreateEnum
CREATE TYPE "SessionMessageDeliveryIssueStatus" AS ENUM ('waiting', 'error');

-- CreateTable
CREATE TABLE "SessionMessageDeliveryIssue" (
    "id" TEXT NOT NULL,
    "sessionMessageId" TEXT NOT NULL,
    "status" "SessionMessageDeliveryIssueStatus" NOT NULL,
    "reason" TEXT,
    "extra" JSONB,

    CONSTRAINT "SessionMessageDeliveryIssue_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "SessionMessageDeliveryIssue_sessionMessageId_key" ON "SessionMessageDeliveryIssue"("sessionMessageId");

-- CreateIndex
CREATE INDEX "SessionMessageDeliveryIssue_status_idx" ON "SessionMessageDeliveryIssue"("status");

-- AddForeignKey
ALTER TABLE "SessionMessageDeliveryIssue" ADD CONSTRAINT "SessionMessageDeliveryIssue_sessionMessageId_fkey" FOREIGN KEY ("sessionMessageId") REFERENCES "SessionMessage"("id") ON DELETE CASCADE ON UPDATE CASCADE;
