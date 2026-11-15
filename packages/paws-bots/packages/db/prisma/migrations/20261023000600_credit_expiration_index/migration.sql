-- Expiration scans only outstanding monthly grants, rather than all historical lots.
CREATE INDEX "model_credit_lots_due_idx" ON "model_credit_lots" ("expiresAt", "organizationId")
WHERE "availableMicros" > 0 AND "expiresAt" IS NOT NULL;

-- Keep funding provenance when the previous API settles an already classified call.
ALTER TABLE "model_credit_entries" ADD COLUMN "fundedMicros" BIGINT;
UPDATE "model_credit_entries" e SET "fundedMicros"=(
  SELECT COALESCE(SUM((item->>'amountMicros')::bigint),0)
  FROM jsonb_array_elements(e.allocations) item
) WHERE jsonb_typeof(e.allocations)='array';
CREATE INDEX "model_credit_entries_unallocated_idx" ON "model_credit_entries" ("organizationId", "createdAt", id)
WHERE allocations IS NULL AND "amountMicros" < 0;
CREATE INDEX "model_credit_entries_released_idx" ON "model_credit_entries" ("organizationId")
WHERE "fundedMicros" > GREATEST(-"amountMicros",0);
