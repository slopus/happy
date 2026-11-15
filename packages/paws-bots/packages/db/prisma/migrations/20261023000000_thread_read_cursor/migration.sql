ALTER TABLE "threads" ADD COLUMN "lastReadSeq" INTEGER NOT NULL DEFAULT -1;

-- Existing chats count as read up to their latest message, so no divider appears
-- for history that predates the cursor; their unread dot is unchanged.
UPDATE "threads" SET "lastReadSeq" = "nextMessageSeq" - 1 WHERE "nextMessageSeq" > 0;
