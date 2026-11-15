-- Persist takeover deadlines so API and worker replicas enforce the same lease.
ALTER TABLE "computers" ADD COLUMN "controlLeaseExpiresAt" TIMESTAMP(3);

-- Existing interactive leases had no authoritative deadline. Expire them on deploy
-- so the reconciler can revoke their provider streams instead of extending them.
UPDATE "computers"
SET
    "controlLeaseExpiresAt" = CASE
        WHEN "controlLeaseId" IS NOT NULL THEN CURRENT_TIMESTAMP
        ELSE NULL
    END,
    "controlHolder" = CASE
        WHEN "controlLeaseId" IS NULL THEN 'none'
        ELSE "controlHolder"
    END
WHERE "controlHolder" = 'user';
