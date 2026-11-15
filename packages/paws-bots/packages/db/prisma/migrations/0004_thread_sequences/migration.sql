ALTER TABLE "threads"
ADD COLUMN "nextEventSeq" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "nextMessageSeq" INTEGER NOT NULL DEFAULT 0;

UPDATE "threads" AS thread
SET
  "nextEventSeq" = COALESCE(
    (SELECT MAX(event."seq") + 1 FROM "events" AS event WHERE event."threadId" = thread."id"),
    0
  ),
  "nextMessageSeq" = COALESCE(
    (SELECT MAX(message."seq") + 1 FROM "messages" AS message WHERE message."threadId" = thread."id"),
    0
  );

CREATE INDEX "events_runId_type_seq_idx" ON "events"("runId", "type", "seq");
