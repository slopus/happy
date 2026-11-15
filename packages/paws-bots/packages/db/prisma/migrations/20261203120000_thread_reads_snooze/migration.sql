-- A member's own snooze for a chat. Additive; the previous release never reads it.
ALTER TABLE "thread_reads" ADD COLUMN "snoozedUntil" TIMESTAMP(3);
