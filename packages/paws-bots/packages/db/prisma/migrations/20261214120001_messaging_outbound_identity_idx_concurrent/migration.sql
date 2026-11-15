-- Sole statement so CREATE INDEX CONCURRENTLY runs outside an implicit transaction.
CREATE INDEX CONCURRENTLY IF NOT EXISTS "messaging_outbound_identityId_createdAt_idx" ON "messaging_outbound"("identityId", "createdAt");
