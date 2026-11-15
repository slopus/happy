ALTER TABLE "routines" ADD COLUMN "threadId" TEXT;

ALTER TABLE "routines" ADD CONSTRAINT "routines_threadId_fkey" FOREIGN KEY ("threadId") REFERENCES "threads"("id") ON DELETE SET NULL ON UPDATE CASCADE NOT VALID;
