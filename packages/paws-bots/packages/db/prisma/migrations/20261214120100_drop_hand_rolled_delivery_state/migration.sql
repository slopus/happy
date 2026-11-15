-- deferred
-- Chat delivery retries and recovers through Graphile jobs (20261214120000_run_reply_delivery_job).
-- The release that kept its own attempt counts, retry times and claims has stopped. Dropping a
-- column drops the indexes built on it.
-- A delegated reply that release relayed has no outbound row, only this marker. Carried into a sent
-- row under the key a relay records with, so a reply job still waiting does not post it again. The
-- row names no conversation, so no sender ever picks it up. Copied before any ALTER, so no exclusive
-- lock is held while it runs.
INSERT INTO "messaging_outbound"
  ("id", "idempotencyKey", "kind", "body", "status", "providerHandle", "createdAt", "updatedAt")
SELECT 'relayed:' || r.id, 'team-chat-run:' || r.id, 'team', '', 'sent', '',
  r."teamChatMirroredAt", r."teamChatMirroredAt"
FROM runs AS r
WHERE r.trigger = 'bot_message' AND r.status IN ('completed', 'failed')
  AND r."teamChatMirroredAt" IS NOT NULL
ON CONFLICT ("idempotencyKey") DO NOTHING;
ALTER TABLE "messaging_outbound" DROP COLUMN "attempts", DROP COLUMN "nextAttemptAt";
ALTER TABLE "external_messages"
  DROP COLUMN "attempts",
  DROP COLUMN "nextAttemptAt",
  DROP COLUMN "lastError",
  DROP COLUMN "providerReplyHandle",
  DROP COLUMN "deliveredAt";
ALTER TABLE "runs" DROP COLUMN "teamChatMirroredAt";
-- Jobs only that release published; their work is the new delivery path's now.
DO $$ BEGIN
  IF to_regclass('graphile_worker._private_jobs') IS NOT NULL THEN
    DELETE FROM graphile_worker._private_jobs AS jobs
    USING graphile_worker._private_tasks AS tasks
    WHERE tasks.id = jobs.task_id
      AND tasks.identifier IN ('messaging.deliver', 'messaging.progress')
      AND jobs.locked_at IS NULL;
  END IF;
END $$;
