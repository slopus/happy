-- Each member's own read state for a chat, a personal resource (userId, spaceId). Additive:
-- the previous release keeps writing threads.unread and threads."lastReadSeq" while it runs;
-- 20261202120100_drop_thread_unread drops them once it has stopped.

BEGIN;

-- Holds off the previous release's writes to threads from the backfill until the trigger that
-- mirrors them is in place, so none lands in between and is lost.
LOCK TABLE "threads" IN SHARE ROW EXCLUSIVE MODE;

CREATE TABLE "thread_reads" (
    "threadId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "spaceId" TEXT NOT NULL,
    "unread" BOOLEAN NOT NULL DEFAULT false,
    "lastReadSeq" INTEGER NOT NULL DEFAULT -1,

    CONSTRAINT "thread_reads_pkey" PRIMARY KEY ("threadId", "userId")
);

CREATE INDEX "thread_reads_spaceId_userId_idx" ON "thread_reads"("spaceId", "userId");

ALTER TABLE "thread_reads" ADD CONSTRAINT "thread_reads_threadId_fkey" FOREIGN KEY ("threadId") REFERENCES "threads"("id") ON DELETE CASCADE ON UPDATE CASCADE;
-- Leaving a Space deletes the membership, and with it the person's read state there.
ALTER TABLE "thread_reads" ADD CONSTRAINT "thread_reads_spaceId_userId_fkey" FOREIGN KEY ("spaceId", "userId") REFERENCES "space_members"("spaceId", "userId") ON DELETE CASCADE ON UPDATE CASCADE;

-- No row reads as caught up, so only unread chats need one. Every member starts from the state
-- they all shared until now.
INSERT INTO "thread_reads" ("threadId", "userId", "spaceId", "unread", "lastReadSeq")
SELECT t."id", m."userId", t."spaceId", true, t."lastReadSeq"
FROM "threads" t
JOIN "space_members" m ON m."spaceId" = t."spaceId"
WHERE t."unread";

-- A member's own rows. Marking a chat unread for the other members is a named system step.
ALTER TABLE "thread_reads" ENABLE ROW LEVEL SECURITY;
CREATE POLICY thread_reads_tenant ON "thread_reads"
  USING ("spaceId" = NULLIF(current_setting('app.space_id', true), '')
     AND "userId" = NULLIF(current_setting('app.user_id', true), ''));
CREATE POLICY thread_reads_system ON "thread_reads"
  USING ((SELECT app_rls_bypass()));

-- The previous release reads and writes the shared flag on the thread. While it finishes its
-- runs, what it writes there applies to every member, as it did before: a reply marks the chat
-- unread for everyone (from the message it wrote), and reading or clearing it reads it for
-- everyone.
CREATE FUNCTION thread_reads_mirror_unread() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public
  AS $$
DECLARE
  -- Mark as Unread from a message: the old release moved its cursor to just before it.
  moved boolean := NEW."lastReadSeq" IS DISTINCT FROM OLD."lastReadSeq"
    AND NEW."nextMessageSeq" = OLD."nextMessageSeq";
BEGIN
  IF NOT NEW."unread" THEN
    UPDATE "thread_reads" SET "unread" = false WHERE "threadId" = NEW."id";
    RETURN NEW;
  END IF;
  -- Someone with no read state had read what came before, as markThreadUnreadForMembers does.
  INSERT INTO "thread_reads" ("threadId", "userId", "spaceId", "unread", "lastReadSeq")
  SELECT NEW."id", m."userId", NEW."spaceId", true,
    CASE
      WHEN moved THEN NEW."lastReadSeq"
      -- A reply it wrote: everything before it.
      WHEN NEW."nextMessageSeq" > OLD."nextMessageSeq" THEN GREATEST(NEW."nextMessageSeq" - 2, -1)
      -- Marked unread by hand: all of it.
      ELSE NEW."nextMessageSeq" - 1
    END
  FROM "space_members" m
  WHERE m."spaceId" = NEW."spaceId"
  ON CONFLICT ("threadId", "userId") DO UPDATE SET
    "unread" = true,
    "lastReadSeq" = CASE WHEN moved THEN EXCLUDED."lastReadSeq" ELSE "thread_reads"."lastReadSeq" END;
  RETURN NEW;
END $$;
CREATE TRIGGER threads_mirror_unread AFTER UPDATE OF "unread" ON "threads"
  FOR EACH ROW EXECUTE FUNCTION thread_reads_mirror_unread();

COMMIT;
