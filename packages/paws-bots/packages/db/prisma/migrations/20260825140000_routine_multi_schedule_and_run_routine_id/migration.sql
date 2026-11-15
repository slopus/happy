-- Routines can now have more than one "when to run" schedule. Existing
-- single-cron rows become a one-element array so nothing loses its schedule.
ALTER TABLE "routines" ADD COLUMN "crons" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
UPDATE "routines" SET "crons" = ARRAY["cron"] WHERE "cron" IS NOT NULL;
ALTER TABLE "routines" ALTER COLUMN "crons" DROP DEFAULT;
ALTER TABLE "routines" DROP COLUMN "cron";

-- Tracks which routine fired a given run, so the routine list can show a
-- live "Running" badge and the run can be linked back to its schedule.
-- The index and foreign key are added in later migrations, each as the
-- sole statement in its file, so CONCURRENTLY/NOT VALID actually apply
-- instead of running inside this file's implicit transaction.
ALTER TABLE "runs" ADD COLUMN "routineId" TEXT;
