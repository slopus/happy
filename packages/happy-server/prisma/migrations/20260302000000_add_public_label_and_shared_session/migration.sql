-- AlterTable
ALTER TABLE "Session" ADD COLUMN "publicLabel" TEXT;

-- CreateIndex
CREATE INDEX "Session_accountId_publicLabel_active_idx" ON "Session"("accountId", "publicLabel", "active");

-- CreateTable
CREATE TABLE "SharedSession" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "sessionId" TEXT,
    "title" TEXT NOT NULL DEFAULT '',
    "messages" JSONB NOT NULL,
    "viewCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SharedSession_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "SharedSession_accountId_idx" ON "SharedSession"("accountId");
