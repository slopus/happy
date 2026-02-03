-- AlterTable
ALTER TABLE "Account" ADD COLUMN     "feedSeq" BIGINT NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "UserFeedItem" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "counter" BIGINT NOT NULL,
    "repeatKey" TEXT,
    "body" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "UserFeedItem_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "UserFeedItem_userId_counter_idx" ON "UserFeedItem"("userId", "counter" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "UserFeedItem_userId_counter_key" ON "UserFeedItem"("userId", "counter");

-- CreateIndex
CREATE UNIQUE INDEX "UserFeedItem_userId_repeatKey_key" ON "UserFeedItem"("userId", "repeatKey");

-- AddForeignKey
ALTER TABLE "UserFeedItem" ADD CONSTRAINT "UserFeedItem_userId_fkey" FOREIGN KEY ("userId") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE;
