-- Replies the previous release left for its recovery scan: chat runs that ended in the last day
-- without their reply recorded, and delegated replies to a team-chat thread not yet relayed. The
-- run-end trigger (20261214120000_run_reply_delivery_job) only covers runs that end from now on.
-- Each run's reply job records and sends its reply once; a job already queued is kept. The jobs
-- wait until the previous release has stopped. A reply its recovery delivered meanwhile is not
-- sent again: 1:1 and group replies reuse that release's outbound keys, and a delegated reply
-- checks the run's relay marker.
-- Fresh installations create Graphile's schema after application migrations, and have no runs.
DO $$ BEGIN
  IF to_regnamespace('graphile_worker') IS NULL THEN
    RETURN;
  END IF;
  PERFORM graphile_worker.add_job(
    'messaging.reply',
    json_build_object('runId', r.id),
    run_at => now() + interval '10 minutes',
    job_key => 'messaging.reply:' || r.id,
    job_key_mode => 'unsafe_dedupe'
  )
  FROM runs AS r
  WHERE r.trigger = 'messaging' AND r.status = 'completed' AND r."messagingMirroredAt" IS NULL
    AND r."completedAt" > (now() AT TIME ZONE 'UTC') - interval '1 day';
  -- The previous release relayed a delegated reply from the conversation's own thread once.
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = current_schema() AND table_name = 'runs'
      AND column_name = 'teamChatMirroredAt'
  ) THEN
    PERFORM graphile_worker.add_job(
      'messaging.reply',
      json_build_object('runId', r.id),
      run_at => now() + interval '10 minutes',
      job_key => 'messaging.reply:' || r.id,
      job_key_mode => 'unsafe_dedupe'
    )
    FROM runs AS r
    WHERE r.trigger = 'bot_message' AND r.status IN ('completed', 'failed')
      AND r."teamChatMirroredAt" IS NULL
      AND r."completedAt" > (now() AT TIME ZONE 'UTC') - interval '1 day'
      AND EXISTS (
        SELECT 1 FROM threads AS t
        JOIN external_conversations AS c ON c.id = t."externalConversationId"
        WHERE t.id = r."threadId" AND c."botId" = r."botId"
      );
  END IF;
END $$;
