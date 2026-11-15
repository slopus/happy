-- Sole statement so CREATE INDEX CONCURRENTLY runs outside an implicit transaction.
CREATE INDEX CONCURRENTLY IF NOT EXISTS "messaging_outbound_status_updatedAt_idx" ON "messaging_outbound"("status", "updatedAt");
