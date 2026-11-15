-- Repair scans purchase projections without traversing per-call history.
CREATE INDEX "model_credit_entries_purchases_idx"
ON model_credit_entries ("organizationId", "createdAt", id) WHERE source LIKE 'purchase:%';

-- Match the spend order while excluding exhausted historical grants.
CREATE INDEX "model_credit_lots_available_idx"
ON model_credit_lots ("organizationId", "expiresAt", "createdAt", id) WHERE "availableMicros" > 0;

-- The outstanding-expiry index covers every global expiration scan.
DROP INDEX "model_credit_lots_expiresAt_idx";
