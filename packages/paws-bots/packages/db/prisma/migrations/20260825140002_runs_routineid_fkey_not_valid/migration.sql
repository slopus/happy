-- NOT VALID lets this commit without scanning the table, so the write
-- lock it briefly takes doesn't linger. VALIDATE CONSTRAINT runs in the
-- next migration, its own transaction — combining both here would hold
-- this statement's lock for the full validation scan instead.
ALTER TABLE "runs" ADD CONSTRAINT "runs_routineId_fkey" FOREIGN KEY ("routineId") REFERENCES "routines"("id") ON DELETE SET NULL ON UPDATE CASCADE NOT VALID;
