-- Additive: older API and worker releases continue using the existing run fields.
ALTER TABLE "runs" ADD COLUMN "wakeAt" TIMESTAMP(3),
                   ADD COLUMN "firstResponseAt" TIMESTAMP(3);
CREATE INDEX "runs_status_wakeAt_idx" ON "runs"("status", "wakeAt");

-- Preserve pending legacy retry backoff when moving dispatch out of Graphile.
-- Fresh installations create Graphile's schema after application migrations.
DO $$ BEGIN
  IF to_regclass('graphile_worker._private_jobs') IS NOT NULL THEN
    UPDATE runs AS r SET "wakeAt" = scheduled.due
    FROM (
      SELECT coalesce(j.payload->>'runId', j.payload->'payload'->>'runId') AS run_id,
             max(j.run_at) AT TIME ZONE 'UTC' AS due
      FROM graphile_worker._private_jobs j
      JOIN graphile_worker._private_tasks t ON t.id = j.task_id
      WHERE t.identifier IN ('run.continue', 'run.interactive')
        AND j.attempts < j.max_attempts
      GROUP BY coalesce(j.payload->>'runId', j.payload->'payload'->>'runId')
    ) scheduled
    WHERE r.id = scheduled.run_id AND r.status = 'queued';
  END IF;
END $$;

-- The previous worker release requeues before publishing its retry. Preserve its
-- bounded computer/setup backoff atomically even when it does not know wakeAt.
-- Explicit schedules written by the new worker take precedence. Remove this
-- compatibility trigger only after releases that omit wakeAt have drained.
CREATE OR REPLACE FUNCTION preserve_legacy_run_retry_wake() RETURNS trigger
LANGUAGE plpgsql AS $legacy$
BEGIN
  IF OLD.status IN ('leased', 'running') AND NEW.status = 'queued'
     AND NEW."leaseOwner" IS NULL AND NEW."leaseExpiresAt" IS NULL
     AND NEW."wakeAt" IS NOT DISTINCT FROM OLD."wakeAt" THEN
    NEW."wakeAt" := (clock_timestamp() AT TIME ZONE 'UTC') +
      INTERVAL '1 millisecond' * least(10000, 250 * power(2, least(greatest(NEW."leaseFence" - 1, 0), 5)));
  END IF;
  RETURN NEW;
END;
$legacy$;
DROP TRIGGER IF EXISTS runs_legacy_retry_wake ON runs;
CREATE TRIGGER runs_legacy_retry_wake BEFORE UPDATE ON runs
FOR EACH ROW EXECUTE FUNCTION preserve_legacy_run_retry_wake();
