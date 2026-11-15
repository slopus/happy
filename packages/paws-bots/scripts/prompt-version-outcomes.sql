-- Outcome rates of runs finished in the last `days` days (default 7), by prompt version, newest first.
--   psql "$DATABASE_URL" -v days=7 -f scripts/prompt-version-outcomes.sql
-- Reads only run statuses and message block kinds, which stay plain when content is encrypted.
\if :{?days}
\else
\set days 7
\endif

WITH recent AS (
  SELECT id, status, "promptVersion", "completedAt"
  FROM runs
  WHERE "promptVersion" IS NOT NULL
    AND status IN ('completed', 'failed', 'cancelled')
    AND "completedAt" > now() - make_interval(days => :days)
),
blocks AS (
  SELECT
    m."runId",
    bool_or(b ->> 'kind' = 'steps') AS used_tools,
    -- Any visible block (text, card, file, ...) is a reply; tool steps, status
    -- blocks and mid-turn progress notes are not.
    bool_or(
      b ->> 'kind' NOT IN ('steps', 'progress', 'meta', 'delivery')
      AND coalesce(m."clientNonce", '') NOT LIKE 'user-progress:%'
    ) AS replied,
    count(*) FILTER (WHERE b ->> 'kind' = 'ask') AS asks
  FROM messages m
  JOIN recent r ON r.id = m."runId"
  CROSS JOIN LATERAL jsonb_array_elements(
    CASE WHEN jsonb_typeof(m.blocks) = 'array' THEN m.blocks ELSE '[]'::jsonb END
  ) b
  WHERE m.role = 'bot'
  GROUP BY m."runId"
)
SELECT
  r."promptVersion" AS version,
  min(r."completedAt")::date AS first_seen,
  count(*) AS runs,
  round(100.0 * avg((r.status = 'failed')::int), 1) AS failed_pct,
  round(100.0 * avg((r.status = 'cancelled')::int), 1) AS cancelled_pct,
  -- Finished after tool work without anything visible to the user.
  round(
    100.0 * avg((r.status = 'completed' AND coalesce(b.used_tools, false)
      AND NOT coalesce(b.replied, false))::int),
    1
  ) AS tools_no_reply_pct,
  -- Approval and question cards, plus the cards recording a bot's own settings change:
  -- encrypted blocks keep only kind and status, which cannot tell them apart.
  round(100.0 * avg((coalesce(b.asks, 0) > 0)::int), 1) AS asked_pct,
  round(avg(coalesce(b.asks, 0)), 2) AS asks_per_run
FROM recent r
LEFT JOIN blocks b ON b."runId" = r.id
GROUP BY r."promptVersion"
ORDER BY first_seen DESC, runs DESC;
