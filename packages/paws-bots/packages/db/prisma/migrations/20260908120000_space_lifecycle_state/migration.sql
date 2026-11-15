ALTER TABLE "spaces"
  ADD COLUMN "deletingAt" TIMESTAMP(3),
  ADD COLUMN "deletionClaimId" TEXT;
