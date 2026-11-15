-- Every way a chat-started run ends schedules the backup that delivers what it said, in the same
-- transaction as the status change. The process that finished the run delivers it straight away
-- and removes the job; a cancelled run usually has no such process, so its job is due at once.
-- Fresh installations create Graphile's schema after application migrations.
CREATE OR REPLACE FUNCTION schedule_run_reply_delivery() RETURNS trigger
LANGUAGE plpgsql AS $reply$
BEGIN
  IF to_regnamespace('graphile_worker') IS NOT NULL THEN
    PERFORM graphile_worker.add_job(
      'messaging.reply',
      json_build_object('runId', NEW.id),
      run_at => CASE WHEN NEW.status = 'cancelled' THEN now() ELSE now() + interval '90 seconds' END,
      job_key => 'messaging.reply:' || NEW.id
    );
  END IF;
  RETURN NEW;
END;
$reply$;
DROP TRIGGER IF EXISTS runs_schedule_reply_delivery ON runs;
CREATE TRIGGER runs_schedule_reply_delivery AFTER UPDATE OF status ON runs
FOR EACH ROW
WHEN (
  NEW.status IS DISTINCT FROM OLD.status
  AND NEW.status IN ('completed', 'failed', 'cancelled')
  AND NEW.trigger IN ('messaging', 'bot_message')
)
EXECUTE FUNCTION schedule_run_reply_delivery();
