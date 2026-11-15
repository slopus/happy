CREATE TABLE "home_deletion_notices" (
  "computerId" TEXT NOT NULL PRIMARY KEY REFERENCES "computers"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "claimId" TEXT,
  "claimExpiresAt" TIMESTAMP(3),
  "warnedAt" TIMESTAMP(3),
  "deleteAfter" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
ALTER TABLE "home_deletion_notices" ENABLE ROW LEVEL SECURITY;
CREATE POLICY home_deletion_notices_system ON "home_deletion_notices"
  USING ((SELECT app_rls_bypass()));
