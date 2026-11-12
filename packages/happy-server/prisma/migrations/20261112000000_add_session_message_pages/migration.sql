-- CreateTable
CREATE TABLE "SessionMessagePage" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "startSeq" INTEGER NOT NULL,
    "endSeq" INTEGER NOT NULL,
    "count" INTEGER NOT NULL,
    "objectKey" TEXT NOT NULL,
    "bytes" INTEGER NOT NULL,
    "sha256" TEXT NOT NULL,
    "minCreatedAt" TIMESTAMP(3) NOT NULL,
    "maxCreatedAt" TIMESTAMP(3) NOT NULL,
    "state" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "verifiedAt" TIMESTAMP(3),

    CONSTRAINT "SessionMessagePage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SessionMessageLocalId" (
    "sessionId" TEXT NOT NULL,
    "localId" TEXT NOT NULL,
    "seq" INTEGER NOT NULL,

    CONSTRAINT "SessionMessageLocalId_pkey" PRIMARY KEY ("sessionId","localId")
);

-- CreateIndex
CREATE INDEX "SessionMessagePage_state_idx" ON "SessionMessagePage"("state");

-- CreateIndex
CREATE UNIQUE INDEX "SessionMessagePage_sessionId_startSeq_key" ON "SessionMessagePage"("sessionId", "startSeq");

