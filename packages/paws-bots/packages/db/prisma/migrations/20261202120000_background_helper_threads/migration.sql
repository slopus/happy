-- Additive: the previous release never writes this column, and every thread it creates
-- still has exactly one owner.
ALTER TABLE "threads" ADD COLUMN "helperBotId" TEXT;

-- NOT VALID lets both constraints commit without scanning threads under their locks; each is
-- validated in its own later migration, which lets reads and writes continue.
ALTER TABLE "threads" ADD CONSTRAINT "threads_helperBotId_fkey" FOREIGN KEY ("helperBotId") REFERENCES "bots"("id") ON DELETE CASCADE ON UPDATE CASCADE NOT VALID;

-- A background helper's thread is owned by the bot that started it.
ALTER TABLE "threads" DROP CONSTRAINT "threads_owner_chk";
ALTER TABLE "threads" ADD CONSTRAINT "threads_owner_chk" CHECK (
  num_nonnulls("botId", "groupId", "externalConversationId", "helperBotId") = 1
) NOT VALID;
