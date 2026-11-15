-- deferred
-- Sole statement so DROP INDEX CONCURRENTLY runs outside an implicit transaction. Only the previous
-- release's mirror sweep read it.
DROP INDEX CONCURRENTLY IF EXISTS "runs_trigger_status_messagingMirroredAt_updatedAt_idx";
