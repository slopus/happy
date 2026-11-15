-- Sole statement so CREATE INDEX CONCURRENTLY runs outside an implicit
-- transaction. The hourly balance check sums each organization's journal.
CREATE INDEX CONCURRENTLY "billing_audit_events_organizationId_amountMicros_idx" ON "billing_audit_events" ("organizationId", "amountMicros");
