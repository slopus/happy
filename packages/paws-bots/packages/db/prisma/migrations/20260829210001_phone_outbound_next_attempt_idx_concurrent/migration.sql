-- Sole statement so CREATE INDEX CONCURRENTLY runs outside an implicit
-- transaction (see prior concurrent index migrations).
CREATE INDEX CONCURRENTLY IF NOT EXISTS "phone_outbound_status_nextAttemptAt_idx" ON "phone_outbound"("status", "nextAttemptAt");
