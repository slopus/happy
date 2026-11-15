-- Sole statement so CREATE INDEX CONCURRENTLY runs outside an implicit
-- transaction. A vault item's owner reads its uses by the item's id.
CREATE INDEX CONCURRENTLY "audit_events_targetType_targetId_createdAt_idx" ON "audit_events"("targetType", "targetId", "createdAt");
