-- A routine can start when something changes: `watch` holds what to check and
-- how often, `watchState` the last check's fingerprint and outcome. Both are
-- null for every existing routine, which keeps them on their current triggers.
ALTER TABLE "routines" ADD COLUMN IF NOT EXISTS "watch" JSONB;
ALTER TABLE "routines" ADD COLUMN IF NOT EXISTS "watchState" JSONB;
