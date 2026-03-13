-- CreateTable
CREATE TABLE "SessionPendingMessage" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "localId" TEXT NOT NULL,
    "content" JSONB NOT NULL,
    "sentBy" TEXT,
    "sentByName" TEXT,
    "trackCliDelivery" BOOLEAN NOT NULL DEFAULT false,
    "pinnedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SessionPendingMessage_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "SessionPendingMessage_sessionId_localId_key" ON "SessionPendingMessage"("sessionId", "localId");

-- CreateIndex
CREATE INDEX "SessionPendingMessage_sessionId_pinnedAt_createdAt_idx" ON "SessionPendingMessage"("sessionId", "pinnedAt", "createdAt");

-- AddForeignKey
ALTER TABLE "SessionPendingMessage" ADD CONSTRAINT "SessionPendingMessage_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "Session"("id") ON DELETE CASCADE ON UPDATE CASCADE;
