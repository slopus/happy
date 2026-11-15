CREATE INDEX CONCURRENTLY "runs_trigger_status_messagingMirroredAt_updatedAt_idx"
ON "runs"("trigger", "status", "messagingMirroredAt", "updatedAt");
