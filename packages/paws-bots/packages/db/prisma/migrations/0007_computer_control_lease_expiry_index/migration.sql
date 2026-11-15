-- Build the reconciler index without blocking writes to active computers.
CREATE INDEX CONCURRENTLY "computers_controlLeaseExpiresAt_id_idx"
ON "computers"("controlLeaseExpiresAt", "id")
WHERE "controlLeaseId" IS NOT NULL;
