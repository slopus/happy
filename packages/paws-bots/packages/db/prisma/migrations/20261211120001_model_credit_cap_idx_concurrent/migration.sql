-- Sole statement so the existing journal remains writable during index creation.
CREATE INDEX CONCURRENTLY "billing_audit_events_user_credit_amount_idx"
 ON billing_audit_events ("userId", "amountMicros")
 WHERE "callId" IS NOT NULL AND source LIKE 'credit:%';
