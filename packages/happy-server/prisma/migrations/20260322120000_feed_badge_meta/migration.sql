-- AlterTable
ALTER TABLE "UserFeedItem" ADD COLUMN "badge" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "UserFeedItem" ADD COLUMN "meta" JSONB;
